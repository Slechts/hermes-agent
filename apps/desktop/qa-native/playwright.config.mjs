import os from 'node:os'
import path from 'node:path'

import { defineConfig } from '@playwright/test'


const outputDir = process.env.QA_NATIVE_OUTPUT_DIR
  ?? path.join(os.tmpdir(), 'hermes-native-qa-playwright')
const resultsJson = process.env.QA_NATIVE_RESULTS_JSON
  ?? path.join(outputDir, 'playwright-results.json')

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: 'native-candidate.spec.mjs',
  outputDir: path.join(outputDir, 'test-results'),
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['json', { outputFile: resultsJson }],
  ],
})
