import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import test from 'node:test'

async function diagnostics() {
  const module = await import('./diagnostics.mjs').catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
    return null
  })
  assert.ok(module, 'native diagnostic lifecycle must be implemented')
  return module
}

test('capture runs before cleanup on readiness failure and preserves the original error', async () => {
  const { runWithDiagnostics } = await diagnostics()
  const events = []
  const original = new Error('readiness failure')
  await assert.rejects(runWithDiagnostics({
    run: async () => { events.push('run'); throw original },
    capture: async failure => {
      events.push('capture')
      assert.equal(failure, original)
      throw new Error('capture failed too')
    },
    cleanup: async () => { events.push('cleanup'); throw new Error('close failed too') },
  }), error => error === original)
  assert.deepEqual(events, ['run', 'capture', 'cleanup'])
})

test('diagnostics redact secrets and bound strings, arrays, and cyclic objects', async () => {
  const { sanitizeDiagnostic } = await diagnostics()
  assert.equal(typeof sanitizeDiagnostic, 'function', 'sanitizer must exist')
  const token = 'synthetic-secret/with+symbols'
  const source = {
    url: `http://127.0.0.1:43127/?token=${encodeURIComponent(token)}&other=private#ticket=hidden`,
    line: `Authorization: Bearer ${token}; token=${token}`,
    password: 'hidden-password',
    body: 'x'.repeat(10000),
    entries: Array.from({ length: 300 }, () => 'entry'),
  }
  source.cycle = source
  const clean = sanitizeDiagnostic(source, [token])
  const text = JSON.stringify(clean)
  for (const secret of [token, encodeURIComponent(token), 'private', 'hidden-password', 'hidden']) {
    assert.equal(text.includes(secret), false)
  }
  assert.ok(clean.body.length <= 4100)
  assert.ok(clean.entries.length <= 100)
  assert.ok(text.includes('[REDACTED]'))
})

test('capture writes sanitized partial evidence even when renderer probes time out', async t => {
  const { collectNativeDiagnostics, observeNativeApp } = await diagnostics()
  assert.equal(typeof collectNativeDiagnostics, 'function', 'partial capture must exist')
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-diagnostic-unit-'))
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }))
  const page = new EventEmitter()
  page.url = () => 'http://127.0.0.1:41234/?token=unit-secret'
  page.evaluate = () => new Promise(() => {})
  page.locator = value => ({ selector: value })
  page.getByText = value => ({ text: value })
  page.screenshot = async options => {
    assert.ok(options.timeout > 0)
    assert.ok(options.mask.length >= 2)
    return Buffer.from('synthetic screenshot fixture, NOT native image evidence')
  }
  const app = new EventEmitter()
  app.windows = () => [page]
  app.evaluate = async () => ({ sandbox: true, contextIsolation: true, nodeIntegration: false })
  const observation = observeNativeApp(app, ['unit-secret'])
  page.emit('pageerror', new Error('failed unit-secret'))
  for (let i = 0; i < 150; i++) page.emit('console', { type: () => 'error', text: () => 'unit-secret' })
  const failure = new Error('readiness failed unit-secret')
  const receipt = await collectNativeDiagnostics({
    app, page, observation, outputDir, failure, secrets: ['unit-secret'], timeoutMs: 20,
    gateway: { receipt: () => ({ httpResponses: [{ path: '/api/config', status: 401 }] }) },
  })
  assert.equal(receipt.outcome, 'failed')
  assert.equal(receipt.dom.status, 'unavailable')
  assert.match(receipt.dom.error.message, /timeout/)
  assert.equal(receipt.runtime.status, 'available')
  assert.equal(receipt.runtime.value.sandbox, true)
  assert.equal(receipt.gateway.value.httpResponses[0].status, 401)
  assert.ok(receipt.events.length <= 100)
  assert.equal(receipt.screenshot.status, 'available')
  const raw = fs.readFileSync(path.join(outputDir, 'native-diagnostics.json'), 'utf8')
  assert.equal(raw.includes('unit-secret'), false)
  assert.ok(fs.existsSync(path.join(outputDir, 'packaged-gui-smoke.png')))
  assert.deepEqual(JSON.parse(raw), receipt)
})

test('launch failure records unavailable runtime and screenshot without inventing success', async t => {
  const { collectNativeDiagnostics } = await diagnostics()
  assert.equal(typeof collectNativeDiagnostics, 'function', 'partial capture must exist')
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-launch-unit-'))
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }))
  const receipt = await collectNativeDiagnostics({
    outputDir, failure: new Error('launch failed'), gateway: { receipt: () => ({ scope: 'unit' }) },
  })
  for (const section of ['dom', 'runtime', 'screenshot']) assert.equal(receipt[section].status, 'unavailable')
  assert.equal(receipt.outcome, 'failed')
  assert.equal(fs.existsSync(path.join(outputDir, 'packaged-gui-smoke.png')), false)
})

test('DOM and runtime probes report each readiness and security condition independently', async () => {
  const { readNativeDom, readNativeRuntime } = await diagnostics()
  assert.equal(typeof readNativeDom, 'function', 'DOM probe must exist')
  const previous = globalThis.document
  const root = { childElementCount: 1, textContent: 'Loading model', outerHTML: '<main>Loading model</main>', querySelector: () => null }
  globalThis.document = {
    getElementById: () => root,
    querySelector: selector => selector.includes('composer-rich-input')
      ? { isContentEditable: true, getAttribute: () => 'true' }
      : selector.includes('z-setup') ? {} : null,
  }
  try {
    const dom = readNativeDom()
    assert.equal(dom.bootReady, true)
    assert.equal(dom.composerEnabled, false)
    assert.equal(dom.overlayAbsent, false)
    assert.equal(dom.errorBoundaryAbsent, true)
    assert.equal(dom.text, 'Loading model')
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
  const runtime = readNativeRuntime({
    app: { getVersion: () => 'unit-app', isPackaged: true, commandLine: { hasSwitch: name => name === 'no-sandbox' } },
    BrowserWindow: { getAllWindows: () => [{ isVisible: () => true, webContents: {
      getLastWebPreferences: () => ({ sandbox: false, contextIsolation: true, nodeIntegration: false }),
    } }] },
  })
  assert.equal(runtime.sandbox, false)
  assert.deepEqual(runtime.bypassArguments, ['--no-sandbox'])
})

test('incomplete capture is marked failed in the receipt and fails a successful smoke', async t => {
  const { collectNativeDiagnostics } = await diagnostics()
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-incomplete-unit-'))
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }))
  await assert.rejects(collectNativeDiagnostics({
    outputDir, gateway: { receipt: () => ({}) },
  }), /diagnostics incomplete/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(outputDir, 'native-diagnostics.json'))).outcome, 'failed')
})

test('bounded read preserves values and rejects a hung probe before the outer test deadline', async () => {
  const { withDiagnosticTimeout } = await diagnostics()
  assert.equal(typeof withDiagnosticTimeout, 'function', 'bounded operation must exist')
  assert.equal(await withDiagnosticTimeout(() => 42, 20, 'unit'), 42)
  await assert.rejects(withDiagnosticTimeout(() => new Promise(() => {}), 20, 'unit'), /unit.*timeout/)
})

test('missing diagnostics cannot turn an otherwise successful run green', async () => {
  const { runWithDiagnostics } = await diagnostics()
  const events = []
  const failure = new Error('receipt could not be written')
  await assert.rejects(runWithDiagnostics({
    run: async () => 'ok',
    capture: async error => { assert.equal(error, undefined); throw failure },
    cleanup: async () => { events.push('cleanup') },
  }), error => error === failure)
  assert.deepEqual(events, ['cleanup'])
})
