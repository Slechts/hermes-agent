import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { test } from 'vitest'

interface LockedPackage {
  version?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

const root = path.resolve(import.meta.dirname, '..')

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const packages: Record<string, LockedPackage> = JSON.parse(
  fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')
).packages

function lockedDependency(owner: string, name: string) {
  const searchPaths = createRequire(path.join(root, owner, 'package.json')).resolve.paths(name) ?? []

  for (const searchPath of searchPaths) {
    const relative = path.relative(root, path.join(searchPath, name))

    if (relative.startsWith('..') || path.isAbsolute(relative)) {continue}
    const location = relative.split(path.sep).join('/')
    const entry = packages[location]

    if (entry) {return { location, entry }}
  }
}

test('every Lightning CSS wrapper resolves its exact declared native bindings', () => {
  const wrappers = Object.entries(packages).filter(([location]) =>
    location.endsWith('node_modules/lightningcss')
  )

  assert.ok(wrappers.length > 0, 'Expected Lightning CSS in the build graph')
  const problems: string[] = []

  for (const [owner, entry] of wrappers) {
    const bindings = Object.entries(entry.optionalDependencies ?? {}).filter(([name]) =>
      name.startsWith('lightningcss-')
    )

    assert.ok(bindings.length > 0, `Missing native binding declarations: ${owner}`)

    for (const [name, required] of bindings) {
      const actual = lockedDependency(owner, name)?.entry.version

      if (actual !== required) {problems.push(`${owner}: ${name} requires ${required}, resolves ${actual}`)}
    }
  }

  assert.deepEqual(problems, [], 'Native binding resolutions must match their owning wrapper')
})

test('Rolldown 1.2.1 pins the last runtime compatible with its alpha.3 peers', () => {
  // Runtime 1.2.3 raises its peer floor to alpha.4, but this binding pins
  // @emnapi/core and @emnapi/runtime to alpha.3. Keep the override scoped.
  assert.deepEqual(manifest.overrides['@rolldown/binding-wasm32-wasi@1.2.1'], {
    '@napi-rs/wasm-runtime': '1.2.2',
  })
})

test('every Rolldown WASM fallback resolves a compatible runtime', () => {
  const owners = Object.entries(packages).filter(([location]) =>
    location.endsWith('node_modules/@rolldown/binding-wasm32-wasi')
  )

  assert.ok(owners.length > 0, 'Expected the WASM fallback in the build graph')

  for (const [owner, entry] of owners) {
    const required = entry.dependencies?.['@napi-rs/wasm-runtime']
    const runtime = lockedDependency(owner, '@napi-rs/wasm-runtime')

    assert.ok(runtime, `Missing WASM runtime for ${owner}`)

    if (entry.version === '1.2.1') {assert.equal(runtime.entry.version, '1.2.2')}
    // The published fallback uses a positive-major caret range. Fail closed
    // if that contract changes instead of pretending to implement all semver.
    const range = required?.match(/^\^([1-9]\d*)\.(\d+)\.(\d+)$/)
    const version = runtime.entry.version?.match(/^(\d+)\.(\d+)\.(\d+)$/)

    assert.ok(range && version, `Unexpected WASM runtime version contract: ${required}`)
    const [major = 0, minor = 0, patch = 0] = range.slice(1).map(Number)
    const [actualMajor = 0, actualMinor = 0, actualPatch = 0] = version.slice(1).map(Number)

    assert.ok(actualMajor === major && (actualMinor > minor || (actualMinor === minor && actualPatch >= patch)),
      `${owner}: runtime ${runtime.entry.version} does not satisfy ${required}`)

    for (const dependency of Object.keys(runtime.entry.dependencies ?? {})) {
      assert.ok(lockedDependency(runtime.location, dependency), `Missing WASM runtime dependency: ${dependency}`)
    }
  }
})
