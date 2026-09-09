import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { test } from 'vitest'

interface LockedPackage {
  version?: string
}

const root = path.resolve(import.meta.dirname, '..')

const packages: Record<string, LockedPackage> = JSON.parse(
  fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')
).packages

const tarEntries = Object.entries(packages).filter(([location]) =>
  location.endsWith('node_modules/tar')
)

test('no concrete tar resolution is below the known security floor', () => {
  // GHSA-23hp-3jrh-7fpw affects <=7.5.18; GHSA-r292-9mhp-454m affects
  // <=7.5.20. A safe hoisted copy does not protect nested installers.
  assert.ok(tarEntries.length > 0, 'Expected tar in the native build toolchain')
  const affected: Record<string, string | undefined> = {}

  for (const [location, entry] of tarEntries) {
    const stable = entry.version?.match(/^(\d+)\.(\d+)\.(\d+)$/)
    const [major = 0, minor = 0, patch = 0] = stable?.slice(1).map(Number) ?? []
    const patched = major > 7 || (major === 7 && (minor > 5 || (minor === 5 && patch >= 21)))

    if (!stable || !patched) {affected[location] = entry.version}
  }

  assert.deepEqual(affected, {}, 'Unsafe tar resolutions remain in the lockfile')
})

test('tar has an exact override matching every concrete locked resolution', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const override = manifest.overrides?.tar

  assert.ok(typeof override === 'string' && /^\d+\.\d+\.\d+$/.test(override),
    'Pin tar explicitly so reinstall cannot restore a vulnerable parent range')
  assert.ok(tarEntries.length > 0, 'Expected tar in the native build toolchain')

  for (const [location, entry] of tarEntries) {
    assert.equal(entry.version, override, location)
  }
})
