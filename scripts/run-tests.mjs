import { spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
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

const tests = (await testsUnder(root.pathname)).sort()
if (tests.length === 0) {
  process.stderr.write('No compiled tests found\n')
  process.exit(1)
}

const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' })
process.exit(result.status ?? 1)
