import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { test } from 'vitest'

interface Step {
  name?: string
  uses?: string
  run?: string
  if?: string
  env?: Record<string, unknown>
  with?: Record<string, unknown>
  'continue-on-error'?: boolean
}

interface NativeJob {
  if?: string
  container?: unknown
  environment?: unknown
  env?: Record<string, unknown>
  permissions?: Record<string, string>
  'runs-on'?: string
  services?: unknown
  'timeout-minutes'?: number
  strategy?: {
    'fail-fast'?: boolean
    matrix?: { include?: Array<Record<string, string>> }
  }
  steps?: Step[]
}

interface Workflow {
  name?: string
  env?: Record<string, unknown>
  on?: Record<string, unknown>
  permissions?: Record<string, string>
  jobs?: Record<string, NativeJob>
}

const root = path.resolve(import.meta.dirname, '..')
const workflowPath = path.join(root, '.github/workflows/native-dependency-checks.yml')
const probePath = path.join(root, 'scripts/ci/native-dependency-probe.mjs')
const yaml: { load(source: string): unknown } = createRequire(import.meta.url)('js-yaml')

function loadWorkflow(): Workflow {
  assert.ok(fs.existsSync(workflowPath), `Required workflow is missing: ${workflowPath}`)

  return yaml.load(fs.readFileSync(workflowPath, 'utf8')) as Workflow
}

function stepNamed(job: NativeJob, name: string): Step {
  const matches = job.steps?.filter((step) => step.name === name) ?? []
  assert.equal(matches.length, 1, `Expected exactly one ${name} step`)

  return matches[0]!
}

function assertPolicy(workflow: Workflow) {
  assert.equal(workflow.name, 'Native dependency checks')
  assert.deepEqual(workflow.on, {
    pull_request: {
      types: ['opened', 'synchronize', 'reopened'],
      branches: ['main'],
    },
  })
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.equal(workflow.env, undefined)
  assert.deepEqual(Object.keys(workflow.jobs ?? {}), ['native-dependencies'])

  const job = workflow.jobs?.['native-dependencies']
  assert.ok(job)
  assert.equal(job.if,
    "github.event_name == 'pull_request' && github.repository == 'Slechts/hermes-agent' && " +
    "github.event.pull_request.head.repo.full_name == 'Slechts/hermes-agent' && " +
    "github.event.pull_request.head.ref == 'fix/npm-tar-native-graph-20260909'")
  assert.equal(job['runs-on'], '${{ matrix.runner }}')
  assert.ok((job['timeout-minutes'] ?? 0) > 0 && (job['timeout-minutes'] ?? 0) <= 45)
  assert.equal(job.strategy?.['fail-fast'], false)
  assert.deepEqual(job.strategy?.matrix?.include, [
    { runner: 'ubuntu-24.04', platform: 'linux', arch: 'x64' },
    { runner: 'windows-2025', platform: 'win32', arch: 'x64' },
    { runner: 'macos-15', platform: 'darwin', arch: 'arm64' },
  ])
  assert.equal(job.environment, undefined)
  assert.equal(job.env, undefined)
  assert.equal(job.permissions, undefined)
  assert.equal(job.services, undefined)
  assert.equal(job.container, undefined)
  assert.equal(job.steps?.length, 6)

  const canonical = stepNamed(job, 'Keep canonical checkout bytes')
  assert.equal(canonical.run, 'git config --global core.autocrlf false')
  assert.equal(canonical.if, undefined)
  assert.equal(job.steps?.[0], canonical, 'Canonical configuration must precede checkout')

  const checkout = job.steps?.find((step) => step.uses?.startsWith('actions/checkout@'))
  assert.ok(checkout)
  assert.equal(job.steps?.[1], checkout)
  assert.equal(checkout.uses, 'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd')
  assert.deepEqual(checkout.with, {
    ref: '${{ github.event.pull_request.head.sha }}',
    'persist-credentials': false,
  })

  const setup = job.steps?.find((step) => step.uses?.startsWith('actions/setup-node@'))
  assert.ok(setup)
  assert.equal(setup.uses, 'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38')
  assert.equal(setup.with?.['node-version'], '22.23.1')
  assert.equal(setup.with?.cache, 'npm')

  const pinNpm = stepNamed(job, 'Pin npm 10.9.8')
  assert.equal(pinNpm.run, 'npm install --global npm@10.9.8')

  const proof = stepNamed(job, 'Run native dependency proof')
  assert.equal(proof.if, undefined)
  assert.equal(proof['continue-on-error'], undefined)

  for (const token of [
    'scripts/ci/native-dependency-probe.mjs ci',
    '--expected-platform ${{ matrix.platform }}',
    '--expected-arch ${{ matrix.arch }}',
    '--expected-node 22.23.1',
    '--expected-npm 10.9.8',
    '--expected-sha ${{ github.event.pull_request.head.sha }}',
    '--output "${{ runner.temp }}/native-dependency-proof/receipt.json"',
  ]) {
    assert.ok(proof.run?.includes(token), `Proof step is missing ${token}`)
  }

  assert.equal(proof.run, [
    'node scripts/ci/native-dependency-probe.mjs ci',
    '--expected-platform ${{ matrix.platform }}',
    '--expected-arch ${{ matrix.arch }}',
    '--expected-node 22.23.1',
    '--expected-npm 10.9.8',
    '--expected-sha ${{ github.event.pull_request.head.sha }}',
    '--output "${{ runner.temp }}/native-dependency-proof/receipt.json"',
  ].join(' '))

  const upload = job.steps?.find((step) => step.uses?.startsWith('actions/upload-artifact@'))
  assert.ok(upload)
  assert.equal(upload.uses, 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a')
  assert.equal(upload.if, 'always()')
  assert.equal(upload['continue-on-error'], undefined)
  assert.equal(upload.with?.path, '${{ runner.temp }}/native-dependency-proof')
  assert.equal(upload.with?.['retention-days'], 7)
  assert.equal(upload.with?.['if-no-files-found'], 'error')
  assert.ok(String(upload.with?.name).includes('${{ github.event.pull_request.head.sha }}'))
  assert.ok(!String(upload.with?.name).startsWith('e2e-evidence'))

  for (const step of job.steps ?? []) {
    assert.equal(step.env, undefined, `${step.name ?? step.uses} must not receive privileged env`)
    assert.equal(step['continue-on-error'], undefined, `${step.name ?? step.uses} must fail closed`)

    for (const value of Object.values(step.with ?? {})) {
      assert.ok(!String(value).includes('secrets.'), 'Secrets are forbidden in this workflow')
    }
  }

  assert.ok(!JSON.stringify(workflow).includes('secrets.'), 'Secret contexts are forbidden')
}

function mutated(change: (workflow: Workflow) => void, message: RegExp) {
  const workflow = structuredClone(loadWorkflow())
  change(workflow)
  assert.throws(() => assertPolicy(workflow), message)
}

test('native dependency workflow is narrowly gated and fail-closed', () => {
  assertPolicy(loadWorkflow())
})

test('workflow policy rejects widened triggers, repositories, and heads', () => {
  mutated((workflow) => { workflow.on = { push: { branches: ['main'] } } }, /Expected values to be strictly deep-equal/)
  mutated((workflow) => { workflow.jobs!['native-dependencies']!.if = "github.event_name == 'pull_request'" }, /strictly equal/)
})

test('workflow policy rejects permissions, secrets, and privileged environments', () => {
  mutated((workflow) => { workflow.permissions = { contents: 'write' } }, /Expected values to be strictly deep-equal/)
  mutated((workflow) => { workflow.env = { TOKEN: '${{ secrets.TOKEN }}' } }, /undefined/)
  mutated((workflow) => { workflow.jobs!['native-dependencies']!.environment = 'production' }, /undefined/)
  mutated((workflow) => { stepNamed(workflow.jobs!['native-dependencies']!, 'Pin npm 10.9.8').env = { TOKEN: '${{ secrets.TOKEN }}' } }, /undefined/)
})

test('workflow policy rejects missing platform rows and skipped proof', () => {
  mutated((workflow) => { workflow.jobs!['native-dependencies']!.strategy!.matrix!.include!.pop() }, /Expected values to be strictly deep-equal/)
  mutated((workflow) => { stepNamed(workflow.jobs!['native-dependencies']!, 'Run native dependency proof').name = 'Skipped proof' }, /exactly one/)
  mutated((workflow) => { stepNamed(workflow.jobs!['native-dependencies']!, 'Run native dependency proof').if = 'false' }, /undefined/)
  mutated((workflow) => { stepNamed(workflow.jobs!['native-dependencies']!, 'Run native dependency proof')['continue-on-error'] = true }, /undefined/)
})

test('workflow policy rejects weakened result provenance', () => {
  mutated((workflow) => { stepNamed(workflow.jobs!['native-dependencies']!, 'Run native dependency proof').run = 'node scripts/ci/native-dependency-probe.mjs ci' }, /missing --expected-platform/)
  mutated((workflow) => { workflow.jobs!['native-dependencies']!.steps!.find((step) => step.uses?.startsWith('actions/upload-artifact@'))!.with!.name = 'native-dependency-proof' }, /falsy/)
})

test('canonical checkout policy rejects conversion, skipping and late configuration', () => {
  mutated((workflow) => { stepNamed(workflow.jobs!['native-dependencies']!, 'Keep canonical checkout bytes').run = 'git config --global core.autocrlf true' }, /strictly equal/)
  mutated((workflow) => { stepNamed(workflow.jobs!['native-dependencies']!, 'Keep canonical checkout bytes').if = 'false' }, /undefined/)
  mutated((workflow) => {
    const steps = workflow.jobs!['native-dependencies']!.steps!
    const first = steps.shift()!
    steps.splice(1, 0, first)
  }, /must precede checkout/)
})

test('canonical checkout command preserves source bytes despite inherited CRLF defaults', () => {
  const command = stepNamed(loadWorkflow().jobs!['native-dependencies']!, 'Keep canonical checkout bytes').run!
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'native-checkout-'))
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(temporary, 'global.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
  const source = '#!/usr/bin/env node\nexport const canonical = true\n'
  const fixture = path.join(temporary, 'fixture.mjs')

  function git(args: string[], input?: string) {
    const run = spawnSync('git', args, { cwd: temporary, env, input, encoding: 'utf8', timeout: 10000 })
    assert.equal(run.status, 0, run.stdout + run.stderr)

    return run.stdout.trim()
  }

  try {
    git(['init', '--quiet'])
    git(['config', '--global', 'core.autocrlf', 'true'])
    const blob = git(['hash-object', '-w', '--stdin'], source)
    git(['update-index', '--add', '--cacheinfo', '100644', blob, 'fixture.mjs'])
    git(['checkout-index', '--all', '--force'])
    assert.equal(fs.readFileSync(fixture, 'utf8'), source.replaceAll('\n', '\r\n'))
    assert.ok(command.startsWith('git '))
    git(command.split(' ').slice(1))
    git(['checkout-index', '--all', '--force'])
    assert.equal(fs.readFileSync(fixture, 'utf8'), source)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

function runRuntime(expectedPlatform = process.platform) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'native-probe-test-'))
  const output = path.join(temporary, 'receipt.json')

  const run = spawnSync(process.execPath, [
    probePath,
    'runtime',
    '--expected-platform', expectedPlatform,
    '--expected-arch', process.arch,
    '--expected-node', process.versions.node,
    '--output', output,
  ], { cwd: root, encoding: 'utf8', timeout: 15_000 })

  return { output, run, temporary }
}

test('probe runtime CLI verifies the actual host and writes provenance', () => {
  const { output, run, temporary } = runRuntime()

  try {
    assert.equal(run.status, 0, run.stdout + run.stderr)
    const receipt = JSON.parse(fs.readFileSync(output, 'utf8'))
    assert.equal(receipt.result, 'pass')
    assert.equal(receipt.runtime.platform, process.platform)
    assert.equal(receipt.runtime.arch, process.arch)
    assert.match(receipt.sourceSha, /^[0-9a-f]{40}$/)
    assert.match(receipt.lockSha256, /^[0-9a-f]{64}$/)
    assert.ok(receipt.checks.length > 0)
    assert.ok(receipt.checks.every((check: { result: string }) => check.result === 'pass'))
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

test('probe runtime CLI fails closed on a host mismatch', () => {
  const incompatible = process.platform === 'win32' ? 'linux' : 'win32'
  const { output, run, temporary } = runRuntime(incompatible)

  try {
    assert.notEqual(run.status, 0)
    const receipt = JSON.parse(fs.readFileSync(output, 'utf8'))
    assert.equal(receipt.result, 'fail')
    assert.ok(receipt.checks.some((check: { result: string }) => check.result === 'fail'))
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

test('probe receipt validator rejects partial or unproven success', async () => {
  const probe = await import(pathToFileURL(probePath).href)
  assert.throws(() => probe.validateReceipt({ result: 'pass', checks: [] }), /complete passing checks/)
  assert.throws(() => probe.validateReceipt({
    result: 'pass',
    mode: 'functional',
    sourceSha: 'a'.repeat(40),
    lockSha256: 'b'.repeat(64),
    runtime: { platform: 'linux', arch: 'arm64', node: '22.23.1', npm: '10.9.8' },
    checks: [{ name: 'runtime identity and provenance', result: 'pass' }],
    markers: ['runtime identity and provenance'],
  }), /every required check/)
})

test('npm invocation uses a Windows shell only for fixed safe arguments', async () => {
  const probe = await import(pathToFileURL(probePath).href)
  assert.equal(typeof probe.npmInvocation, 'function', 'Cross-platform npm invocation is missing')
  const args = ['run', 'check', '--workspace', 'tests-js']
  assert.deepEqual(probe.npmInvocation(args, 'win32'), { command: 'npm.cmd', args, options: { shell: true } })
  assert.deepEqual(probe.npmInvocation(args, 'linux'), { command: 'npm', args, options: { shell: false } })
  assert.throws(() => probe.npmInvocation(['ci; whoami'], 'win32'), /Unsafe npm argument/)
})

test('Rolldown discovery normalizes Windows paths before filtering', async () => {
  const probe = await import(pathToFileURL(probePath).href)
  assert.equal(typeof probe.rolldownBindings, 'function', 'Portable binding discovery is missing')

  const expected = [
    'C:/repo/node_modules/@rolldown/binding-win32-x64-msvc/rolldown.node',
    'C:/repo/node_modules/@rolldown/binding-wasm32-wasi/rolldown.wasi.cjs',
    'C:/repo/node_modules/@napi-rs/wasm-runtime/dist/index.js',
  ]

  for (const separator of ['/', '\\']) {
    const keys = [...expected, 'C:/repo/node_modules/unrelated/index.js']
      .map((key) => key.replaceAll('/', separator))

    assert.deepEqual(probe.rolldownBindings(keys), expected)
  }
})

test('node-pre-gyp installs the real synthetic archive from a spaced fixture path', async () => {
  const probe = await import(pathToFileURL(probePath).href)
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'native fixture-'))
  const content = Buffer.from('Synthetic archive test; not a native binary')
  const source = path.join(fixture, 'source/package')
  const tar = createRequire(import.meta.url)('tar')
  const mirrorKey = 'npm_config_node_get-windows_binary_host_mirror'
  const previousMirror = process.env[mirrorKey]

  try {
    fs.mkdirSync(source, { recursive: true })
    fs.writeFileSync(path.join(source, 'node-get-windows.node'), content)
    await tar.create({ file: path.join(fixture, 'payload-9.tar.gz'), gzip: true,
      cwd: path.join(fixture, 'source') }, ['package'])
    const result = await probe.installSyntheticArchive(fixture)
    assert.equal(result.transport, 'loopback-http-fixture')
    assert.equal(result.requests, 1)
    assert.equal(result.fallbackToBuild, false)
    assert.deepEqual(fs.readFileSync(path.join(fixture, 'pre-gyp-9/node-get-windows.node')), content)
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
    assert.ok(process.env[mirrorKey] === previousMirror, 'Fixture mirror environment was not restored')
  }
})
