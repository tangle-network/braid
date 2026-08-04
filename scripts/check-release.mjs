import { readFile } from 'node:fs/promises'
import { REQUIRED_CHECKS } from './release-check-catalog.mjs'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const composition = await readFile(new URL('../src/app/composition.ts', import.meta.url), 'utf8')
const requiredScripts = [
  ...new Set(
    [...REQUIRED_CHECKS.values()].map(({ command }) => {
      if (!command.startsWith('pnpm ')) throw new Error(`Invalid release command: ${command}`)
      return command.slice('pnpm '.length)
    }),
  ),
]
const missingScripts = requiredScripts.filter(
  (name) => typeof packageJson.scripts?.[name] !== 'string',
)
if (missingScripts.length > 0) {
  throw new Error(`Missing stable release scripts: ${missingScripts.join(', ')}`)
}
if (composition.includes('new MemoryJournal')) {
  throw new Error('Production composition must depend on JournalPort, not MemoryJournal')
}
if (packageJson.dependencies?.['better-sqlite3-multiple-ciphers'] !== '12.11.1') {
  throw new Error('Production storage must pin better-sqlite3-multiple-ciphers@12.11.1')
}

const requiredFiles = [
  'src/app/effect-coordinator.ts',
  'src/ports/effect-storage.ts',
  'src/domain/entities.ts',
  'src/domain/invariants.ts',
  'src/adapters/storage/sqlite.ts',
  'src/adapters/storage/sqlite-driver.ts',
  'src/adapters/credentials/os.ts',
  'docs/decisions/004-application-effect-coordination.md',
  'docs/decisions/005-encrypted-sqlite-and-credential-boundaries.md',
]
for (const path of requiredFiles) {
  await readFile(new URL(`../${path}`, import.meta.url))
}

process.stdout.write(
  `W5 release contract: ${requiredScripts.length} stable scripts, ${requiredFiles.length} durable-core artifacts, live checks explicitly external\n`,
)
