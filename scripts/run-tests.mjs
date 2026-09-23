import { spawnSync } from 'node:child_process'
import { access, readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'

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

const requested = process.argv.slice(2)
const tests = (
  requested.length > 0
    ? requested.map((name) => join(root.pathname, name))
    : await testsUnder(root.pathname)
).sort()
if (tests.length === 0) {
  process.stderr.write('No compiled tests found\n')
  process.exit(1)
}

for (const test of tests) {
  try {
    await access(test)
  } catch {
    process.stderr.write(`Compiled test not found: ${test}\n`)
    process.exit(1)
  }
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', test], {
    stdio: 'inherit',
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
