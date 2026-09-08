import fs from 'node:fs'
import path from 'node:path'

// These functions are serialized by Playwright into the renderer/main process.
export function readNativeDom() {
  const root = document.getElementById('root')
  const composer = document.querySelector('[data-slot="composer-rich-input"]')
  const ariaDisabled = composer?.getAttribute('aria-disabled')
  const text = root?.textContent ?? ''
  const errorMarkers = ['No QueryClient set', 'Something broke in the interface', 'Something went wrong']
  return {
    childCount: root?.childElementCount ?? 0,
    textLength: text.trim().length,
    text,
    rootHtml: root?.outerHTML ?? '',
    errorBoundaryAbsent: root?.querySelector('[class*="z-(--z-crash)"]') === null &&
      !errorMarkers.some(marker => text.includes(marker)),
    bootReady: document.querySelector('[data-glass-opaque]') === null,
    composerEnabled: Boolean(composer && composer.isContentEditable && ariaDisabled !== 'true'),
    overlayAbsent: document.querySelector('[class*="z-(--z-setup)"]') === null,
  }
}

export function readNativeRuntime({ app, BrowserWindow }) {
  const windows = BrowserWindow.getAllWindows()
  const visibleWindow = windows.find(window => window.isVisible())
  const window = visibleWindow ?? windows[0]
  const preferences = window?.webContents.getLastWebPreferences() ?? {}
  const bypassArguments = []
  for (const name of ['no-sandbox', 'disable-setuid-sandbox', 'disable-seccomp-filter-sandbox',
    'disable-seccomp-sandbox', 'no-zygote']) {
    if (app.commandLine.hasSwitch(name)) bypassArguments.push(`--${name}`)
  }
  return {
    electronVersion: process.versions.electron, appVersion: app.getVersion(),
    isPackaged: app.isPackaged, platform: process.platform, arch: process.arch,
    windowVisible: Boolean(visibleWindow), sandbox: preferences.sandbox,
    contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration,
    processArguments: process.argv, bypassArguments,
  }
}

export function observeNativeApp(app, secrets = []) {
  const events = []
  const pages = new Set()
  const record = value => {
    if (events.length < 100) events.push(sanitizeDiagnostic(value, secrets))
  }
  const observe = page => {
    if (pages.has(page)) return
    pages.add(page)
    page.on('console', message => record({ source: 'renderer', type: message.type(), text: message.text() }))
    page.on('pageerror', error => record({ source: 'renderer', error }))
  }
  app.on('window', observe)
  app.on('console', message => record({ source: 'main', type: message.type(), text: message.text() }))
  for (const page of app.windows()) observe(page)
  return { events }
}

export async function withDiagnosticTimeout(operation, timeoutMs, label) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} diagnostic timeout`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function collectNativeDiagnostics({
  app, page, outputDir, gateway, observation, failure, secrets = [], timeoutMs = 1500,
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2000) {
    throw new Error('diagnostic probe timeout must be in (0, 2000] ms')
  }
  fs.mkdirSync(outputDir, { recursive: true })
  const probe = async (label, operation) => {
    try {
      return { status: 'available', value: await withDiagnosticTimeout(operation, timeoutMs, label) }
    } catch (error) {
      return { status: 'unavailable', error: { name: error.name, message: error.message } }
    }
  }
  const requirePage = () => {
    const window = page ?? app?.windows()[0]
    if (!window) throw new Error('no page available')
    return window
  }
  const [url, dom, runtime, mock, screenshot] = await Promise.all([
    probe('url', () => requirePage().url()),
    probe('dom', () => requirePage().evaluate(readNativeDom)),
    probe('runtime', () => {
      if (!app) throw new Error('no Electron application available')
      return app.evaluate(readNativeRuntime)
    }),
    probe('gateway', () => gateway.receipt()),
    probe('screenshot', async () => {
      const window = requirePage()
      const mask = [window.locator('input, textarea, [contenteditable="true"], pre, code'),
        window.getByText(/\b(?:Bearer\s+|token\s*[:=]|password\s*[:=]|secret\s*[:=])/i)]
      for (const secret of secrets.filter(value => typeof value === 'string' && value.length > 0)) {
        for (const text of new Set([secret, encodeURIComponent(secret)])) mask.push(window.getByText(text))
      }
      // Return bytes, not a path: a probe finishing after timeout must not write a late image.
      const bytes = await window.screenshot({ timeout: timeoutMs, mask })
      if (!Buffer.isBuffer(bytes) || bytes.length > 8 * 1024 * 1024) throw new Error('screenshot exceeds byte limit')
      return bytes
    }),
  ])
  if (screenshot.status === 'available') {
    try {
      fs.writeFileSync(path.join(outputDir, 'packaged-gui-smoke.png'), screenshot.value)
      screenshot.value = { file: 'packaged-gui-smoke.png', scope: 'isolated-synthetic-profile' }
    } catch (error) {
      screenshot.status = 'unavailable'
      screenshot.error = { name: error.name, message: error.message }
      delete screenshot.value
    }
  }
  const complete = [url, dom, runtime, mock, screenshot].every(section => section.status === 'available')
  const receipt = sanitizeDiagnostic({
    scope: 'native-smoke-diagnostic-not-release-proof',
    outcome: failure === undefined && complete ? 'passed' : 'failed', failure,
    url, dom, runtime, gateway: mock, screenshot, events: observation?.events ?? [],
  }, secrets)
  fs.writeFileSync(path.join(outputDir, 'native-diagnostics.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  if (failure === undefined && !complete) {
    throw new Error('native diagnostics incomplete; see native-diagnostics.json')
  }
  return receipt
}

export function sanitizeDiagnostic(value, secrets = []) {
  const seen = new WeakSet()
  const cleanText = value => {
    let text = String(value)
    for (const secret of secrets.filter(value => typeof value === 'string' && value.length > 0)) {
      for (const variant of new Set([secret, encodeURIComponent(secret)])) {
        text = text.split(variant).join('[REDACTED]')
      }
    }
    return text
      .replace(/\bBearer\s+[^\s;,"'<>]+/gi, 'Bearer [REDACTED]')
      .replace(/([?&#][^=\s&#]+)=([^\s&#"'<>]*)/g, '$1=[REDACTED]')
      .replace(/((?:token|password|secret|authorization|api[_-]?key)\s*[:=]\s*)[^\s;,"'<>]+/gi, '$1[REDACTED]')
      .slice(0, 4000)
  }
  const visit = (item, depth) => {
    if (item == null || typeof item === 'boolean' || typeof item === 'number') return item
    if (typeof item === 'string') return cleanText(item)
    if (typeof item !== 'object') return cleanText(item)
    if (depth >= 6 || seen.has(item)) return '[BOUNDED]'
    seen.add(item)
    if (item instanceof Error) return { name: cleanText(item.name), message: cleanText(item.message) }
    if (Array.isArray(item)) return item.slice(0, 100).map(value => visit(value, depth + 1))
    return Object.fromEntries(Object.entries(item).slice(0, 60).map(([key, value]) => [
      cleanText(key),
      /token|password|secret|authorization|cookie|api[_-]?key/i.test(key)
        ? '[REDACTED]' : visit(value, depth + 1),
    ]))
  }
  return visit(value, 0)
}

// Keep the original smoke failure authoritative, while always collecting before closing.
export async function runWithDiagnostics({ run, capture, cleanup }) {
  let result
  let failure
  try {
    result = await run()
  } catch (error) {
    failure = error
  }
  try {
    await capture(failure)
  } catch (error) {
    failure ??= error
  }
  try {
    await cleanup()
  } catch (error) {
    failure ??= error
  }
  if (failure !== undefined) throw failure
  return result
}
