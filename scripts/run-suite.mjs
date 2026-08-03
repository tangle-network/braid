import { execFileSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const repository = new URL('../', import.meta.url).pathname
const scope = process.argv[2] ?? 'all'
const scopeFiles = {
  unit: ['application.test.js', 'reducer.test.js', 'sanitize.test.js', 'w6-ui.test.js'],
  contract: ['w6-contract.test.js'],
  rpc: ['rpc.test.js', 'w6-contract.test.js'],
  'virtual-terminal': ['tui.test.js', 'w6-ui.test.js'],
  security: ['sanitize.test.js', 'w6-contract.test.js'],
  storage: null,
  performance: null,
  all: undefined,
}

if (!(scope in scopeFiles)) throw new Error(`Unknown test scope: ${scope}`)
if (scope === 'storage' || scope === 'performance') {
  process.stderr.write(
    `${scope} verification is unavailable in W6: the required ${scope} implementation and evidence are not present; no claim is made\n`,
  )
  process.exitCode = 2
  process.exit()
}
execFileSync(process.execPath, ['scripts/clean-tests.mjs'], { cwd: repository, stdio: 'inherit' })
execFileSync('./node_modules/.bin/tsc', ['-p', 'tsconfig.test.json'], {
  cwd: repository,
  stdio: 'inherit',
})

const compiledRoot = join(repository, '.test-dist', 'test')
const files = await readdir(compiledRoot)
const selected = scopeFiles[scope]
  ? files.filter((file) => scopeFiles[scope].includes(file))
  : files.filter((file) => file.endsWith('.test.js'))
if (selected.length === 0) throw new Error(`No compiled tests found for scope ${scope}`)
selected.sort()
process.stdout.write(`Running ${scope} suite: ${selected.join(', ')}\n`)
execFileSync(process.execPath, ['--test', ...selected.map((file) => join(compiledRoot, file))], {
  cwd: repository,
  stdio: 'inherit',
  env: { ...process.env, FORCE_COLOR: '0' },
})
