import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { test } from 'vitest'

const root = path.resolve(import.meta.dirname, '..')
const probePath = path.join(root, 'scripts/ci/native-dependency-probe.mjs')
const conoutPath = path.join(root, 'node_modules/node-pty/lib/windowsConoutConnection.js')

interface SyntheticPtyOptions {
  agent?: object
  exitCode?: number
  output?: string
  emitExit?: boolean
}

function syntheticPty(options: SyntheticPtyOptions = {}) {
  const dataListeners = new Set<(data: string) => void>()
  const exitListeners = new Set<(event: { exitCode: number }) => void>()
  let killCount = 0

  const child = {
    ...(options.agent === undefined ? {} : { _agent: options.agent }),
    onData(listener: (data: string) => void) {
      dataListeners.add(listener)

      return { dispose: () => dataListeners.delete(listener) }
    },
    onExit(listener: (event: { exitCode: number }) => void) {
      exitListeners.add(listener)

      return { dispose: () => exitListeners.delete(listener) }
    },
    kill() { killCount += 1 },
  }

  return {
    pty: {
      spawn() {
        queueMicrotask(() => {
          if (options.output !== undefined) {
            for (const listener of dataListeners) {
              listener(options.output)
            }
          }

          if (options.emitExit !== false) {
            for (const listener of exitListeners) {
              listener({ exitCode: options.exitCode ?? 0 })
            }
          }
        })

        return child
      },
    },
    listenerCount: () => dataListeners.size + exitListeners.size,
    killCount: () => killCount,
  }
}

async function runLifecycleSubprocess() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'native-probe-lifecycle-'))

  const pipeName = process.platform === 'win32'
    ? `\\\\.\\pipe\\hermes-conout-${process.pid}-${Date.now()}`
    : path.join(temporary, 'conout.sock')

  const childScript = `
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import net from 'node:net'
    import { createRequire } from 'node:module'
    const { ptyRoundTrip } = await import(${JSON.stringify(pathToFileURL(probePath).href)})
    const require = createRequire(${JSON.stringify(path.join(root, 'package.json'))})
    const { ConoutConnection } = require(${JSON.stringify(conoutPath)})
    const pipeName = ${JSON.stringify(pipeName)}
    const sockets = new Set()
    const server = net.createServer(socket => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(pipeName, resolve)
    })
    const connection = new ConoutConnection(pipeName, false)
    let readyTimer
    let readyResolve
    const ready = new Promise((resolve, reject) => {
      readyResolve = resolve
      readyTimer = setTimeout(() => reject(new Error('Conout worker did not become ready')), 2_000)
    })
    const readySubscription = connection.onReady(() => readyResolve())
    await ready
    clearTimeout(readyTimer)
    readySubscription.dispose()
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))

    const dataListeners = new Set()
    const exitListeners = new Set()
    const child = {
      _agent: { _conoutSocketWorker: connection },
      onData(listener) {
        dataListeners.add(listener)
        return { dispose: () => dataListeners.delete(listener) }
      },
      onExit(listener) {
        exitListeners.add(listener)
        return { dispose: () => exitListeners.delete(listener) }
      },
      kill() { throw new Error('kill must not run after natural exit') },
    }
    const pty = { spawn() {
      queueMicrotask(() => {
        for (const listener of dataListeners) listener('HERMES_NATIVE_PTY_OK\\n')
        for (const listener of exitListeners) listener({ exitCode: 0 })
      })
      return child
    } }
    const result = await ptyRoundTrip(pty, ${JSON.stringify(temporary)}, 'synthetic Conout lifecycle', 2_000)
    assert.equal(result.exitCode, 0)
    console.log('LISTENER_COUNT=' + (dataListeners.size + exitListeners.size))
    console.log('WORKER_THREAD_ID=' + connection._worker.threadId)
    console.log('PTY_ROUND_TRIP_COMPLETE')
    fs.rmSync(${JSON.stringify(temporary)}, { recursive: true, force: true })
  `

  const env: NodeJS.ProcessEnv = {}

  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'WINDIR']) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key]
    }
  }

  env.HOME = temporary
  env.HERMES_HOME = path.join(temporary, '.hermes')

  try {
    return await new Promise<{ code: number | null, stdout: string, stderr: string, timedOut: boolean }>((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', childScript], {
        cwd: root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let timedOut = false
      child.stdout.setEncoding('utf8').on('data', (data) => { stdout += data })
      child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data })

      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
      }, 4_000)

      child.once('close', (code) => {
        clearTimeout(timer)
        resolve({ code, stdout, stderr, timedOut })
      })
    })
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

test('PTY round-trip releases the real node-pty Conout worker and exits naturally', async () => {
  const result = await runLifecycleSubprocess()
  assert.equal(result.timedOut, false,
    `Subprocess completed the PTY marker but retained its Conout worker:\n${result.stdout}${result.stderr}`)
  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /PTY_ROUND_TRIP_COMPLETE/)
  assert.match(result.stdout, /LISTENER_COUNT=0/)
  assert.match(result.stdout, /WORKER_THREAD_ID=-1/)
})

test('PTY round-trip rejects nonzero exit and missing marker, then removes listeners', async () => {
  const { ptyRoundTrip } = await import(pathToFileURL(probePath).href)

  for (const fixture of [
    { options: { exitCode: 7, output: 'HERMES_NATIVE_PTY_OK\n' }, message: /7 !== 0/ },
    { options: { exitCode: 0, output: 'different output\n' }, message: /falsy value|HERMES_NATIVE_PTY_OK/ },
  ]) {
    const synthetic = syntheticPty(fixture.options)
    await assert.rejects(ptyRoundTrip(synthetic.pty, root, 'fail-closed fixture', 100), fixture.message)
    assert.equal(synthetic.listenerCount(), 0)
    assert.equal(synthetic.killCount(), 0)
  }
})

test('PTY round-trip timeout kills only its child and removes listeners', async () => {
  const { ptyRoundTrip } = await import(pathToFileURL(probePath).href)
  const synthetic = syntheticPty({ emitExit: false })
  await assert.rejects(ptyRoundTrip(synthetic.pty, root, 'timeout fixture', 20), /PTY timeout/)
  assert.equal(synthetic.killCount(), 1)
  assert.equal(synthetic.listenerCount(), 0)
})

test('PTY round-trip fails closed when node-pty Windows resource internals change', async () => {
  const { ptyRoundTrip } = await import(pathToFileURL(probePath).href)
  const synthetic = syntheticPty({ agent: {}, output: 'HERMES_NATIVE_PTY_OK\n' })
  await assert.rejects(ptyRoundTrip(synthetic.pty, root, 'shape fixture', 100),
    /ConoutConnection disposal is unavailable/)
  assert.equal(synthetic.killCount(), 0)
  assert.equal(synthetic.listenerCount(), 0)
})
