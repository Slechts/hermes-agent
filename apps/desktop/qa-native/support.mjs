import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'


const THIS_DIR = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = path.resolve(THIS_DIR, '..')
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '..', '..')

const SOURCE_SHA = '5fc308a70719a83cccdbba4c0e39c23f5a8239d5'
const BASE_SHA = '29112bef099274229cadff79cdff7bf7b99c4b77'
const SOURCE_METADATA = { version: '0.20.6', releaseDate: '2026.8.27' }
const BASE_METADATA = { version: '0.21.0', releaseDate: '2026.8.31' }
const EXPECTED_ELECTRON_VERSION = '42.11.2'
const GATEWAY_MOCK_MARKER = 'hermes-native-qa-gateway-v1'
const GATEWAY_MOCK_SCOPE = 'loopback-test-fixture'
const GATEWAY_MOCK_HOST = '127.0.0.1'
const MAX_GATEWAY_MOCK_FRAME_BYTES = 64 * 1024

const PASSTHROUGH_ENV = new Set([
  'COMSPEC',
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'PATH',
  'Path',
  'PATHEXT',
  'SYSTEMROOT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'USERNAME',
  'WINDIR',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
])

const RELEASE_METADATA_PYTHON = String.raw`
import ast
import datetime
import json
import re
import sys

values = {}
for node in ast.parse(sys.stdin.read()).body:
    if isinstance(node, ast.Assign):
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id in {"__version__", "__release_date__"}:
                if target.id in values:
                    raise ValueError(f"duplicate release metadata: {target.id}")
                values[target.id] = ast.literal_eval(node.value)

version = values.get("__version__")
release_date = values.get("__release_date__")
if not isinstance(version, str) or not re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", version):
    raise ValueError("invalid __version__ metadata")
if not isinstance(release_date, str) or not re.fullmatch(r"[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}(?:\.[0-9]+)?", release_date):
    raise ValueError("invalid __release_date__ metadata")
date_parts = tuple(map(int, release_date.split(".")))
datetime.date(*date_parts[:3])
print(json.dumps({"version": version, "releaseDate": release_date}, separators=(",", ":")))
`


function fail(message) {
  throw new Error(message)
}


function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: options.encoding ?? 'utf8',
    env: options.env ?? process.env,
    input: options.input,
    stdio: options.stdio,
  })

  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim()
    fail(`${command} ${args.join(' ')} failed with exit ${result.status}${detail ? `: ${detail}` : ''}`)
  }

  return typeof result.stdout === 'string' ? result.stdout.trim() : ''
}


function parseArgs(argv) {
  const parsed = { _: [] }

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) {
      parsed._.push(item)
      continue
    }

    const name = item.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      fail(`missing value for --${name}`)
    }
    parsed[name] = value
    index += 1
  }

  return parsed
}


function numericParts(value, expectedParts, label) {
  const pattern = expectedParts === 3
    ? /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/
    : /^[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}(?:\.[0-9]+)?$/

  if (typeof value !== 'string' || !pattern.test(value)) {
    fail(`invalid ${label}: ${String(value)}`)
  }

  const parts = value.split('.').map(Number)
  while (parts.length < expectedParts) {
    parts.push(0)
  }
  return parts
}


function compareNumericParts(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0)
    if (delta !== 0) {
      return delta < 0 ? -1 : 1
    }
  }
  return 0
}


export function compareReleaseMetadata(left, right) {
  const dateComparison = compareNumericParts(
    numericParts(left.releaseDate, 4, 'release date'),
    numericParts(right.releaseDate, 4, 'release date'),
  )
  if (dateComparison !== 0) {
    return dateComparison
  }

  return compareNumericParts(
    numericParts(left.version, 3, 'version'),
    numericParts(right.version, 3, 'version'),
  )
}


export function resolvePackagedLayout({ platform, arch, releaseRoot, productName, executableName }) {
  const builder = JSON.parse(
    fs.readFileSync(path.join(DESKTOP_ROOT, 'package.json'), 'utf8'),
  ).build
  productName ??= builder.productName
  executableName ??= builder.executableName
  const layouts = {
    'darwin/arm64': ['mac-arm64', `${productName}.app`, 'Contents', 'MacOS', executableName],
    'darwin/x64': ['mac', `${productName}.app`, 'Contents', 'MacOS', executableName],
    'linux/arm64': ['linux-arm64-unpacked', executableName],
    'linux/x64': ['linux-unpacked', executableName],
    'win32/x64': ['win-unpacked', `${executableName}.exe`],
  }
  const parts = layouts[`${platform}/${arch}`]

  if (!parts) {
    fail(`unsupported packaged layout: ${platform}/${arch}`)
  }

  return {
    directory: path.join(releaseRoot, parts[0]),
    binaryPath: path.join(releaseRoot, ...parts),
  }
}


export function buildElectronLaunchOptions({ executablePath, args, env }) {
  return { executablePath, args, env, chromiumSandbox: true }
}


function gatewayMockFrame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')

  if (body.length > MAX_GATEWAY_MOCK_FRAME_BYTES) {
    fail('gateway mock response exceeds bounded WebSocket frame size')
  }

  if (body.length <= 125) {
    return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body])
  }

  const header = Buffer.alloc(4)
  header[0] = 0x80 | opcode
  header[1] = 126
  header.writeUInt16BE(body.length, 2)
  return Buffer.concat([header, body])
}


function gatewayMockResponse(pathname) {
  if (pathname === '/api/health') {
    return { ok: true }
  }
  if (pathname === '/api/status') {
    return { ready: true, status: 'ok' }
  }
  if (pathname === '/api/config' || pathname === '/api/config/defaults') {
    return {}
  }
  if (pathname === '/api/profiles/sessions/sidebar') {
    return {
      recents: { profiles_truncated: {}, profiles_usage: {}, sessions: [] },
      cron: { sessions: [] },
      messaging: { sessions: [] },
    }
  }
  return null
}


function writeGatewayMockJson(response, status, body) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8')
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(payload.length),
    'Cache-Control': 'no-store',
  })
  response.end(payload)
}


function websocketToken(requestUrl) {
  try {
    return new URL(requestUrl, 'http://127.0.0.1').searchParams.get('token') ?? ''
  } catch {
    return ''
  }
}


function acceptGatewayMockFrames(socket, state) {
  let pending = Buffer.alloc(0)

  socket.on('data', chunk => {
    pending = Buffer.concat([pending, chunk])
    if (pending.length > MAX_GATEWAY_MOCK_FRAME_BYTES + 14) {
      socket.destroy()
      return
    }

    while (pending.length >= 2) {
      const first = pending[0]
      const second = pending[1]
      const final = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2

      if (!final || !masked) {
        socket.destroy()
        return
      }
      if (length === 126) {
        if (pending.length < 4) return
        length = pending.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (pending.length < 10) return
        const wideLength = pending.readBigUInt64BE(2)
        if (wideLength > BigInt(MAX_GATEWAY_MOCK_FRAME_BYTES)) {
          socket.destroy()
          return
        }
        length = Number(wideLength)
        offset = 10
      }
      if (length > MAX_GATEWAY_MOCK_FRAME_BYTES) {
        socket.destroy()
        return
      }
      if (pending.length < offset + 4 + length) return

      const mask = pending.subarray(offset, offset + 4)
      const body = Buffer.from(pending.subarray(offset + 4, offset + 4 + length))
      pending = pending.subarray(offset + 4 + length)
      for (let index = 0; index < body.length; index += 1) {
        body[index] ^= mask[index % 4]
      }

      if (opcode === 0x8) {
        socket.end(gatewayMockFrame(body, 0x8))
        return
      }
      if (opcode === 0x9) {
        socket.write(gatewayMockFrame(body, 0xa))
        continue
      }
      if (opcode !== 0x1) {
        socket.destroy()
        return
      }

      let request
      try {
        request = JSON.parse(body.toString('utf8'))
      } catch {
        socket.write(gatewayMockFrame(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'parse error' },
        })))
        continue
      }

      state.rpcMethods.push(String(request?.method ?? ''))
      const response = request?.method === 'gateway.ping'
        ? { jsonrpc: '2.0', id: request?.id ?? null, result: { ok: true } }
        : {
            jsonrpc: '2.0',
            id: request?.id ?? null,
            error: { code: -32601, message: 'method not available in QA gateway mock' },
          }
      socket.write(gatewayMockFrame(JSON.stringify(response)))
    }
  })
}


export async function startGatewayMock() {
  const token = crypto.randomBytes(24).toString('base64url')
  const sockets = new Set()
  const state = {
    healthRequests: 0,
    httpPaths: [],
    httpResponses: [],
    successfulAuthenticatedHttpPaths: [],
    rpcMethods: [],
    webSocketConnections: 0,
  }

  const authorized = request =>
    request.headers['x-hermes-session-token'] === token || websocketToken(request.url) === token

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    state.httpPaths.push(url.pathname)
    response.once('finish', () => {
      if (state.httpResponses.length < 100) {
        state.httpResponses.push({ path: url.pathname, method: request.method, status: response.statusCode })
      }
    })

    if (!authorized(request)) {
      writeGatewayMockJson(response, 401, { detail: 'invalid QA gateway token' })
      return
    }
    if (request.method !== 'GET') {
      writeGatewayMockJson(response, 405, { detail: 'method not allowed' })
      return
    }

    const body = gatewayMockResponse(url.pathname)
    if (body === null) {
      writeGatewayMockJson(response, 404, { detail: 'No such API endpoint' })
      return
    }
    if (url.pathname === '/api/health') {
      state.healthRequests += 1
    }
    response.once('finish', () => {
      if (response.statusCode === 200) {
        state.successfulAuthenticatedHttpPaths.push(url.pathname)
      }
    })
    writeGatewayMockJson(response, 200, body)
  })

  server.on('upgrade', (request, socket) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const key = request.headers['sec-websocket-key']

    if (
      url.pathname !== '/api/ws' ||
      !authorized(request) ||
      request.headers.upgrade?.toLowerCase() !== 'websocket' ||
      typeof key !== 'string'
    ) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return
    }

    const accept = crypto
      .createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )

    sockets.add(socket)
    state.webSocketConnections += 1
    socket.on('error', () => undefined)
    socket.once('close', () => sockets.delete(socket))
    acceptGatewayMockFrames(socket, state)
    socket.write(gatewayMockFrame(JSON.stringify({
      jsonrpc: '2.0',
      method: 'event',
      params: {
        type: 'gateway.ready',
        payload: {
          change_events: false,
          heartbeat: true,
          replay_epoch: GATEWAY_MOCK_MARKER,
        },
      },
    })))
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, GATEWAY_MOCK_HOST, resolve)
  })

  const address = server.address()
  if (!address || typeof address === 'string' || address.address !== GATEWAY_MOCK_HOST || address.port === 0) {
    await new Promise(resolve => server.close(resolve))
    fail('gateway mock did not bind to an ephemeral IPv4 loopback port')
  }

  let closed = false
  return {
    url: `http://${GATEWAY_MOCK_HOST}:${address.port}`,
    token,
    receipt: () => ({
      marker: GATEWAY_MOCK_MARKER,
      scope: GATEWAY_MOCK_SCOPE,
      host: GATEWAY_MOCK_HOST,
      healthRequests: state.healthRequests,
      webSocketConnections: state.webSocketConnections,
      httpPaths: [...state.httpPaths],
      httpResponses: state.httpResponses.map(response => ({ ...response })),
      successfulAuthenticatedHttpPaths: [...state.successfulAuthenticatedHttpPaths],
      rpcMethods: [...state.rpcMethods],
    }),
    close: async () => {
      if (closed) return
      closed = true
      for (const socket of sockets) {
        socket.destroy()
      }
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    },
  }
}


export function buildLaunchEnv({ baseEnv, sandboxRoot, appName, gatewayUrl, gatewayToken }) {
  let parsedGatewayUrl
  try {
    parsedGatewayUrl = new URL(gatewayUrl)
  } catch {
    fail('QA gateway URL must be an absolute loopback HTTP URL')
  }
  if (
    parsedGatewayUrl.protocol !== 'http:' ||
    parsedGatewayUrl.hostname !== GATEWAY_MOCK_HOST ||
    parsedGatewayUrl.port === '' ||
    Number(parsedGatewayUrl.port) < 1 ||
    parsedGatewayUrl.pathname !== '/' ||
    parsedGatewayUrl.search ||
    parsedGatewayUrl.hash ||
    parsedGatewayUrl.username ||
    parsedGatewayUrl.password
  ) {
    fail('QA gateway URL must use 127.0.0.1 with an explicit ephemeral port')
  }
  if (typeof gatewayToken !== 'string' || gatewayToken.length < 16) {
    fail('QA gateway token must be a non-empty fixture token')
  }

  const env = {}

  for (const [name, value] of Object.entries(baseEnv)) {
    if (PASSTHROUGH_ENV.has(name) && typeof value === 'string' && value.length > 0) {
      env[name] = value
    }
  }

  const isolatedHome = path.join(sandboxRoot, 'home')
  return {
    ...env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    APPDATA: path.join(sandboxRoot, 'app-data'),
    LOCALAPPDATA: path.join(sandboxRoot, 'local-app-data'),
    HERMES_HOME: path.join(sandboxRoot, 'hermes-home'),
    HERMES_DESKTOP_USER_DATA_DIR: path.join(sandboxRoot, 'user-data'),
    HERMES_DESKTOP_APP_NAME: appName,
    HERMES_DESKTOP_IGNORE_EXISTING: '1',
    HERMES_DESKTOP_REMOTE_URL: parsedGatewayUrl.origin,
    HERMES_DESKTOP_REMOTE_TOKEN: gatewayToken,
    HERMES_DESKTOP_SKIP_QUIT_CONFIRM: '1',
    LIBGL_ALWAYS_SOFTWARE: '1',
    GALLIUM_DRIVER: 'llvmpipe',
  }
}


function collectTests(suites, output = []) {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) {
      output.push(...(spec.tests ?? []))
    }
    collectTests(suite.suites, output)
  }
  return output
}


export function summarizePlaywrightReport(report) {
  const tests = collectTests(report?.suites)
  if (tests.length === 0) {
    fail('no Playwright tests were reported')
  }

  const summary = { tests: tests.length, passed: 0, failed: 0, skipped: 0, flaky: 0 }
  for (const test of tests) {
    const results = Array.isArray(test.results) ? test.results : []
    const finalStatus = results.at(-1)?.status

    if (results.length > 1) {
      summary.flaky += 1
    }
    if (test.expectedStatus === 'skipped' || finalStatus === 'skipped') {
      summary.skipped += 1
    } else if (test.expectedStatus !== 'passed' || finalStatus !== 'passed') {
      summary.failed += 1
    } else {
      summary.passed += 1
    }
  }

  if (summary.failed || summary.skipped || summary.flaky || summary.passed !== summary.tests) {
    fail(
      `Playwright result gate failed: tests=${summary.tests} passed=${summary.passed} ` +
      `failed=${summary.failed} skipped=${summary.skipped} flaky=${summary.flaky}`,
    )
  }

  return summary
}


export function buildQaReceipt({ summary, runtime, sha }) {
  const requiredTrue = [
    'isPackaged',
    'windowVisible',
    'domUseful',
    'errorBoundaryAbsent',
    'disableGpu',
    'sandbox',
    'contextIsolation',
    'bootReady',
    'composerEnabled',
    'overlayAbsent',
  ]
  const failed = requiredTrue.filter((key) => runtime?.[key] !== true)

  if (runtime?.nodeIntegration !== false) {
    failed.push('nodeIntegration')
  }
  if (!Array.isArray(runtime?.bypassArguments) || runtime.bypassArguments.length !== 0) {
    failed.push('bypassArguments')
  }
  if (runtime?.electronVersion !== EXPECTED_ELECTRON_VERSION) {
    failed.push('electronVersion')
  }
  if (typeof runtime?.appVersion !== 'string' || runtime.appVersion.length === 0) {
    failed.push('appVersion')
  }
  if (!['linux', 'darwin', 'win32'].includes(runtime?.platform)) {
    failed.push('platform')
  }
  if (!['x64', 'arm64'].includes(runtime?.arch)) {
    failed.push('arch')
  }
  if (
    runtime?.gatewayMock?.marker !== GATEWAY_MOCK_MARKER ||
    runtime?.gatewayMock?.scope !== GATEWAY_MOCK_SCOPE ||
    runtime?.gatewayMock?.host !== GATEWAY_MOCK_HOST ||
    !Number.isInteger(runtime?.gatewayMock?.healthRequests) ||
    runtime.gatewayMock.healthRequests < 1 ||
    !Number.isInteger(runtime?.gatewayMock?.webSocketConnections) ||
    runtime.gatewayMock.webSocketConnections < 1 ||
    !Array.isArray(runtime.gatewayMock.successfulAuthenticatedHttpPaths) ||
    ![
      '/api/health',
      '/api/config',
      '/api/config/defaults',
      '/api/profiles/sessions/sidebar',
    ].every(pathname => runtime.gatewayMock.successfulAuthenticatedHttpPaths.includes(pathname))
  ) {
    failed.push('gatewayMock')
  }
  if (failed.length > 0) {
    fail(`runtime receipt failed: ${failed.join(', ')}`)
  }

  return {
    scope: 'packaged GUI smoke with deterministic loopback gateway; NOT real backend or first-run installation',
    qaOnly: true,
    releaseArtifact: false,
    sha,
    results: summary,
    runtime,
  }
}


function parseReleaseMetadata(source) {
  const output = run('python3', ['-c', RELEASE_METADATA_PYTHON], {
    cwd: REPO_ROOT,
    input: source,
  })
  return JSON.parse(output)
}


function git(...args) {
  return run('git', ['-C', REPO_ROOT, ...args])
}


function assertFullSha(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    fail(`${label} must be a full lowercase commit SHA`)
  }
}


function resolveCommit(sha, label) {
  const resolved = git('rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`)
  if (resolved !== sha) {
    fail(`${label} did not resolve to the exact requested commit`)
  }
}


function assertAncestor(ancestor, descendant, label) {
  const result = spawnSync(
    'git',
    ['-C', REPO_ROOT, 'merge-base', '--is-ancestor', ancestor, descendant],
    { encoding: 'utf8' },
  )
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    fail(`${label}: ${ancestor} is not an ancestor of ${descendant}`)
  }
}


function metadataAt(sha) {
  return parseReleaseMetadata(git('show', '--end-of-options', `${sha}:hermes_cli/__init__.py`))
}


function sameMetadata(actual, expected) {
  return actual.version === expected.version && actual.releaseDate === expected.releaseDate
}


function writeJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}


function preflight(args) {
  const sourceSha = args['source-sha'] ?? process.env.QA_SOURCE_SHA
  const baseSha = args['base-sha'] ?? process.env.QA_BASE_SHA
  const targetSha = args['target-sha'] ?? process.env.QA_TARGET_SHA
  const receiptPath = args.receipt ?? process.env.QA_PREFLIGHT_RECEIPT

  assertFullSha(sourceSha, 'source SHA')
  assertFullSha(baseSha, 'base SHA')
  assertFullSha(targetSha, 'target SHA')
  if (sourceSha !== SOURCE_SHA || baseSha !== BASE_SHA) {
    fail('source/base SHA differs from the authorized fixed pair')
  }
  if (!receiptPath) {
    fail('preflight receipt path is required')
  }
  if (git('rev-parse', '--is-shallow-repository') !== 'false') {
    fail('preflight requires complete git history')
  }

  resolveCommit(sourceSha, 'source SHA')
  resolveCommit(baseSha, 'base SHA')
  resolveCommit(targetSha, 'target SHA')
  if (git('rev-parse', 'HEAD') !== targetSha) {
    fail('checked-out HEAD differs from the gated target SHA')
  }
  assertAncestor(sourceSha, baseSha, 'fixed source/base ancestry')
  assertAncestor(baseSha, targetSha, 'base/target ancestry')

  const sourceMetadata = metadataAt(sourceSha)
  const baseMetadata = metadataAt(baseSha)
  const targetMetadata = metadataAt(targetSha)
  if (!sameMetadata(sourceMetadata, SOURCE_METADATA)) {
    fail(`unexpected fixed source metadata: ${JSON.stringify(sourceMetadata)}`)
  }
  if (!sameMetadata(baseMetadata, BASE_METADATA)) {
    fail(`unexpected fixed base metadata: ${JSON.stringify(baseMetadata)}`)
  }
  if (compareReleaseMetadata(sourceMetadata, targetMetadata) > 0) {
    fail('fixed source is newer than target; downgrade refused')
  }
  if (compareReleaseMetadata(baseMetadata, targetMetadata) > 0) {
    fail('target metadata is older than the authorized base; downgrade refused')
  }

  const receipt = {
    source: { sha: sourceSha, ...sourceMetadata },
    base: { sha: baseSha, ...baseMetadata },
    target: { sha: targetSha, ...targetMetadata },
    completeHistory: true,
    sourceIsAncestorOfBase: true,
    baseIsAncestorOfTarget: true,
    downgrade: false,
  }
  writeJson(receiptPath, receipt)
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
}


function installElectron() {
  const require = createRequire(path.join(DESKTOP_ROOT, 'package.json'))
  const packagePath = require.resolve('electron/package.json')
  const electronPackage = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
  const installScript = path.join(path.dirname(packagePath), 'install.js')

  if (electronPackage.version !== EXPECTED_ELECTRON_VERSION) {
    fail(`expected Electron ${EXPECTED_ELECTRON_VERSION}, found ${electronPackage.version}`)
  }
  if (electronPackage.scripts?.postinstall) {
    fail('Electron package unexpectedly declares postinstall; explicit install contract changed')
  }
  if (!fs.existsSync(installScript)) {
    fail(`Electron install script is missing: ${installScript}`)
  }

  run(process.execPath, [installScript], {
    cwd: path.dirname(packagePath),
    env: process.env,
    encoding: null,
    stdio: 'inherit',
  })
}


function checkResults(args) {
  const resultsPath = args.results ?? process.env.QA_NATIVE_RESULTS_JSON
  const runtimePath = args['runtime-receipt'] ?? process.env.QA_NATIVE_RUNTIME_RECEIPT
  const receiptPath = args.receipt ?? process.env.QA_NATIVE_FINAL_RECEIPT
  const sha = args.sha ?? process.env.GITHUB_SHA

  if (!resultsPath || !runtimePath || !receiptPath || !sha) {
    fail('check-results requires results, runtime receipt, final receipt, and SHA')
  }
  for (const required of [resultsPath, runtimePath]) {
    if (!fs.existsSync(required) || fs.statSync(required).size === 0) {
      fail(`required non-empty result file is missing: ${required}`)
    }
  }

  const summary = summarizePlaywrightReport(JSON.parse(fs.readFileSync(resultsPath, 'utf8')))
  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'))
  const receipt = buildQaReceipt({ summary, runtime, sha })
  writeJson(receiptPath, receipt)
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
}


function main(argv) {
  const [command, ...rest] = argv
  const args = parseArgs(rest)

  if (command === 'preflight') {
    preflight(args)
  } else if (command === 'install-electron') {
    installElectron()
  } else if (command === 'check-results') {
    checkResults(args)
  } else {
    fail('usage: support.mjs <preflight|install-electron|check-results> [options]')
  }
}


if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`qa-native: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
