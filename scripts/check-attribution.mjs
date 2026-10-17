import { readFile, readdir } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
// agent-interface 5.7 under a development alias: the agent-runtime cohort pins agent-interface below 5.3.
import { verifyResourceProvenance } from '@tangle-network/agent-interface-current'

const root = new URL('../', import.meta.url)
const notice = await readFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8')
const sourceRoots = [new URL('../src/', import.meta.url), new URL('../test/', import.meta.url)]

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? filesUnder(path) : [path]
    }),
  )
  return nested.flat()
}

const violations = []
const verified = []
for (const sourceRoot of sourceRoots) {
  for (const file of await filesUnder(sourceRoot.pathname)) {
    if (!['.ts', '.tsx'].includes(extname(file))) continue
    const source = await readFile(file, 'utf8')
    if (!source.includes('@derived-from')) continue
    const path = relative(root.pathname, file)
    const required = ['@source-commit', '@source-path', '@source-license']
    for (const marker of required) {
      if (!source.includes(marker)) violations.push(`${path}: missing ${marker}`)
    }
    if (!notice.includes(`| \`${path}\` |`)) violations.push(`${path}: missing notice row`)
    // A copied profile that records resource provenance must still match it: an edited inline skill or an
    // unpinned ref would change the published profile without changing its recorded source.
    if (source.includes('resourceProvenance')) {
      const profile = (await import(pathToFileURL(file).href)).default
      const problems = await verifyResourceProvenance(profile)
      for (const problem of problems) violations.push(`${path}: ${problem}`)
      if (problems.length === 0) verified.push(path)
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`${violations.join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(
    `Copied-source attribution: pass${verified.length === 0 ? '' : `; resource provenance holds in ${verified.join(', ')}`}\n`,
  )
}
