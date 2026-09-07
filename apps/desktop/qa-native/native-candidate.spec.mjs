import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { _electron, expect, test } from '@playwright/test'

import {
  buildElectronLaunchOptions,
  buildLaunchEnv,
  resolvePackagedLayout,
  startGatewayMock,
} from './support.mjs'


const DESKTOP_ROOT = path.resolve(import.meta.dirname, '..')
const RELEASE_ROOT = path.join(DESKTOP_ROOT, 'release')
const DESKTOP_PACKAGE = JSON.parse(
  fs.readFileSync(path.join(DESKTOP_ROOT, 'package.json'), 'utf8'),
)
const EXPECTED_ELECTRON_VERSION = '42.11.2'
const BYPASS_SWITCHES = [
  'no-sandbox',
  'disable-setuid-sandbox',
  'disable-seccomp-filter-sandbox',
  'disable-seccomp-sandbox',
  'no-zygote',
]


test('packaged native candidate keeps runtime, renderer, and sandbox contracts', async () => {
  const outputDir = process.env.QA_NATIVE_OUTPUT_DIR
  const runtimeReceiptPath = process.env.QA_NATIVE_RUNTIME_RECEIPT
  const expectedOs = process.env.QA_NATIVE_OS
  const expectedArch = process.env.QA_NATIVE_ARCH
  const expectedPlatform = { linux: 'linux', macos: 'darwin', windows: 'win32' }[expectedOs]

  expect(outputDir, 'QA_NATIVE_OUTPUT_DIR must point to runner.temp').toBeTruthy()
  expect(runtimeReceiptPath, 'QA_NATIVE_RUNTIME_RECEIPT must point to runner.temp').toBeTruthy()
  expect(expectedPlatform, `unsupported QA_NATIVE_OS: ${expectedOs}`).toBeTruthy()
  expect(['x64', 'arm64']).toContain(expectedArch)
  expect(process.platform).toBe(expectedPlatform)
  expect(process.arch).toBe(expectedArch)

  const layout = resolvePackagedLayout({
    platform: process.platform,
    arch: process.arch,
    releaseRoot: RELEASE_ROOT,
  })
  expect(fs.existsSync(layout.binaryPath), `packaged binary must exist: ${layout.binaryPath}`).toBe(true)

  fs.mkdirSync(outputDir, { recursive: true })
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-native-qa-'))
  const appName = `HermesNativeQA-${process.platform}-${process.arch}-${process.pid}`
  const gateway = await startGatewayMock()
  const env = buildLaunchEnv({
    baseEnv: process.env,
    sandboxRoot,
    appName,
    gatewayUrl: gateway.url,
    gatewayToken: gateway.token,
  })
  for (const directory of new Set([
    env.HOME,
    env.APPDATA,
    env.LOCALAPPDATA,
    env.HERMES_HOME,
    env.HERMES_DESKTOP_USER_DATA_DIR,
  ])) {
    fs.mkdirSync(directory, { recursive: true })
  }

  const launchArguments = [
    '--disable-gpu',
    `--user-data-dir=${env.HERMES_DESKTOP_USER_DATA_DIR}`,
  ]
  const launchOptions = buildElectronLaunchOptions({
    executablePath: layout.binaryPath,
    args: launchArguments,
    env,
  })
  let electronApp

  try {
    electronApp = await _electron.launch(launchOptions)
    const page = await electronApp.firstWindow()
    await page.waitForSelector('#root', { state: 'attached', timeout: 30_000 })
    await page.waitForFunction(() => {
      const composer = document.querySelector('[data-slot="composer-rich-input"]')
      const ariaDisabled = composer?.getAttribute('aria-disabled')

      return Boolean(
        composer &&
        composer.isContentEditable &&
        ariaDisabled !== 'true' &&
        document.querySelector('[class*="z-(--z-setup)"]') === null &&
        document.querySelector('[data-glass-opaque]') === null
      )
    }, undefined, {
      timeout: 60_000,
    })

    const dom = await page.evaluate(() => {
      const root = document.getElementById('root')
      const composer = document.querySelector('[data-slot="composer-rich-input"]')
      const ariaDisabled = composer?.getAttribute('aria-disabled')
      const text = root?.textContent ?? ''
      const errorMarkers = [
        'No QueryClient set',
        'Something broke in the interface',
        'Something went wrong',
      ]
      return {
        childCount: root?.childElementCount ?? 0,
        textLength: text.trim().length,
        errorBoundaryAbsent:
          root?.querySelector('[class*="z-(--z-crash)"]') === null &&
          !errorMarkers.some(marker => text.includes(marker)),
        bootReady: document.querySelector('[data-glass-opaque]') === null,
        composerEnabled: Boolean(
          composer && composer.isContentEditable && ariaDisabled !== 'true'
        ),
        overlayAbsent: document.querySelector('[class*="z-(--z-setup)"]') === null,
      }
    })

    const runtime = await electronApp.evaluate(({ app, BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows()
      const visibleWindow = windows.find(window => window.isVisible())
      const window = visibleWindow ?? windows[0]
      const preferences = window?.webContents.getLastWebPreferences() ?? {}
      const bypassArguments = []

      for (const name of [
        'no-sandbox',
        'disable-setuid-sandbox',
        'disable-seccomp-filter-sandbox',
        'disable-seccomp-sandbox',
        'no-zygote',
      ]) {
        if (app.commandLine.hasSwitch(name)) {
          bypassArguments.push(`--${name}`)
        }
      }

      return {
        electronVersion: process.versions.electron,
        appVersion: app.getVersion(),
        isPackaged: app.isPackaged,
        platform: process.platform,
        arch: process.arch,
        windowVisible: Boolean(visibleWindow),
        sandbox: preferences.sandbox,
        contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration,
        processArguments: process.argv,
        bypassArguments,
      }
    })

    const argvBypasses = runtime.processArguments.filter(argument =>
      BYPASS_SWITCHES.some(name => argument === `--${name}` || argument.startsWith(`--${name}=`)),
    )
    const runtimeReceipt = {
      ...runtime,
      domUseful: dom.childCount > 0 && dom.textLength > 0,
      errorBoundaryAbsent: dom.errorBoundaryAbsent,
      bootReady: dom.bootReady,
      composerEnabled: dom.composerEnabled,
      overlayAbsent: dom.overlayAbsent,
      disableGpu: launchOptions.args.includes('--disable-gpu'),
      bypassArguments: [...new Set([...runtime.bypassArguments, ...argvBypasses])],
      gatewayMock: gateway.receipt(),
    }

    expect(runtimeReceipt.electronVersion).toBe(EXPECTED_ELECTRON_VERSION)
    expect(runtimeReceipt.appVersion).toBe(DESKTOP_PACKAGE.version)
    expect(runtimeReceipt.isPackaged).toBe(true)
    expect(runtimeReceipt.platform).toBe(expectedPlatform)
    expect(runtimeReceipt.arch).toBe(expectedArch)
    expect(runtimeReceipt.windowVisible).toBe(true)
    expect(runtimeReceipt.domUseful).toBe(true)
    expect(runtimeReceipt.errorBoundaryAbsent).toBe(true)
    expect(runtimeReceipt.bootReady).toBe(true)
    expect(runtimeReceipt.composerEnabled).toBe(true)
    expect(runtimeReceipt.overlayAbsent).toBe(true)
    expect(runtimeReceipt.sandbox).toBe(true)
    expect(runtimeReceipt.contextIsolation).toBe(true)
    expect(runtimeReceipt.nodeIntegration).toBe(false)
    expect(runtimeReceipt.bypassArguments).toEqual([])

    fs.writeFileSync(
      runtimeReceiptPath,
      `${JSON.stringify(runtimeReceipt, null, 2)}\n`,
      'utf8',
    )
    await page.screenshot({ path: path.join(outputDir, 'packaged-gui-smoke.png') })
  } finally {
    await electronApp?.close().catch(() => undefined)
    await gateway.close()
    fs.rmSync(sandboxRoot, { recursive: true, force: true })
  }
})
