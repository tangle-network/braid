import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'

const target = new URL('../THIRD_PARTY_LICENSES.json', import.meta.url)
const raw = execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
  cwd: new URL('../', import.meta.url),
  encoding: 'utf8',
})
const groups = JSON.parse(raw)
const packages = Object.entries(groups)
  .flatMap(([license, entries]) =>
    entries.map((entry) => ({
      license,
      name: entry.name,
      version: entry.version,
    })),
  )
  .sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  )
const output = `${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n`

if (process.argv.includes('--check')) {
  const current = await readFile(target, 'utf8').catch(() => '')
  if (current !== output) {
    process.stderr.write('THIRD_PARTY_LICENSES.json is stale; run pnpm licenses:generate\n')
    process.exitCode = 1
  } else {
    process.stdout.write(`License inventory: ${packages.length} packages\n`)
  }
} else {
  await writeFile(target, output)
  process.stdout.write(`Wrote ${packages.length} package licenses\n`)
}
