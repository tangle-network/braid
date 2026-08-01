import { readFile, readdir } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'

const root = new URL('../', import.meta.url)
const sourceRoot = new URL('../src/', import.meta.url)
const forbiddenApplications = [
  '@earendil-works/pi-coding-agent',
  '@moonshot-ai/',
  '@opencode-ai/',
  '@nousresearch/',
]
const forbiddenViewImports = [
  '@tangle-network/agent-runtime',
  '@tangle-network/agent-eval',
  '@tangle-network/sandbox',
  'node:',
  '/adapters/',
  '/ports/',
]

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? filesUnder(path) : [path]
    }),
  )
  return nested.flat()
}

const violations = []
for (const file of await filesUnder(sourceRoot.pathname)) {
  if (extname(file) !== '.ts') continue
  const source = await readFile(file, 'utf8')
  const path = relative(root.pathname, file)

  for (const forbidden of forbiddenApplications) {
    if (source.includes(forbidden)) violations.push(`${path}: imports forbidden app ${forbidden}`)
  }

  if (path.startsWith('src/views/')) {
    for (const forbidden of forbiddenViewImports) {
      if (source.includes(forbidden)) violations.push(`${path}: view imports ${forbidden}`)
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`${violations.join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('Dependency boundaries: pass\n')
}
