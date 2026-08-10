import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTestDist, removeTestDist } from './test-dist.mjs'

const repository = resolve(fileURLToPath(new URL('../', import.meta.url)))
const args = process.argv.slice(2).filter((argument) => argument !== '--')
const testDist = await createTestDist('test')
const environment = { ...process.env, BRAID_TEST_DIST: testDist }

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: repository,
    env: environment,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const error = new Error(`${command} exited with status ${String(result.status)}`)
    error.exitCode = result.status ?? 1
    throw error
  }
}

let failure
try {
  run(process.execPath, ['scripts/clean-tests.mjs'])
  run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.test.json', '--outDir', testDist])
  run(process.execPath, ['scripts/run-tests.mjs', ...args])
  if (!args.includes('--list')) run(process.execPath, ['scripts/test-release-evidence.mjs'])
} catch (error) {
  failure = error
} finally {
  await removeTestDist(testDist)
}

if (failure) {
  if (Number.isInteger(failure.exitCode)) process.exitCode = failure.exitCode
  else throw failure
}
