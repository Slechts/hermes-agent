import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  buildElectronLaunchOptions,
  buildLaunchEnv,
  buildQaReceipt,
  compareReleaseMetadata,
  resolvePackagedLayout,
  startGatewayMock,
  summarizePlaywrightReport,
} from './support.mjs'


const SUPPORT_PATH = fileURLToPath(new URL('./support.mjs', import.meta.url))


function validRuntimeReceipt() {
  return {
    electronVersion: '42.11.2',
    appVersion: '0.17.0',
    isPackaged: true,
    platform: 'linux',
    arch: 'x64',
    windowVisible: true,
    domUseful: true,
    errorBoundaryAbsent: true,
    disableGpu: true,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    bypassArguments: [],
    bootReady: true,
    composerEnabled: true,
    overlayAbsent: true,
    gatewayMock: {
      marker: 'hermes-native-qa-gateway-v1',
      scope: 'loopback-test-fixture',
      host: '127.0.0.1',
      healthRequests: 1,
      webSocketConnections: 1,
      httpPaths: [
        '/api/health',
        '/api/config',
        '/api/config/defaults',
        '/api/profiles/sessions/sidebar',
      ],
      successfulAuthenticatedHttpPaths: [
        '/api/health',
        '/api/config',
        '/api/config/defaults',
        '/api/profiles/sessions/sidebar',
      ],
      rpcMethods: [],
    },
  }
}


test('resolvePackagedLayout covers electron-builder native layouts', () => {
  const root = path.resolve('/synthetic/release')

  assert.deepEqual(resolvePackagedLayout({ platform: 'darwin', arch: 'x64', releaseRoot: root }), {
    directory: path.join(root, 'mac'),
    binaryPath: path.join(root, 'mac', 'Hermes.app', 'Contents', 'MacOS', 'Hermes'),
  })
  assert.deepEqual(resolvePackagedLayout({ platform: 'darwin', arch: 'arm64', releaseRoot: root }), {
    directory: path.join(root, 'mac-arm64'),
    binaryPath: path.join(root, 'mac-arm64', 'Hermes.app', 'Contents', 'MacOS', 'Hermes'),
  })
  assert.deepEqual(resolvePackagedLayout({ platform: 'linux', arch: 'x64', releaseRoot: root }), {
    directory: path.join(root, 'linux-unpacked'),
    binaryPath: path.join(root, 'linux-unpacked', 'hermes'),
  })
  assert.deepEqual(resolvePackagedLayout({ platform: 'linux', arch: 'arm64', releaseRoot: root }), {
    directory: path.join(root, 'linux-arm64-unpacked'),
    binaryPath: path.join(root, 'linux-arm64-unpacked', 'hermes'),
  })
  assert.deepEqual(resolvePackagedLayout({ platform: 'win32', arch: 'x64', releaseRoot: root }), {
    directory: path.join(root, 'win-unpacked'),
    binaryPath: path.join(root, 'win-unpacked', 'Hermes.exe'),
  })
})

test('resolvePackagedLayout rejects unsupported platform and architecture pairs', () => {
  assert.throws(
    () => resolvePackagedLayout({ platform: 'win32', arch: 'arm64', releaseRoot: '/release' }),
    /unsupported packaged layout: win32\/arm64/,
  )
  assert.throws(
    () => resolvePackagedLayout({ platform: 'freebsd', arch: 'x64', releaseRoot: '/release' }),
    /unsupported packaged layout: freebsd\/x64/,
  )
})

test('buildLaunchEnv carries only runtime allowlist and isolates all writable homes', () => {
  const sandboxRoot = path.join(os.tmpdir(), 'synthetic-native-qa')
  const env = buildLaunchEnv({
    baseEnv: {
      PATH: '/usr/bin',
      DISPLAY: ':99',
      LANG: 'C.UTF-8',
      OPENAI_API_KEY: 'must-not-leak',
      AWS_SECRET_ACCESS_KEY: 'must-not-leak',
      HERMES_HOME: '/real/home',
      HERMES_DESKTOP_REMOTE_URL: 'https://real-gateway.invalid',
      HERMES_DESKTOP_REMOTE_TOKEN: 'must-not-leak',
      NODE_OPTIONS: '--inspect',
    },
    sandboxRoot,
    appName: 'HermesNativeQA-unit',
    gatewayUrl: 'http://127.0.0.1:43127',
    gatewayToken: 'qa-fixture-token',
  })

  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.DISPLAY, ':99')
  assert.equal(env.LANG, 'C.UTF-8')
  assert.equal(env.HOME, path.join(sandboxRoot, 'home'))
  assert.equal(env.USERPROFILE, path.join(sandboxRoot, 'home'))
  assert.equal(env.HERMES_HOME, path.join(sandboxRoot, 'hermes-home'))
  assert.equal(env.HERMES_DESKTOP_USER_DATA_DIR, path.join(sandboxRoot, 'user-data'))
  assert.equal(env.HERMES_DESKTOP_APP_NAME, 'HermesNativeQA-unit')
  assert.equal(env.HERMES_DESKTOP_REMOTE_URL, 'http://127.0.0.1:43127')
  assert.equal(env.HERMES_DESKTOP_REMOTE_TOKEN, 'qa-fixture-token')
  assert.equal(env.HERMES_DESKTOP_BOOT_FAKE, undefined)
  assert.equal(env.LIBGL_ALWAYS_SOFTWARE, '1')
  assert.equal(env.GALLIUM_DRIVER, 'llvmpipe')
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined)
  assert.equal(env.NODE_OPTIONS, undefined)
})

test('buildLaunchEnv rejects a gateway outside an allocated IPv4 loopback port', () => {
  const input = {
    baseEnv: {},
    sandboxRoot: path.join(os.tmpdir(), 'synthetic-native-qa'),
    appName: 'HermesNativeQA-unit',
    gatewayToken: 'qa-fixture-token',
  }

  assert.throws(
    () => buildLaunchEnv({ ...input, gatewayUrl: 'http://localhost:43127' }),
    /must use 127\.0\.0\.1/,
  )
  assert.throws(
    () => buildLaunchEnv({ ...input, gatewayUrl: 'http://127.0.0.1:0' }),
    /must use 127\.0\.0\.1/,
  )
})

test('buildElectronLaunchOptions enables Chromium sandbox before Playwright launch', () => {
  const executablePath = path.join('/release', 'hermes')
  const args = ['--disable-gpu']
  const env = { PATH: '/usr/bin' }

  assert.deepEqual(buildElectronLaunchOptions({ executablePath, args, env }), {
    executablePath,
    args,
    env,
    chromiumSandbox: true,
  })
})

test('gateway mock serves authenticated HTTP and WebSocket JSON-RPC on loopback', async () => {
  const gateway = await startGatewayMock()
  let socket

  try {
    const health = await fetch(`${gateway.url}/api/health`, {
      headers: { 'X-Hermes-Session-Token': gateway.token },
    })
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true })

    const responses = await Promise.all([
      '/api/config',
      '/api/config/defaults',
      '/api/profiles/sessions/sidebar',
    ].map(async pathname => {
      const response = await fetch(`${gateway.url}${pathname}`, {
        headers: { 'X-Hermes-Session-Token': gateway.token },
      })
      assert.equal(response.status, 200)
      return response.json()
    }))
    assert.deepEqual(responses, [
      {},
      {},
      {
        recents: { profiles_truncated: {}, profiles_usage: {}, sessions: [] },
        cron: { sessions: [] },
        messaging: { sessions: [] },
      },
    ])

    socket = new WebSocket(`${gateway.url.replace('http:', 'ws:')}/api/ws?token=${gateway.token}`)
    const ready = await new Promise((resolve, reject) => {
      socket.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true })
      socket.addEventListener('message', event => resolve(JSON.parse(String(event.data))), { once: true })
    })
    assert.equal(ready.method, 'event')
    assert.equal(ready.params?.type, 'gateway.ready')

    const reply = await new Promise((resolve, reject) => {
      socket.addEventListener('error', () => reject(new Error('WebSocket request failed')), { once: true })
      socket.addEventListener('message', event => resolve(JSON.parse(String(event.data))), { once: true })
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'gateway.ping', params: {} }))
    })
    assert.deepEqual(reply, { jsonrpc: '2.0', id: 7, result: { ok: true } })

    const receipt = gateway.receipt()
    assert.equal(receipt.marker, 'hermes-native-qa-gateway-v1')
    assert.equal(receipt.scope, 'loopback-test-fixture')
    assert.equal(receipt.host, '127.0.0.1')
    assert.equal(receipt.healthRequests, 1)
    assert.equal(receipt.webSocketConnections, 1)
    assert.deepEqual([...receipt.httpPaths].sort(), [
      '/api/health',
      '/api/config',
      '/api/config/defaults',
      '/api/profiles/sessions/sidebar',
    ].sort())
  } finally {
    socket?.close()
    await gateway.close()
  }
})

test('QA receipt rejects refused REST requests until every path has authenticated HTTP success', async () => {
  const gateway = await startGatewayMock()
  const required = ['/api/health', '/api/config', '/api/config/defaults', '/api/profiles/sessions/sidebar']
  const headers = { 'X-Hermes-Session-Token': gateway.token }
  const summary = { tests: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 }
  let socket
  const receipt = () => buildQaReceipt({
    summary,
    runtime: { ...validRuntimeReceipt(), gatewayMock: gateway.receipt() },
    sha: 'unit-only-auth-regression',
  })

  try {
    for (const pathname of required) {
      const refused = await fetch(`${gateway.url}${pathname}`)
      assert.equal(refused.status, 401)
      await refused.text()
      const wrongMethod = await fetch(`${gateway.url}${pathname}`, { method: 'POST', headers })
      assert.equal(wrongMethod.status, 405)
      await wrongMethod.text()
    }
    const missing = await fetch(`${gateway.url}/api/not-a-real-endpoint`, { headers })
    assert.equal(missing.status, 404)
    await missing.text()
    const health = await fetch(`${gateway.url}/api/health`, { headers })
    assert.equal(health.status, 200)
    await health.json()
    socket = new WebSocket(`${gateway.url.replace('http:', 'ws:')}/api/ws?token=${gateway.token}`)
    await new Promise((resolve, reject) => {
      socket.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true })
      socket.addEventListener('message', event => {
        try {
          assert.equal(JSON.parse(String(event.data)).params?.type, 'gateway.ready')
          resolve()
        } catch (error) { reject(error) }
      }, { once: true })
    })
    assert.throws(receipt, /runtime receipt failed: gatewayMock/)
    assert.deepEqual(gateway.receipt().successfulAuthenticatedHttpPaths, ['/api/health'])

    for (const pathname of required.slice(1)) {
      assert.throws(receipt, /runtime receipt failed: gatewayMock/)
      const accepted = await fetch(`${gateway.url}${pathname}`, { headers })
      assert.equal(accepted.status, 200)
      await accepted.json()
    }
    assert.equal(receipt().qaOnly, true)
    assert.deepEqual(gateway.receipt().successfulAuthenticatedHttpPaths, required)
    const unsupported = await new Promise((resolve, reject) => {
      socket.addEventListener('error', () => reject(new Error('WebSocket request failed')), { once: true })
      socket.addEventListener('message', event => resolve(JSON.parse(String(event.data))), { once: true })
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'prompt.submit', params: {} }))
    })
    assert.equal(unsupported.error?.code, -32601)
  } finally {
    socket?.close()
    await gateway.close()
  }
})

test('release metadata comparison rejects a downgrade and accepts the fixed upgrade', () => {
  const source = { version: '0.20.6', releaseDate: '2026.8.27' }
  const target = { version: '0.21.0', releaseDate: '2026.8.31' }

  assert.equal(compareReleaseMetadata(source, target), -1)
  assert.equal(compareReleaseMetadata(target, source), 1)
  assert.equal(compareReleaseMetadata(source, { ...source }), 0)
})

test('summarizePlaywrightReport requires non-empty, single-attempt, all-passing output', () => {
  const passing = {
    suites: [{ specs: [{ tests: [{ expectedStatus: 'passed', results: [{ status: 'passed' }] }] }] }],
  }
  assert.deepEqual(summarizePlaywrightReport(passing), {
    tests: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    flaky: 0,
  })

  assert.throws(() => summarizePlaywrightReport({ suites: [] }), /no Playwright tests/)
  assert.throws(
    () => summarizePlaywrightReport({
      suites: [{ specs: [{ tests: [{ expectedStatus: 'passed', results: [{ status: 'skipped' }] }] }] }],
    }),
    /skipped=1/,
  )
  assert.throws(
    () => summarizePlaywrightReport({
      suites: [{
        specs: [{
          tests: [{
            expectedStatus: 'passed',
            results: [{ status: 'failed' }, { status: 'passed' }],
          }],
        }],
      }],
    }),
    /flaky=1/,
  )
})

test('buildQaReceipt labels the exact scope and rejects an incomplete runtime receipt', () => {
  const summary = { tests: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 }
  const runtime = validRuntimeReceipt()

  assert.deepEqual(buildQaReceipt({ summary, runtime, sha: 'abc123' }), {
    scope: 'packaged GUI smoke with deterministic loopback gateway; NOT real backend or first-run installation',
    qaOnly: true,
    releaseArtifact: false,
    sha: 'abc123',
    results: summary,
    runtime,
  })
  assert.throws(
    () => buildQaReceipt({ summary, runtime: { ...runtime, sandbox: false }, sha: 'abc123' }),
    /runtime receipt failed: sandbox/,
  )
  assert.throws(
    () => buildQaReceipt({ summary, runtime: { ...runtime, bootReady: false }, sha: 'abc123' }),
    /runtime receipt failed: bootReady/,
  )
  assert.throws(
    () => buildQaReceipt({ summary, runtime: { ...runtime, gatewayMock: undefined }, sha: 'abc123' }),
    /runtime receipt failed: gatewayMock/,
  )
})

test('check-results CLI reads synthetic runner output and writes the final QA receipt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-native-qa-unit-'))
  const resultsPath = path.join(root, 'results.json')
  const runtimePath = path.join(root, 'runtime.json')
  const receiptPath = path.join(root, 'final.json')
  const report = {
    suites: [{ specs: [{ tests: [{ expectedStatus: 'passed', results: [{ status: 'passed' }] }] }] }],
  }

  try {
    fs.writeFileSync(resultsPath, JSON.stringify(report))
    fs.writeFileSync(runtimePath, JSON.stringify(validRuntimeReceipt()))
    const result = spawnSync(
      process.execPath,
      [
        SUPPORT_PATH,
        'check-results',
        '--results', resultsPath,
        '--runtime-receipt', runtimePath,
        '--receipt', receiptPath,
        '--sha', 'unit-only-sha',
      ],
      { encoding: 'utf8' },
    )

    assert.equal(result.status, 0, result.stderr)
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
    assert.equal(receipt.sha, 'unit-only-sha')
    assert.deepEqual(receipt.results, {
      tests: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      flaky: 0,
    })
    assert.equal(receipt.qaOnly, true)
    assert.equal(receipt.releaseArtifact, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
