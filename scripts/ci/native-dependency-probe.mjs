#!/usr/bin/env node
// Cross-platform dependency proof only; this never starts Hermes or a GUI.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const rootRequire = createRequire(path.join(root, 'package.json'))
const scriptPath = fileURLToPath(import.meta.url)
const functionalChecks = [
  'tar direct consumers synthetic archive round-trip',
  'cacache archive put/get round-trip',
  'node-pre-gyp local synthetic install API',
  'root and Vite Lightning CSS native transforms',
  'esbuild native lifecycle and transform',
  'Rolldown native isolated bundle',
  'Rolldown wasm isolated bundle',
  'root get-windows import without enumeration',
  'actual host native staging contracts',
  'source native node-pty load and child I/O',
  'staged native node-pty load and child I/O',
]
const requiredChecks = {
  runtime: ['runtime identity and provenance'],
  functional: ['runtime identity and provenance', ...functionalChecks],
  ci: ['runtime identity and provenance', 'canonical npm ci', 'full npm dependency tree',
    'root JavaScript contract suite', 'web build', 'desktop build and native staging', ...functionalChecks],
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function portable(file) {
  return file.replaceAll('\\', '/')
}

export function rolldownBindings(keys) {
  return keys.map(portable).filter((file) =>
    file.includes('@rolldown/binding-') || file.includes('@napi-rs/wasm-runtime'))
}

export function npmInvocation(args, platform = process.platform) {
  // npm.cmd requires a shell on Windows. Only fixed, non-shell arguments
  // are accepted; no PR metadata or paths are interpolated into that shell.
  for (const argument of args) assert.match(argument, /^[a-zA-Z0-9_./-]+$/, 'Unsafe npm argument')
  return { command: platform === 'win32' ? 'npm.cmd' : 'npm', args,
    options: { shell: platform === 'win32' } }
}

function captureNpm(args) {
  const invocation = npmInvocation(args)
  return capture(invocation.command, invocation.args, invocation.options)
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 20 * 60_000,
    ...options,
  })
  if (result.error) throw result.error
  return result
}

function cleanChildEnv(extra = {}) {
  const env = {}
  for (const key of [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC',
    'WINDIR', 'HOME', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL',
  ]) if (process.env[key] !== undefined) env[key] = process.env[key]
  return { ...env, ...extra }
}

export function validateReceipt(receipt) {
  assert.equal(receipt?.result, 'pass', 'Receipt result must be pass')
  assert.ok(receipt?.checks?.length > 0 && receipt.checks.every((check) => check.result === 'pass'),
    'Receipt needs complete passing checks')
  assert.match(receipt?.sourceSha ?? '', /^[0-9a-f]{40}$/)
  assert.match(receipt?.lockSha256 ?? '', /^[0-9a-f]{64}$/)
  assert.ok(receipt?.runtime?.platform && receipt?.runtime?.arch && receipt?.runtime?.node && receipt?.runtime?.npm)
  assert.deepEqual(receipt.checks.map((check) => check.name), requiredChecks[receipt.mode],
    'Receipt must include every required check')
  assert.deepEqual(receipt.markers, receipt.checks.map((check) => check.name))
  return receipt
}

function parseArguments(argv) {
  const [mode, ...rest] = argv
  assert.ok(['runtime', 'functional', 'ci', '_rolldown'].includes(mode), `Unknown mode: ${mode}`)
  const options = {}
  for (let index = 0; index < rest.length; index += 2) {
    assert.match(rest[index] ?? '', /^--[a-z-]+$/)
    assert.notEqual(rest[index + 1], undefined, `Missing value for ${rest[index]}`)
    options[rest[index].slice(2)] = rest[index + 1]
  }
  return { mode, options }
}

function walkFiles(directory, suffix) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? walkFiles(file, suffix) : entry.name.endsWith(suffix) ? [file] : []
  })
}

// node-pty 1.1.0 does not dispose this worker after a natural ConPTY exit.
// Never call child.kill() here: only release the connection owned by this PTY
// and wait for its actual worker exit so PID reuse cannot affect other processes.
async function disposeOwnedConoutWorker(child, label) {
  const agent = child?._agent
  if (!agent) {
    assert.ok(process.platform !== 'win32', `${label}: node-pty Windows agent internals are unavailable`)
    return
  }

  const connection = agent._conoutSocketWorker
  assert.ok(connection && typeof connection.dispose === 'function',
    `${label}: node-pty ConoutConnection disposal is unavailable`)
  const worker = connection._worker
  assert.ok(worker && typeof worker.once === 'function' && typeof worker.off === 'function',
    `${label}: node-pty ConoutConnection worker is unavailable`)
  if (worker.threadId === -1) return

  await new Promise((resolve, reject) => {
    let timer
    const finish = (operation, value) => {
      clearTimeout(timer)
      worker.off('error', onError)
      worker.off('exit', onExit)
      operation(value)
    }
    const onError = (error) => finish(reject, error)
    const onExit = () => finish(resolve)
    worker.once('error', onError)
    worker.once('exit', onExit)
    timer = setTimeout(() => onError(new Error(`${label}: node-pty ConoutConnection worker exit timeout`)), 3_000)
    try { connection.dispose() } catch (error) { onError(error) }
  })
  assert.equal(worker.threadId, -1, `${label}: node-pty ConoutConnection worker is still active`)
}

export async function ptyRoundTrip(pty, cwd, label, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32'
    const executable = windows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'
    const args = windows ? ['/d', '/s', '/c', 'echo HERMES_NATIVE_PTY_OK'] : ['-c', "printf 'HERMES_NATIVE_PTY_OK\\n'"]
    const env = windows
      ? cleanChildEnv({ HOME: cwd, TEMP: cwd, TMP: cwd })
      : { PATH: '/usr/bin:/bin', HOME: cwd, TMPDIR: cwd, TERM: 'xterm' }
    let output = ''
    let settled = false
    let dataSubscription
    let exitSubscription
    const child = pty.spawn(executable, args, { name: 'xterm', cols: 80, rows: 24, cwd, env })
    const removeListeners = () => {
      dataSubscription?.dispose()
      exitSubscription?.dispose()
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      removeListeners()
      const timeoutError = new Error(`${label}: PTY timeout`)
      try { child.kill() } catch (error) {
        reject(new AggregateError([timeoutError, error], `${timeoutError.message}; child cleanup failed`))
        return
      }
      reject(timeoutError)
    }, timeoutMs)
    dataSubscription = child.onData((chunk) => { output += chunk })
    exitSubscription = child.onExit(({ exitCode }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void (async () => {
        let failure
        try {
          assert.equal(exitCode, 0)
          assert.ok(output.replaceAll('\r', '').includes('HERMES_NATIVE_PTY_OK'))
        } catch (error) { failure = error }
        try { await disposeOwnedConoutWorker(child, label) } catch (error) {
          failure = failure
            ? new AggregateError([failure, error],
                `${String(failure?.message ?? failure)}; resource cleanup failed: ${String(error?.message ?? error)}`)
            : error
        }
        removeListeners()
        if (failure) reject(failure)
        else resolve({ exitCode, output: output.trim() })
      })()
    })
  })
}

async function rolldownWorker(bindingMode) {
  if (bindingMode === 'wasm') process.env.NAPI_RS_FORCE_WASI = 'error'
  const { rolldown } = await import(pathToFileURL(rootRequire.resolve('rolldown')).href)
  const bundle = await rolldown({
    input: 'fixture',
    plugins: [{
      name: 'native-dependency-fixture',
      resolveId(id) { return id === 'fixture' ? '\0fixture' : null },
      load(id) { return id === '\0fixture' ? 'export const answer = 6 * 7' : null },
    }],
  })
  try {
    const generated = await bundle.generate({ format: 'es', minify: true })
    const chunk = generated.output.find((item) => item.type === 'chunk')
    assert.ok(chunk)
    const evaluated = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`)
    assert.equal(evaluated.answer, 42)
    const bindings = rolldownBindings(Object.keys(rootRequire.cache))
    if (bindingMode === 'wasm') {
      assert.ok(bindings.some((file) => file.includes('binding-wasm32-wasi')))
      assert.ok(bindings.some((file) => file.includes('@napi-rs/wasm-runtime')))
      assert.ok(!bindings.some((file) => file.endsWith('.node')), 'Forced WASM silently loaded native code')
    } else {
      assert.ok(bindings.some((file) => file.endsWith('.node')), 'Native Rolldown binding was not loaded')
    }
    process.stdout.write(`ROLLDOWN_RESULT=${JSON.stringify({ bindingMode, answer: 42,
      code: chunk.code, bindings: bindings.map(portable) })}\n`)
  } finally {
    await bundle.close()
  }
}

export async function installSyntheticArchive(fixture) {
  // node-pre-gyp slices file:// instead of decoding a file URL. Use its
  // supported mirror for this loopback-only archive, never weaken HTTPS/TLS.
  const archive = fs.readFileSync(path.join(fixture, 'payload-9.tar.gz'))
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/get-windows/package.json'), 'utf8'))
  const mirrorKey = `npm_config_${packageJson.binary.module_name.replace('-', '_')}_binary_host_mirror`
  const previousMirror = process.env[mirrorKey]
  let requests = 0
  let timer
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/payload-9.tar.gz') {
      response.writeHead(404).end()
      return
    }
    requests += 1
    response.writeHead(200, { 'content-type': 'application/gzip', 'content-length': archive.length }).end(archive)
  })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const host = `http://127.0.0.1:${server.address().port}/`
    packageJson.binary = { ...packageJson.binary, remote_path: '',
      package_name: 'payload-{napi_build_version}.tar.gz',
      module_path: path.join(fixture, 'pre-gyp-{napi_build_version}') }
    process.env[mirrorKey] = host
    const gyp = { package_json: packageJson, opts: { 'fallback-to-build': false }, todo: [] }
    const evaluated = rootRequire('@mapbox/node-pre-gyp/lib/util/versioning.js').evaluate(packageJson, gyp.opts, 9)
    assert.equal(evaluated.hosted_tarball, `${host}payload-9.tar.gz`)
    const install = rootRequire('@mapbox/node-pre-gyp/lib/install.js')
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Local archive install timed out')), 10_000)
      install(gyp, ['napi_build_version=9'], (error) => error ? reject(error) : resolve())
    })
    // This dependency calls back on HTTP body end, before its tar stream
    // closes. Prove the final bytes, not the early callback acknowledgement.
    const expected = fs.readFileSync(path.join(fixture, 'source/package/node-get-windows.node'))
    const deadline = Date.now() + 2_000
    let installed
    do {
      try { installed = fs.readFileSync(evaluated.module) } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      if (installed?.equals(expected)) break
      await delay(10)
    } while (Date.now() < deadline)
    assert.deepEqual(installed, expected)
    assert.deepEqual(gyp.todo, [])
    assert.equal(requests, 1)
    return { fallbackToBuild: false, transport: 'loopback-http-fixture', requests,
      scope: 'Synthetic archive; NOT a get-windows native binary' }
  } finally {
    clearTimeout(timer)
    if (previousMirror === undefined) delete process.env[mirrorKey]
    else process.env[mirrorKey] = previousMirror
    if (server.listening) {
      server.closeAllConnections()
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  }
}

async function runFunctional(check, fixture) {
  const stageModule = await import(pathToFileURL(path.join(root, 'apps/desktop/scripts/stage-native-deps.mjs')).href)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const locked = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages

  await check('tar direct consumers synthetic archive round-trip', async () => {
    const content = Buffer.from('Synthetic archive fixture; NOT an actual native binary.\n'.repeat(40))
    const source = path.join(fixture, 'source', 'package')
    fs.mkdirSync(source, { recursive: true })
    fs.writeFileSync(path.join(source, 'node-get-windows.node'), content)
    const archive = path.join(fixture, 'payload-9.tar.gz')
    await rootRequire('tar').create({ file: archive, gzip: true, cwd: path.dirname(source) }, ['package'])
    const owners = Object.entries(locked).filter(([, pkg]) => pkg.dependencies?.tar)
    assert.ok(owners.length > 0)
    const resolutions = []
    for (const [location, owner] of owners) {
      const ownerRequire = createRequire(path.join(root, location, 'package.json'))
      const version = ownerRequire('tar/package.json').version
      assert.equal(version, manifest.overrides.tar)
      const destination = fs.mkdtempSync(path.join(fixture, 'tar-'))
      let entries = 0
      await ownerRequire('tar').extract({ file: archive, cwd: destination, strip: 1,
        onentry: () => { entries += 1 } })
      assert.deepEqual(fs.readFileSync(path.join(destination, 'node-get-windows.node')), content)
      assert.ok(entries > 0)
      resolutions.push({ owner: portable(location), ownerVersion: owner.version,
        requested: owner.dependencies.tar, resolved: portable(ownerRequire.resolve('tar/package.json')), version, entries })
    }
    return { archiveLabel: 'Synthetic archive; NOT an actual native binary', ownerCount: owners.length, resolutions }
  })

  await check('cacache archive put/get round-trip', async () => {
    const archive = fs.readFileSync(path.join(fixture, 'payload-9.tar.gz'))
    const cache = path.join(fixture, 'cacache')
    const integrity = await rootRequire('cacache').put(cache, 'synthetic-archive', archive)
    assert.deepEqual((await rootRequire('cacache').get(cache, 'synthetic-archive')).data, archive)
    assert.deepEqual(await rootRequire('cacache').get.byDigest(cache, integrity), archive)
    return { bytes: archive.length, integrity: String(integrity) }
  })

  await check('node-pre-gyp local synthetic install API', () => installSyntheticArchive(fixture))

  await check('root and Vite Lightning CSS native transforms', () => {
    const transforms = []
    for (const owner of ['', 'node_modules/vite']) {
      const ownerRequire = createRequire(path.join(root, owner, 'package.json'))
      const entry = ownerRequire.resolve('lightningcss')
      const css = ownerRequire('lightningcss').transform({ filename: 'fixture.css',
        code: Buffer.from('.probe { color: #ff0000; margin: 0px; }'), minify: true }).code.toString()
      assert.ok(css.includes('.probe') && css.includes('color:red') && css.includes('margin:0'))
      transforms.push({ owner: owner || 'root', entry: portable(entry), css })
    }
    const bindings = Object.keys(rootRequire.cache).filter((file) => file.includes('lightningcss') && file.endsWith('.node'))
    assert.ok(bindings.length > 0)
    for (const binding of bindings) assert.equal(stageModule.classifyNativeBinary(binding), process.platform)
    return { transforms, bindings: bindings.map(portable) }
  })

  await check('esbuild native lifecycle and transform', () => {
    const output = rootRequire('esbuild').transformSync('const answer = 6 * 7', { minify: true }).code
    assert.ok(output.includes('42'))
    return { output, version: rootRequire('esbuild').version }
  })

  for (const bindingMode of ['native', 'wasm']) await check(`Rolldown ${bindingMode} isolated bundle`, () => {
    const result = capture(process.execPath, [scriptPath, '_rolldown', '--binding-mode', bindingMode], {
      env: cleanChildEnv(bindingMode === 'wasm' ? { NAPI_RS_FORCE_WASI: 'error' } : {}), timeout: 45_000,
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const marker = result.stdout.split(/\r?\n/).find((line) => line.startsWith('ROLLDOWN_RESULT='))
    assert.ok(marker)
    return JSON.parse(marker.slice('ROLLDOWN_RESULT='.length))
  })

  await check('root get-windows import without enumeration', async () => {
    const module = await import(pathToFileURL(rootRequire.resolve('get-windows')).href)
    assert.ok(typeof module.activeWindow === 'function' && typeof module.openWindows === 'function')
    return { entry: portable(rootRequire.resolve('get-windows')), exports: Object.keys(module).sort() }
  })

  const stagedPty = path.join(root, 'apps/desktop/dist/node_modules/node-pty')
  const stagedWindows = path.join(root, 'apps/desktop/dist/node_modules/get-windows')
  await check('actual host native staging contracts', async () => {
    assert.ok(fs.existsSync(stagedPty) && fs.existsSync(stagedWindows), 'Desktop build did not stage native dependencies')
    const ptyBinaries = walkFiles(stagedPty, '.node')
    assert.ok(ptyBinaries.length > 0)
    for (const binary of ptyBinaries) assert.equal(stageModule.classifyNativeBinary(binary), process.platform)
    const windowsBinaries = walkFiles(stagedWindows, '.node')
    if (process.platform === 'win32') {
      assert.ok(windowsBinaries.length > 0)
      for (const binary of windowsBinaries) {
        assert.equal(stageModule.classifyNativeBinary(binary), 'win32')
        createRequire(path.join(stagedWindows, 'probe.cjs'))(binary)
      }
    } else if (process.platform === 'darwin') {
      assert.ok(fs.existsSync(path.join(stagedWindows, 'main')))
    } else {
      assert.deepEqual(windowsBinaries, [])
    }
    const stagedModule = await import(`${pathToFileURL(path.join(stagedWindows, 'index.js')).href}?probe=1`)
    assert.ok(typeof stagedModule.activeWindow === 'function')
    return { platform: process.platform, arch: process.arch,
      nodePtyBinaries: ptyBinaries.map(portable), getWindowsBinaries: windowsBinaries.map(portable) }
  })

  await check('source native node-pty load and child I/O', () =>
    ptyRoundTrip(rootRequire('node-pty'), fixture, 'source node-pty'))
  await check('staged native node-pty load and child I/O', () => {
    const stagedRequire = createRequire(path.join(stagedPty, 'probe.cjs'))
    return ptyRoundTrip(stagedRequire('./'), fixture, 'staged node-pty')
  })
}

export async function runProbe(mode, options) {
  const output = options.output && path.resolve(options.output)
  assert.ok(output, '--output is required')
  const receipt = { schemaVersion: 1, mode, result: 'fail', sourceSha: '', lockSha256: '',
    runtime: {}, checks: [], markers: [], startedAt: new Date().toISOString() }
  const log = []
  const check = async (name, operation) => {
    const start = Date.now()
    try {
      const evidence = await operation()
      receipt.checks.push({ name, result: 'pass', elapsedMs: Date.now() - start, evidence })
      log.push(`PASS ${name} ${JSON.stringify(evidence ?? {})}`)
      console.log(`PASS ${name}`)
      return evidence
    } catch (error) {
      receipt.checks.push({ name, result: 'fail', elapsedMs: Date.now() - start, error: String(error?.stack ?? error) })
      log.push(`FAIL ${name}\n${String(error?.stack ?? error)}`)
      console.error(`FAIL ${name}:`, error)
      throw error
    }
  }
  try {
    await check('runtime identity and provenance', () => {
      const git = capture('git', ['rev-parse', 'HEAD'])
      const npm = captureNpm(['--version'])
      assert.equal(git.status, 0, git.stderr)
      assert.equal(npm.status, 0, npm.stderr)
      receipt.sourceSha = git.stdout.trim()
      receipt.lockSha256 = sha256(fs.readFileSync(path.join(root, 'package-lock.json')))
      receipt.runtime = { platform: process.platform, arch: process.arch,
        node: process.versions.node, npm: npm.stdout.trim() }
      if (options['expected-platform']) assert.equal(process.platform, options['expected-platform'])
      if (options['expected-arch']) assert.equal(process.arch, options['expected-arch'])
      if (options['expected-node']) assert.equal(process.versions.node, options['expected-node'])
      if (options['expected-npm']) assert.equal(receipt.runtime.npm, options['expected-npm'])
      if (options['expected-sha']) assert.equal(receipt.sourceSha, options['expected-sha'])
      return { ...receipt.runtime, sourceSha: receipt.sourceSha, lockSha256: receipt.lockSha256 }
    })
    if (mode === 'ci') {
      for (const [name, args] of [
        ['canonical npm ci', ['ci']],
        ['full npm dependency tree', ['ls', '--all']],
        ['root JavaScript contract suite', ['run', 'check', '--workspace', 'tests-js']],
        ['web build', ['run', 'build', '--workspace', 'web']],
        ['desktop build and native staging', ['run', 'build', '--workspace', 'apps/desktop']],
      ]) await check(name, () => {
        const result = captureNpm(args)
        const combined = `${result.stdout}${result.stderr}`
        log.push(`$ npm ${args.join(' ')}\n${combined}`)
        assert.equal(result.status, 0, combined)
        return { exitCode: result.status, outputBytes: Buffer.byteLength(combined),
          outputSha256: sha256(combined), outputMarkers: combined.split(/\r?\n/).filter(Boolean).slice(-3) }
      })
    }
    if (mode === 'ci' || mode === 'functional') {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-native-proof-'))
      try { await runFunctional(check, fixture) } finally { fs.rmSync(fixture, { recursive: true, force: true }) }
    }
    receipt.result = 'pass'
    receipt.completedAt = new Date().toISOString()
    receipt.markers = receipt.checks.map((item) => item.name)
    validateReceipt(receipt)
  } catch (error) {
    receipt.result = 'fail'
    receipt.completedAt = new Date().toISOString()
    receipt.markers = receipt.checks.filter((item) => item.result === 'pass').map((item) => item.name)
    receipt.error = String(error?.stack ?? error)
  }
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const logPath = output.replace(/\.json$/i, '') + '.log'
  fs.writeFileSync(logPath, log.join('\n'))
  receipt.log = portable(logPath)
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n')
  if (receipt.result !== 'pass') throw new Error(receipt.error)
  return receipt
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { mode, options } = parseArguments(process.argv.slice(2))
  if (mode === '_rolldown') await rolldownWorker(options['binding-mode'])
  else await runProbe(mode, options)
}
