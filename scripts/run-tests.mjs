import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'

const root = new URL('../.test-dist/test/', import.meta.url)

async function testsUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return testsUnder(path)
      return extname(path) === '.js' && path.endsWith('.test.js') ? [path] : []
    }),
  )
  return nested.flat()
}

const tests = (await testsUnder(root.pathname)).sort()
if (tests.length === 0) {
  process.stderr.write('No compiled tests found\n')
  process.exit(1)
}

const scopeIndex = process.argv.indexOf('--scope')
const scope = scopeIndex === -1 ? undefined : process.argv[scopeIndex + 1]
if (scopeIndex !== -1 && !scope) {
  process.stderr.write('--scope requires a test scope\n')
  process.exit(1)
}

const scopeFiles = {
  unit: [
    'application.test.js',
    'coordination.test.js',
    'domain-ids.test.js',
    'domain-invariants.test.js',
    'domain-reducer.test.js',
    'reducer.test.js',
    'sanitize.test.js',
    'scripts.test.js',
  ],
  contract: [
    'application.test.js',
    'coordination.test.js',
    'domain-invariants.test.js',
    'domain-reducer.test.js',
    'reducer.test.js',
    'scripts.test.js',
  ],
  coordination: ['coordination.test.js', 'effect-admission.test.js'],
  rpc: ['rpc.test.js'],
  'virtual-terminal': ['tui.test.js'],
  storage: [
    'coordination.test.js',
    'effect-admission.test.js',
    'storage.test.js',
    'domain-reducer.test.js',
    'storage-crash.test.js',
  ],
  security: ['coordination.test.js', 'sanitize.test.js', 'storage.test.js', 'security.test.js'],
  crash: ['storage.test.js', 'storage-crash.test.js'],
  performance: ['coordination.test.js', 'reducer.test.js', 'storage-performance.test.js'],
}
const selectedTests =
  scope === undefined
    ? tests
    : tests.filter((path) => scopeFiles[scope]?.includes(relative(root.pathname, path)))
if (scope !== undefined && selectedTests.length === 0) {
  process.stderr.write(`No compiled tests registered for scope ${scope}\n`)
  process.exit(1)
}

const nativeStorageRequired = selectedTests.some(
  (path) =>
    path.endsWith('/storage.test.js') ||
    path.endsWith('/storage-crash.test.js') ||
    path.endsWith('/storage-performance.test.js') ||
    path.endsWith('/effect-admission.test.js'),
)
if (nativeStorageRequired) {
  try {
    createRequire(import.meta.url).resolve('better-sqlite3-multiple-ciphers')
  } catch {
    process.stderr.write(
      'W5_NATIVE_STORAGE_BLOCKED: better-sqlite3-multiple-ciphers@12.11.1 is not installed; install dependencies with lifecycle scripts before running storage or crash tests\n',
    )
    process.exit(2)
  }
}

const result = spawnSync(process.execPath, ['--test', ...selectedTests], { stdio: 'inherit' })
process.exit(result.status ?? 1)
