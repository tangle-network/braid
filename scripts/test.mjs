import { spawnSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTestDist, removeTestDist } from './test-dist.mjs'
import { prepareProofTools } from './build-proof-tools.mjs'

const repository = resolve(fileURLToPath(new URL('../', import.meta.url)))
const args = process.argv.slice(2).filter((argument) => argument !== '--')
if (args.includes('--list')) await import('./run-tests.mjs')
const startedAt = performance.now()
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
  await prepareProofTools({ force: true })
  run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.proof-tools.json', '--noEmit'])
  run(process.execPath, ['scripts/clean-tests.mjs'])
  run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.test.json', '--outDir', testDist])
  run(process.execPath, ['scripts/run-tests.mjs', ...args])
  if (!args.includes('--scope') && !args.includes('--list')) {
    run(process.execPath, [
      '--test',
      'scripts/live-bridge/process.test.mjs',
      'scripts/release/live-evidence-binding.test.mjs',
      'scripts/release/publish-gate.test.mjs',
      'scripts/release/registry-collision.test.mjs',
      'scripts/release/release-collector.test.mjs',
    ])
  }
  if (!args.includes('--list')) run(process.execPath, ['scripts/test-release-evidence.mjs'])
} catch (error) {
  failure = error
} finally {
  await removeTestDist(testDist)
}

if (!args.includes('--list')) {
  const files = (
    await Promise.all(
      ['test', 'scripts'].map(async (directory) =>
        (await readdir(resolve(repository, directory), { recursive: true }))
          .filter((name) => /\.test\.(?:ts|mjs)$/u.test(name))
          .map((name) => resolve(repository, directory, name)),
      ),
    )
  ).flat()
  const lines = await Promise.all(
    files.map(async (file) => (await readFile(file, 'utf8')).trimEnd().split('\n').length),
  )
  process.stdout.write(
    `BRAID_TEST_SUMMARY=${JSON.stringify({
      testFiles: files.length,
      testLines: lines.reduce((total, count) => total + count, 0),
      wallSeconds: (performance.now() - startedAt) / 1_000,
      status: failure ? 'failed' : 'passed',
    })}\n`,
  )
}

if (failure) {
  if (Number.isInteger(failure.exitCode)) process.exitCode = failure.exitCode
  else throw failure
}
