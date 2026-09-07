import fs from 'node:fs'
import path from 'node:path'

import { expect, test } from 'vitest'

interface LockedPackage {
  version?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

const root = path.resolve(import.meta.dirname, '..')

const packages: Record<string, LockedPackage> = JSON.parse(
  fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')
).packages

// Resolve lock locations using Node's ancestor lookup, not a package-name scan:
// a correct version in an unrelated workspace cannot satisfy this edge.
function resolveDependency(from: string, name: string): LockedPackage | undefined {
  let directory = from

  for (;;) {
    if (path.posix.basename(directory) !== 'node_modules') {
      const candidate = packages[path.posix.join(directory, 'node_modules', name)]

      if (candidate) {return candidate}
    }

    if (!directory || directory === '.') {return undefined}
    const parent = path.posix.dirname(directory)
    directory = parent === '.' ? '' : parent
  }
}

test('each Lightning CSS wrapper resolves its exact native binding versions in the lock', () => {
  const wrappers = Object.entries(packages).filter(([location]) =>
    location.endsWith('node_modules/lightningcss')
  )

  expect(wrappers.length).toBeGreaterThan(0)

  for (const [location, wrapper] of wrappers) {
    const bindings = Object.entries(wrapper.optionalDependencies ?? {})
    expect(bindings.length).toBeGreaterThan(0)

    for (const [name, version] of bindings) {
      expect(resolveDependency(location, name)?.version, `${location} -> ${name}`).toBe(version)
    }
  }
})

test('the Rolldown WASM fallback keeps all its required dependencies resolvable', () => {
  const rolldowns = Object.entries(packages).filter(([location]) =>
    location.endsWith('node_modules/rolldown')
  )

  expect(rolldowns.length).toBeGreaterThan(0)

  for (const [location, rolldown] of rolldowns) {
    const name = '@rolldown/binding-wasm32-wasi'
    const expected = rolldown.optionalDependencies?.[name]
    expect(expected).toBeTruthy()
    const fallback = resolveDependency(location, name)
    expect(fallback?.version).toBe(expected)
  }

  const fallbacks = Object.entries(packages).filter(([location]) =>
    location.endsWith('node_modules/@rolldown/binding-wasm32-wasi')
  )

  expect(fallbacks.length).toBeGreaterThan(0)

  for (const [location, fallback] of fallbacks) {
    const dependencies = Object.keys(fallback.dependencies ?? {})
    expect(dependencies.length).toBeGreaterThan(0)

    for (const name of dependencies) {
      expect(resolveDependency(location, name)?.version, `${location} -> ${name}`).toBeTruthy()
    }
  }
})
