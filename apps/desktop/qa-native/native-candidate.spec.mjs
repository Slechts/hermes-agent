import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { _electron, expect, test } from '@playwright/test'

import {
  collectNativeDiagnostics, observeNativeApp, readNativeDom, readNativeRuntime,
  runWithDiagnostics, sanitizeDiagnostic, withDiagnosticTimeout,
} from './diagnostics.mjs'

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


test('packaged native candidate keeps runtime, renderer, and sandbox contracts', async ({}, testInfo) => {
  // Reserve time inside the existing outer timeout; never lengthen a readiness assertion.
  const deadline = Date.now() + testInfo.timeout - 15_000
  const budget = maximum => Math.max(1, Math.min(maximum, deadline - Date.now()))
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
  let page
  let observation

  await runWithDiagnostics({
    run: async () => {
      expect(fs.existsSync(layout.binaryPath), `packaged binary must exist: ${layout.binaryPath}`).toBe(true)
      electronApp = await _electron.launch({ ...launchOptions, timeout: budget(30_000) })
      observation = observeNativeApp(electronApp, [gateway.token])
      page = await electronApp.firstWindow({ timeout: budget(30_000) })
      await page.waitForSelector('#root', { state: 'attached', timeout: budget(30_000) })
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
        timeout: budget(60_000),
      })

      const dom = await withDiagnosticTimeout(() => page.evaluate(readNativeDom), budget(15_000), 'DOM')
      const runtime = await withDiagnosticTimeout(() => electronApp.evaluate(readNativeRuntime), budget(15_000), 'runtime')

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
        `${JSON.stringify(sanitizeDiagnostic(runtimeReceipt, [gateway.token]), null, 2)}\n`,
        'utf8',
      )
    },
    capture: failure => collectNativeDiagnostics({
      app: electronApp, page, observation, outputDir, gateway, failure, secrets: [gateway.token],
    }),
    cleanup: async () => {
      try {
        await withDiagnosticTimeout(() => electronApp?.close(), 4000, 'Electron close')
      } finally {
        try {
          await withDiagnosticTimeout(() => gateway.close(), 4000, 'gateway close')
        } finally {
          fs.rmSync(sandboxRoot, { recursive: true, force: true })
        }
      }
    },
  })
})
