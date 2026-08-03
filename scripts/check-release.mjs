import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const composition = await readFile(new URL('../src/app/composition.ts', import.meta.url), 'utf8')
const requiredScripts = [
  'test:unit',
  'test:contract',
  'test:coordination',
  'test:rpc',
  'test:virtual-terminal',
  'test:pty',
  'test:storage',
  'test:crash',
  'test:security',
  'test:performance',
  'test:live',
  'test:install',
  'test:capture',
  'check:release',
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
