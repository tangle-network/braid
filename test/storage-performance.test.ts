import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import { openSqliteStorage } from '../src/adapters/storage/sqlite.js'
import {
  createConversationId,
  createEventId,
  createRunId,
  createWorkspaceId,
} from '../src/domain/ids.js'
import { credentialRef } from '../src/ports/credentials.js'

const require = createRequire(import.meta.url)
const sqliteAvailable = (() => {
  try {
    require('better-sqlite3-multiple-ciphers')
    return true
  } catch {
    return false
  }
})()

async function measureAppend(count: number): Promise<number> {
  const root = await mkdtemp(join(tmpdir(), `braid-storage-${count}-`))
  const storage = await openSqliteStorage({
    path: join(root, 'braid.sqlite'),
    workspaceRoot: root,
    credentialStore: new MemoryCredentialStore(),
    databaseKeyRef: credentialRef(`cred:v1:storage-performance-${count}`),
    maxEventsPerTransaction: 10_000,
  })
  const events = Array.from({ length: count }, (_, index) => ({
    workspaceId: createWorkspaceId(`workspace-performance-${count}`),
    conversationId: createConversationId(`conversation-performance-${count}`),
    runId: createRunId(`run-performance-${count}`),
    eventId: createEventId(`event-performance-${count}-${index + 1}`),
    sequence: index + 1,
    kind: index + 1 === count ? 'run.finished' : 'run.text.delta',
    payload: { n: index + 1 },
    occurredAt: '2026-08-02T00:00:00.000Z',
    terminal: index + 1 === count,
  }))
  const started = performance.now()
  for (let offset = 0; offset < events.length; offset += 10_000) {
    await storage.append(events.slice(offset, offset + 10_000))
  }
  const elapsed = performance.now() - started
  assert.equal((await storage.events()).length, count)
  assert.equal((await storage.integrity()).ok, true)
  await storage.close()
  return elapsed
}

test('native SQLite measures incremental append at 10k events', async (t) => {
  if (!sqliteAvailable) {
    throw new Error(
      'W5_NATIVE_STORAGE_BLOCKED: better-sqlite3-multiple-ciphers@13.0.3 is not installed',
    )
  }
  const elapsed = await measureAppend(10_000)
  t.diagnostic(
    `events=10000 elapsedMs=${elapsed.toFixed(2)} eventsPerSecond=${(10_000 / (elapsed / 1000)).toFixed(2)}`,
  )
})

test('native SQLite measures incremental append at 100k events', async (t) => {
  if (!sqliteAvailable) {
    throw new Error(
      'W5_NATIVE_STORAGE_BLOCKED: better-sqlite3-multiple-ciphers@13.0.3 is not installed',
    )
  }
  const elapsed = await measureAppend(100_000)
  t.diagnostic(
    `events=100000 elapsedMs=${elapsed.toFixed(2)} eventsPerSecond=${(100_000 / (elapsed / 1000)).toFixed(2)}`,
  )
})
