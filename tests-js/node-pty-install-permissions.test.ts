import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, test } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const REPAIR_SCRIPT = path.join(REPO_ROOT, 'scripts', 'fix-node-pty-permissions.mjs')
const temporaryPaths: string[] = []
// Native Windows does not expose useful POSIX execute bits and symlink creation can require privileges.
// The existing native Windows dependency probes remain enabled in their own suites.
const posixTest = process.platform === 'win32' ? test.skip : test
const macTest = process.platform === 'darwin' ? test : test.skip

afterEach(() => {
  for (const temporaryPath of temporaryPaths.splice(0)) {
    fs.rmSync(temporaryPath, { force: true, recursive: true })
  }
})

function makeTemporaryDirectory(prefix: string): string {
  const temporaryPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix))

  temporaryPaths.push(temporaryPath)

  return temporaryPath
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function installNodePtyFixture(projectRoot: string, arch = 'arm64'): string {
  const packageRoot = path.join(projectRoot, 'node_modules', 'node-pty')

  writeJson(path.join(packageRoot, 'package.json'), {
    name: 'node-pty',
    version: '1.1.0',
    main: './lib/index.js',
  })
  fs.mkdirSync(path.join(packageRoot, 'lib'), { recursive: true })
  fs.writeFileSync(
    path.join(packageRoot, 'lib', 'utils.js'),
    `'use strict'\nexports.loadNativeModule = function (name) {\n` +
      `  const dirs = ['build/Release', 'build/Debug', ${JSON.stringify(`prebuilds/darwin-${arch}`)}]\n` +
      `  const relative = ['..', '.']\n` +
      `  let lastError\n` +
      `  for (const dirName of dirs) {\n` +
      `    for (const base of relative) {\n` +
      `      const dir = base + '/' + dirName + '/'\n` +
      `      try { return { dir, module: require(dir + '/' + name + '.node') } } catch (error) { lastError = error }\n` +
      `    }\n` +
      `  }\n` +
      `  throw new Error('Failed to load native module: ' + lastError)\n` +
      `}\n`
  )

  return packageRoot
}

function writeLayout(
  packageRoot: string,
  relativeDirectory: string,
  nativeContents = 'load',
  includeHelper = true
): string {
  const directory = path.join(packageRoot, relativeDirectory)
  const helperPath = path.join(directory, 'spawn-helper')

  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'pty.node'), nativeContents)

  if (includeHelper) {
    fs.writeFileSync(helperPath, 'fixture-helper-bytes')
    fs.chmodSync(helperPath, 0o644)
  }

  return helperPath
}

function makeNativeFixturePreload(): string {
  const preloadRoot = makeTemporaryDirectory('hermes node pty preload ')
  const preloadPath = path.join(preloadRoot, 'native-fixture.cjs')

  fs.writeFileSync(
    preloadPath,
    `'use strict'\n` +
      `const fs = require('node:fs')\n` +
      `const path = require('node:path')\n` +
      `  require.extensions['.node'] = (module, filename) => {\n` +
      `    fs.appendFileSync(path.resolve('native-loads.jsonl'), JSON.stringify(filename) + '\\n')\n` +
      `    if (fs.readFileSync(filename, 'utf8') !== 'load') throw new Error('Rejected fixture native module')\n` +
      `    module.exports = {}\n` +
      `  }\n`
  )

  return preloadPath
}

function executableMode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777
}

function changeTime(filePath: string): bigint {
  return fs.statSync(filePath, { bigint: true }).ctimeNs
}

function runRepair(projectRoot: string, platform = 'darwin', arch = 'arm64'): SpawnSyncReturns<string> {
  // Platform is explicit function data, never a forged host OS or architecture.
  const invocation = `const { repairNodePtyPermissions } = await import(${JSON.stringify(pathToFileURL(REPAIR_SCRIPT).href)}); repairNodePtyPermissions(${JSON.stringify({ platform, arch })})`

  return spawnSync(process.execPath, ['--require', makeNativeFixturePreload(), '--input-type=module', '--eval', invocation], {
    cwd: projectRoot,
    encoding: 'utf8',
  })
}

function preparePostinstallFixture(projectRoot: string): void {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))

  writeJson(path.join(projectRoot, 'package.json'), manifest)
  fs.mkdirSync(path.join(projectRoot, 'scripts'), { recursive: true })
  fs.copyFileSync(REPAIR_SCRIPT, path.join(projectRoot, 'scripts', path.basename(REPAIR_SCRIPT)))
}

function runPostinstall(projectRoot: string): SpawnSyncReturns<string> {
  const npmCliPath = process.env.npm_execpath

  assert.ok(npmCliPath, 'npm_execpath must identify the canonical npm CLI')

  const preloadPath = makeNativeFixturePreload()

  return spawnSync(process.execPath, [npmCliPath, 'run', 'postinstall', '--workspaces=false'], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_OPTIONS: `--require=${JSON.stringify(preloadPath)}`,
    },
  })
}

macTest('canonical postinstall repairs the selected Darwin helper without changing its bytes', () => {
  // This lifecycle arm belongs on real macOS; other hosts exercise the exported contract separately.
  const projectRoot = makeTemporaryDirectory('hermes node pty project ')
  const packageRoot = installNodePtyFixture(projectRoot, process.arch)
  const helperPath = writeLayout(packageRoot, `prebuilds/darwin-${process.arch}`)
  const originalBytes = fs.readFileSync(helperPath)

  preparePostinstallFixture(projectRoot)
  const result = runPostinstall(projectRoot)

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /Browser tools ready/)
  assert.equal(executableMode(helperPath), 0o755)
  assert.deepEqual(fs.readFileSync(helperPath), originalBytes)

  const repairedChangeTime = changeTime(helperPath)
  const secondResult = runPostinstall(projectRoot)

  assert.equal(secondResult.status, 0, `${secondResult.stdout}\n${secondResult.stderr}`)
  assert.equal(changeTime(helperPath), repairedChangeTime, 'A second run must not chmod an already-correct helper')
})

posixTest.each(['arm64', 'x64'] as const)('repairs the supported Darwin %s prebuild contract', arch => {
  // Explicit platform/architecture data and a synthetic native loader; not native macOS evidence.
  const projectRoot = makeTemporaryDirectory(`hermes-node-pty-${arch}-`)
  const packageRoot = installNodePtyFixture(projectRoot, arch)
  const helperPath = writeLayout(packageRoot, `prebuilds/darwin-${arch}`)
  const originalBytes = fs.readFileSync(helperPath)
  const result = runRepair(projectRoot, 'darwin', arch)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(executableMode(helperPath), 0o755)
  assert.deepEqual(fs.readFileSync(helperPath), originalBytes)
  const repairedChangeTime = changeTime(helperPath)
  const second = runRepair(projectRoot, 'darwin', arch)

  assert.equal(second.status, 0, second.stderr)
  assert.equal(changeTime(helperPath), repairedChangeTime)
})

posixTest('repairs only the Release helper when node-pty selects Release first', () => {
  const projectRoot = makeTemporaryDirectory('hermes-node-pty-release-')
  const packageRoot = installNodePtyFixture(projectRoot)
  const releaseHelper = writeLayout(packageRoot, 'build/Release')
  const debugHelper = writeLayout(packageRoot, 'build/Debug')
  const prebuildHelper = writeLayout(packageRoot, 'prebuilds/darwin-arm64')
  const unrelatedPath = path.join(packageRoot, 'build', 'Release', 'unrelated-file')

  fs.writeFileSync(unrelatedPath, 'unrelated-bytes')
  fs.chmodSync(unrelatedPath, 0o640)
  const initialDebugMode = executableMode(debugHelper)
  const initialPrebuildMode = executableMode(prebuildHelper)
  const initialUnrelatedMode = executableMode(unrelatedPath)
  const result = runRepair(projectRoot)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(executableMode(releaseHelper), 0o755)
  assert.equal(executableMode(debugHelper), initialDebugMode)
  assert.equal(executableMode(prebuildHelper), initialPrebuildMode)
  assert.equal(executableMode(unrelatedPath), initialUnrelatedMode)
  assert.equal(fs.readFileSync(unrelatedPath, 'utf8'), 'unrelated-bytes')
})

posixTest('follows node-pty fallback from an unloadable Release binary to Debug', () => {
  const projectRoot = makeTemporaryDirectory('hermes-node-pty-debug-')
  const packageRoot = installNodePtyFixture(projectRoot)
  const releaseHelper = writeLayout(packageRoot, 'build/Release', 'reject')
  const debugHelper = writeLayout(packageRoot, 'build/Debug')
  const prebuildHelper = writeLayout(packageRoot, 'prebuilds/darwin-arm64')
  const initialReleaseMode = executableMode(releaseHelper)
  const initialPrebuildMode = executableMode(prebuildHelper)
  const result = runRepair(projectRoot)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(executableMode(releaseHelper), initialReleaseMode)
  assert.equal(executableMode(debugHelper), 0o755)
  assert.equal(executableMode(prebuildHelper), initialPrebuildMode)
})

test.each(['linux', 'win32'])('is a no-op on %s', platform => {
  // Platform is function data, not a simulated Windows host.
  const projectRoot = makeTemporaryDirectory(`hermes-node-pty-${platform}-`)
  const packageRoot = installNodePtyFixture(projectRoot)
  const helperPath = writeLayout(packageRoot, 'prebuilds/darwin-arm64')
  const initialMode = executableMode(helperPath)
  const result = runRepair(projectRoot, platform)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(executableMode(helperPath), initialMode)
})

test('canonical root-only postinstall succeeds when node-pty is absent', () => {
  // Execute the canonical lifecycle on the actual host without a desktop dependency.
  const projectRoot = makeTemporaryDirectory('hermes-node-pty-root-only-')

  preparePostinstallFixture(projectRoot)
  const result = runPostinstall(projectRoot)

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /Browser tools ready/)
})

test('canonical postinstall does not depend on PATH npm wrappers', () => {
  const projectRoot = makeTemporaryDirectory('hermes-node-pty-npm-wrapper-')
  const bin = path.join(projectRoot, 'bin')

  preparePostinstallFixture(projectRoot)
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 86\n', { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'npm.cmd'), '@exit /b 86\r\n')
  const previousPath = process.env.PATH

  try {
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`
    const result = runPostinstall(projectRoot)

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /Browser tools ready/)
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = previousPath
    }
  }
})

test('root-only repair ignores an unrelated node-pty package above the project', () => {
  const fixtureRoot = makeTemporaryDirectory('hermes-node-pty-ancestor-')
  const projectRoot = path.join(fixtureRoot, 'root-only project')
  const ancestorPackage = installNodePtyFixture(fixtureRoot)
  const ancestorHelper = writeLayout(ancestorPackage, 'prebuilds/darwin-arm64')
  const initialMode = executableMode(ancestorHelper)

  fs.mkdirSync(projectRoot)
  writeJson(path.join(projectRoot, 'package.json'), { name: 'root-only-fixture', private: true })
  const result = runRepair(projectRoot)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(executableMode(ancestorHelper), initialMode)
})

test('fails when the selected native layout has no required helper', () => {
  const projectRoot = makeTemporaryDirectory('hermes-node-pty-missing-helper-')
  const packageRoot = installNodePtyFixture(projectRoot)
  const releaseHelper = writeLayout(packageRoot, 'build/Release', 'load', false)
  const prebuildHelper = writeLayout(packageRoot, 'prebuilds/darwin-arm64')
  const initialPrebuildMode = executableMode(prebuildHelper)
  const result = runRepair(projectRoot)

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /spawn-helper|ENOENT/)
  assert.equal(fs.existsSync(releaseHelper), false)
  assert.equal(executableMode(prebuildHelper), initialPrebuildMode)
})

test('fails when the selected helper is not a regular file', () => {
  const projectRoot = makeTemporaryDirectory('hermes-node-pty-invalid-helper-')
  const packageRoot = installNodePtyFixture(projectRoot)
  const helperPath = writeLayout(packageRoot, 'prebuilds/darwin-arm64', 'load', false)

  fs.mkdirSync(helperPath)
  const result = runRepair(projectRoot)

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /must be a regular file/)
})

posixTest('rejects a symlinked helper without modifying its target', () => {
  const projectRoot = makeTemporaryDirectory('hermes-node-pty-helper-link-')
  const packageRoot = installNodePtyFixture(projectRoot)
  const helperPath = writeLayout(packageRoot, 'prebuilds/darwin-arm64', 'load', false)
  const targetRoot = makeTemporaryDirectory('hermes-node-pty-link-target-')
  const targetPath = path.join(targetRoot, 'outside-helper')

  fs.writeFileSync(targetPath, 'outside-bytes')
  fs.chmodSync(targetPath, 0o644)
  const initialMode = executableMode(targetPath)
  fs.symlinkSync(targetPath, helperPath)
  const result = runRepair(projectRoot)

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /symlink/)
  assert.equal(executableMode(targetPath), initialMode)
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'outside-bytes')
})

posixTest('rejects a symlinked selected directory without modifying files outside the package', () => {
  const projectRoot = makeTemporaryDirectory('hermes-node-pty-directory-link-')
  const packageRoot = installNodePtyFixture(projectRoot)
  const targetRoot = makeTemporaryDirectory('hermes-node-pty-directory-target-')
  const externalHelper = writeLayout(targetRoot, '.')
  const prebuildRoot = path.join(packageRoot, 'prebuilds')
  const initialMode = executableMode(externalHelper)

  fs.mkdirSync(prebuildRoot, { recursive: true })
  fs.symlinkSync(targetRoot, path.join(prebuildRoot, 'darwin-arm64'), 'dir')
  const result = runRepair(projectRoot)

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /symlink/)
  assert.equal(executableMode(externalHelper), initialMode)
})

posixTest('rejects a node-pty package resolved outside the project', () => {
  const projectRoot = makeTemporaryDirectory('hermes-node-pty-package-link-')
  const externalRoot = makeTemporaryDirectory('hermes-node-pty-package-target-')
  const externalPackage = installNodePtyFixture(externalRoot)
  const externalHelper = writeLayout(externalPackage, 'prebuilds/darwin-arm64')
  const initialMode = executableMode(externalHelper)

  fs.mkdirSync(path.join(projectRoot, 'node_modules'), { recursive: true })
  fs.symlinkSync(externalPackage, path.join(projectRoot, 'node_modules', 'node-pty'), 'dir')
  const result = runRepair(projectRoot)

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /outside the project/)
  assert.equal(executableMode(externalHelper), initialMode)
})

posixTest.each([
  'build/Release',
  'build/Debug',
  'prebuilds/darwin-arm64',
  'lib/build/Release',
  'lib/build/Debug',
  'lib/prebuilds/darwin-arm64',
])('rejects external native loading before touching a symlinked candidate: %s', layout => {
  const projectRoot = makeTemporaryDirectory('hermes-node-pty-preflight-')
  const packageRoot = installNodePtyFixture(projectRoot)
  const externalRoot = makeTemporaryDirectory('hermes-node-pty-external-native-')
  const externalHelper = writeLayout(externalRoot, '.')
  const candidate = path.join(packageRoot, layout)
  const initialMode = executableMode(externalHelper)

  fs.mkdirSync(path.dirname(candidate), { recursive: true })
  fs.symlinkSync(externalRoot, candidate, 'dir')
  const result = runRepair(projectRoot)

  assert.notEqual(result.status, 0)
  assert.equal(fs.existsSync(path.join(projectRoot, 'native-loads.jsonl')), false, 'Reject before ANY native loader execution')
  assert.match(result.stderr, /symlink/)
  assert.equal(executableMode(externalHelper), initialMode)
})

test('fails instead of skipping a present but broken node-pty package', () => {
  const projectRoot = makeTemporaryDirectory('hermes-node-pty-broken-')

  fs.mkdirSync(path.join(projectRoot, 'node_modules', 'node-pty'), { recursive: true })
  const result = runRepair(projectRoot)

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /present but its package manifest cannot be resolved/)
})
