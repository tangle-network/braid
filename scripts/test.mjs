import { spawnSync } from 'node:child_process'

const repository = new URL('../', import.meta.url).pathname
const args = process.argv.slice(2).filter((argument) => argument !== '--')

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: repository,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (args.includes('--list')) {
  run(process.execPath, ['scripts/run-tests.mjs', ...args])
} else {
  run(process.execPath, ['scripts/clean-tests.mjs'])
  run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.test.json'])
  run(process.execPath, ['scripts/run-tests.mjs', ...args])
  run(process.execPath, ['scripts/test-release-evidence.mjs'])
}
