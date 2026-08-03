import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import { MemoryStorage } from '../src/adapters/storage/memory.js'
import { openSqliteStorage } from '../src/adapters/storage/sqlite.js'
import {
  configureCipherDatabase,
  loadCipherDatabaseFactory,
} from '../src/adapters/storage/sqlite-driver.js'
import { StorageError } from '../src/adapters/storage/sqlite-errors.js'
import { applyConnectionPragmas } from '../src/adapters/storage/sqlite-schema.js'
import { StorageJournal } from '../src/app/storage-journal.js'
import { canonicalDigest } from '../src/domain/canonical.js'
import {
  createConversationId,
  createEventId,
  createOperationId,
  createRunId,
  createWorkspaceId,
} from '../src/domain/ids.js'
import { FixedClock } from '../src/ports/clock.js'
import { credentialRef } from '../src/ports/credentials.js'
import type { JsonValue } from '../src/ports/storage.js'
import { FileCredentialStore } from './support/file-credentials.js'

const require = createRequire(import.meta.url)
const sqliteAvailable = (() => {
  try {
    require('better-sqlite3-multiple-ciphers')
    return true
  } catch {
    return false
  }
})()

function requireNativeStorage(): void {
  if (!sqliteAvailable) {
    throw new Error(
      'W5_NATIVE_STORAGE_BLOCKED: better-sqlite3-multiple-ciphers@12.11.1 is not installed',
    )
  }
}

const conversationId = createConversationId('conv-storage')
let mutationSequence = 0

function mutation(
  kind: string,
  request: JsonValue = {},
): {
  readonly operationId: ReturnType<typeof createOperationId>
  readonly kind: string
  readonly request: JsonValue
  readonly requestDigest: ReturnType<typeof canonicalDigest>
} {
  mutationSequence += 1
  return {
    operationId: createOperationId(`op-${kind}-${mutationSequence}`),
    kind,
    request,
    requestDigest: canonicalDigest(request),
  }
}

function journalEvent(
  run: string,
  sequence: number,
  eventId: string,
  payload: JsonValue,
  terminal = false,
) {
  return {
    workspaceId: createWorkspaceId('workspace-storage'),
    conversationId: createConversationId('conv-storage'),
    runId: createRunId(run),
    eventId: createEventId(eventId),
    sequence,
    kind: terminal ? 'run.finished' : 'run.text.delta',
    payload,
    occurredAt: '2026-08-02T00:00:00.000Z',
    terminal,
  } as const
}

async function openFileStorage(root: string, databaseName = 'braid.sqlite') {
  return openSqliteStorage({
    path: join(root, databaseName),
    workspaceRoot: root,
    credentialStore: new FileCredentialStore(join(root, 'credentials')),
    databaseKeyRef: credentialRef('cred:v1:database-file-test'),
  })
}

async function withDatabaseKey(root: string, action: (key: Buffer) => void): Promise<void> {
  const credentials = new FileCredentialStore(join(root, 'credentials'))
  const handle = await credentials.resolve(credentialRef('cred:v1:database-file-test'))
  const key = Buffer.from(handle.read())
  handle.dispose()
  try {
    action(key)
  } finally {
    key.fill(0)
  }
}

test('MemoryStorage remains behind StoragePort for deterministic duplicate and gap tests', async () => {
  const storage = new MemoryStorage()
  const first = journalEvent('run-memory', 1, 'event-memory-1', { text: 'one' })
  const duplicate = await storage.append([first])
  assert.deepEqual(duplicate.acceptedEventIds, [first.eventId])
  const replay = await storage.append([first])
  assert.deepEqual(replay.duplicateEventIds, [first.eventId])
  const gap = await storage.append([journalEvent('run-gap', 3, 'event-gap-3', { text: 'three' })])
  assert.equal(gap.missingHistory[0]?.fromSequence, 1)
  assert.deepEqual(
    (await storage.replay({ runId: createRunId('run-gap') })).events.map((event) => event.sequence),
    [3],
  )
  const sameLocalId = await storage.append([
    {
      ...journalEvent('run-another', 1, 'event-memory-1', { text: 'scoped local id' }),
      providerEventId: 'provider-event-1',
    },
  ])
  assert.deepEqual(sameLocalId.acceptedEventIds, ['event-memory-1'])
  assert.equal((await storage.replay({ runId: createRunId('run-gap') })).complete, false)
  await storage.append([
    journalEvent('run-gap', 1, 'event-gap-1', { text: 'one' }),
    journalEvent('run-gap', 2, 'event-gap-2', { text: 'two' }),
  ])
  const complete = await storage.replay({ runId: createRunId('run-gap') })
  assert.equal(complete.complete, true)
  assert.deepEqual(
    complete.events.map((event) => event.sequence),
    [1, 2, 3],
  )
  const incremental = await storage.projectionChecksum()
  const rebuilt = await storage.rebuild(mutation('rebuild'))
  assert.equal(rebuilt.checksum, incremental)

  const missingRedaction = mutation('redaction-missing', {
    conversationId: first.conversationId,
    eventId: createEventId('event-memory-missing'),
    reasonDigest: canonicalDigest('missing target'),
  })
  await assert.rejects(
    () =>
      storage.redact({
        conversationId: first.conversationId,
        eventId: createEventId('event-memory-missing'),
        reason: 'missing target',
        operation: missingRedaction,
      }),
    (error: unknown) => error instanceof StorageError && error.code === 'EVENT_NOT_FOUND',
  )
  await assert.rejects(
    () =>
      storage.redact({
        conversationId: first.conversationId,
        eventId: createEventId('event-memory-missing'),
        reason: 'missing target',
        operation: missingRedaction,
      }),
    (error: unknown) => error instanceof StorageError && error.code === 'OPERATION_FAILED_REPLAY',
  )
})

test('production SQLite adapter encrypts, replays, backs up, and destroys content keys', async () => {
  requireNativeStorage()
  const root = await mkdtemp(join(tmpdir(), 'braid-storage-'))
  const databasePath = join(root, 'braid.sqlite')
  const backupPath = join(root, 'braid.backup')
  const credentials = new MemoryCredentialStore()
  const storage = await openSqliteStorage({
    path: databasePath,
    workspaceRoot: root,
    credentialStore: credentials,
    databaseKeyRef: credentialRef('cred:v1:database-test'),
  })
  const canary = 'W5_RAW_BYTE_CANARY_2026'
  const first = journalEvent('run-sqlite', 1, 'event-sqlite-1', { text: canary })
  const second = journalEvent('run-sqlite', 2, 'event-sqlite-2', { finalText: canary }, true)
  await storage.append([first, second])
  const duplicate = await storage.append([first])
  assert.deepEqual(duplicate.duplicateEventIds, [first.eventId])
  const replay = await storage.replay({ runId: first.runId })
  assert.equal(replay.complete, true)
  assert.equal(replay.events[0]?.payloadState, 'available')
  assert.equal(
    await storage.projectionChecksum(),
    (await storage.rebuild(mutation('rebuild'))).checksum,
  )
  assert.equal((await storage.integrity()).ok, true)

  const backup = await storage.backup({
    path: backupPath,
    operation: mutation('backup', { path: backupPath }),
  })
  assert.equal(backup.encrypted, true)
  assert.ok((await stat(backupPath)).size > 0)
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, backupPath]) {
    const bytes = await readFile(path).catch(() => Buffer.alloc(0))
    assert.equal(bytes.includes(Buffer.from(canary)), false, path)
  }

  await storage.destroyConversation({
    conversationId: first.conversationId,
    reason: 'test destruction',
    operation: mutation('destroy', {
      conversationId: first.conversationId,
      reasonDigest: canonicalDigest('test destruction'),
    }),
  })
  const destroyed = await storage.events({ conversationId: first.conversationId })
  assert.equal(destroyed[0]?.payloadState, 'deleted')
  await storage.close()

  const bytesBeforeWrongCredentials = await Promise.all(
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map((path) =>
      readFile(path).catch(() => Buffer.alloc(0)),
    ),
  )
  const wrongCredentials = new MemoryCredentialStore()
  await assert.rejects(
    () =>
      openSqliteStorage({
        path: databasePath,
        workspaceRoot: root,
        credentialStore: wrongCredentials,
        databaseKeyRef: credentialRef('cred:v1:database-test'),
      }),
    (error: unknown) => error instanceof StorageError && error.code === 'SQLITE_KEY_REJECTED',
  )
  assert.deepEqual(
    await Promise.all(
      [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map((path) =>
        readFile(path).catch(() => Buffer.alloc(0)),
      ),
    ),
    bytesBeforeWrongCredentials,
  )
})

test('production SQLite adapter rejects secret-bearing payloads before commit', async () => {
  requireNativeStorage()
  const root = await mkdtemp(join(tmpdir(), 'braid-storage-secret-'))
  const storage = await openSqliteStorage({
    path: join(root, 'braid.sqlite'),
    workspaceRoot: root,
    credentialStore: new MemoryCredentialStore(),
    databaseKeyRef: credentialRef('cred:v1:database-secret-test'),
  })
  await assert.rejects(
    () =>
      storage.append([journalEvent('run-secret', 1, 'event-secret', { apiKey: 'do-not-persist' })]),
    (error: unknown) => error instanceof StorageError && error.code === 'SECRET_PAYLOAD_REJECTED',
  )
  await storage.close()
})

test('production SQLite scopes local event identifiers to a run and stores provider identity separately', async () => {
  requireNativeStorage()
  const root = await mkdtemp(join(tmpdir(), 'braid-storage-event-identity-'))
  const storage = await openFileStorage(root)
  await storage.append([
    {
      ...journalEvent('run-event-identity-a', 1, 'event-local-identity', { text: 'first' }),
      providerEventId: 'provider-event-a',
    },
    {
      ...journalEvent('run-event-identity-b', 1, 'event-local-identity', { text: 'second' }),
      providerEventId: 'provider-event-b',
    },
  ])
  const events = await storage.events()
  assert.deepEqual(
    events.map((event) => event.providerEventId),
    ['provider-event-a', 'provider-event-b'],
  )
  await storage.close()
})

test('production SQLite records changed-input conflicts without corrupting the original operation', async () => {
  requireNativeStorage()
  const root = await mkdtemp(join(tmpdir(), 'braid-storage-operation-conflict-'))
  const storage = await openFileStorage(root)
  const operationId = createOperationId('op-production-conflict')
  const request = { text: 'original' } as const
  const requestDigest = canonicalDigest(request)
  await storage.reserveOperation({ operationId, kind: 'send', request, requestDigest })
  const conflict = await storage.reserveOperation({
    operationId,
    kind: 'send',
    request: { text: 'changed' },
    requestDigest: canonicalDigest({ text: 'changed' }),
  })
  assert.equal(conflict.record.status, 'conflict')
  assert.equal((await storage.operation(operationId))?.status, 'pending')

  await storage.completeOperation({
    operationId,
    requestDigest,
    status: 'terminal',
    result: { accepted: true },
  })
  await storage.recordOperationConflict({
    operationId,
    requestDigest,
    attemptedDigest: canonicalDigest({ text: 'another change' }),
  })
  assert.equal((await storage.operation(operationId))?.status, 'terminal')
  await storage.close()
})

test('pending backup operations reconcile from the published artifact without rerunning the backup', async () => {
  requireNativeStorage()
  const root = await mkdtemp(join(tmpdir(), 'braid-storage-pending-backup-'))
  const storage = await openFileStorage(root)
  const backupPath = join(root, 'pending-backup.sqlite')
  const request = { path: backupPath } as const
  await storage.backup({
    path: backupPath,
    operation: {
      operationId: createOperationId('op-pending-backup-publish'),
      kind: 'backup',
      request,
      requestDigest: canonicalDigest(request),
    },
  })
  const pendingOperation = {
    operationId: createOperationId('op-pending-backup-reconcile'),
    kind: 'backup',
    request,
    requestDigest: canonicalDigest(request),
  }
  await storage.reserveOperation(pendingOperation)
  const reconciled = await storage.backup({ path: backupPath, operation: pendingOperation })
  assert.equal(reconciled.path, backupPath)
  assert.equal((await storage.operation(pendingOperation.operationId))?.status, 'terminal')
  await storage.close()
})

test('operation IDs reconcile by digest and changed inputs become conflicts', async () => {
  const storage = new MemoryStorage()
  const operationId = createOperationId('op-storage')
  const request = { text: 'same' } as const
  const requestDigest = canonicalDigest(request)
  const reservation = await storage.reserveOperation({
    operationId,
    kind: 'send',
    request,
    requestDigest,
  })
  assert.equal(reservation.created, true)
  const replay = await storage.reserveOperation({
    operationId,
    kind: 'send',
    request,
    requestDigest,
  })
  assert.equal(replay.created, false)
  const conflict = await storage.reserveOperation({
    operationId,
    kind: 'send',
    request: { text: 'changed' },
    requestDigest: canonicalDigest({ text: 'changed' }),
  })
  assert.equal(conflict.record.status, 'conflict')
  const originalReplay = await storage.reserveOperation({
    operationId,
    kind: 'send',
    request,
    requestDigest,
  })
  assert.equal(originalReplay.record.status, 'pending')
  assert.equal(originalReplay.created, false)
  await assert.rejects(
    () =>
      storage.reserveOperation({
        operationId: createOperationId('op-invalid-time'),
        kind: 'send',
        request,
        requestDigest,
        createdAt: '1',
      }),
    (error: unknown) => error instanceof StorageError && error.code === 'OPERATION_INVALID',
  )
  await assert.rejects(
    () => storage.rebuild(mutation('rebuild', { unexpected: true })),
    (error: unknown) => error instanceof StorageError && error.code === 'OPERATION_INVALID',
  )
})

test('production SQLite rejects an existing empty database path instead of treating it as a new store', async () => {
  requireNativeStorage()
  const root = await mkdtemp(join(tmpdir(), 'braid-storage-empty-'))
  const databasePath = join(root, 'braid.sqlite')
  await writeFile(databasePath, Buffer.alloc(0))
  await assert.rejects(
    () => openFileStorage(root),
    (error: unknown) => error instanceof StorageError && error.code === 'STORAGE_CORRUPT_EMPTY',
  )
})

test('production SQLite reopens projections and serializes concurrent writers', async () => {
  requireNativeStorage()
  const root = await mkdtemp(join(tmpdir(), 'braid-storage-restart-'))
  const first = await openFileStorage(root)
  const second = await openFileStorage(root)
  const firstEvent = journalEvent('run-file-a', 1, 'event-file-a', { text: 'writer-a' })
  const secondEvent = journalEvent('run-file-b', 1, 'event-file-b', { text: 'writer-b' })
  await Promise.all([first.append([firstEvent]), second.append([secondEvent])])
  const checksum = await first.projectionChecksum()
  assert.equal((await first.integrity()).ok, true)
  await first.close()
  await second.close()

  const reopened = await openFileStorage(root)
  assert.equal(await reopened.projectionChecksum(), checksum)
  assert.equal((await reopened.events()).length, 2)
  assert.deepEqual(
    (await reopened.reconcileNonTerminalRuns()).map((run) => run.runId),
    [createRunId('run-file-a'), createRunId('run-file-b')],
  )
  const backupPath = join(root, 'backups', 'before-third-event.sqlite')
  await reopened.backup({ path: backupPath, operation: mutation('backup', { path: backupPath }) })
  await reopened.append([journalEvent('run-file-c', 1, 'event-file-c', { text: 'writer-c' })])
  assert.equal((await reopened.events()).length, 3)
  const restored = await reopened.restore({
    path: backupPath,
    operation: mutation('restore', { path: backupPath }),
  })
  assert.equal(restored.integrity.ok, true)
  assert.equal((await reopened.events()).length, 2)
  await reopened.close()
})

test('production SQLite rejects raw-page corruption instead of rebuilding from damaged bytes', async () => {
  requireNativeStorage()
  const root = await mkdtemp(join(tmpdir(), 'braid-storage-corruption-'))
  const storage = await openFileStorage(root)
  await storage.append([journalEvent('run-corrupt', 1, 'event-corrupt-1', { text: 'corruption' })])
  await storage.close()
  const corruptPath = join(root, 'corrupt.sqlite')
  await copyFile(join(root, 'braid.sqlite'), corruptPath)
  const bytes = await readFile(corruptPath)
  const offset = Math.min(128, bytes.length - 1)
  bytes[offset] = (bytes[offset] ?? 0) ^ 0xff
  await writeFile(corruptPath, bytes)
  await assert.rejects(
    () => openFileStorage(root, 'corrupt.sqlite'),
    (error: unknown) => error instanceof StorageError,
  )
})

test('production SQLite tracks missing history and closes the gap after replay', async () => {
  requireNativeStorage()
  const root = await mkdtemp(join(tmpdir(), 'braid-storage-gap-'))
  const storage = await openFileStorage(root)
  const gap = await storage.append([
    journalEvent('run-gap-sqlite', 3, 'event-gap-sqlite-3', { text: 'three' }),
  ])
  assert.deepEqual(gap.missingHistory[0], {
    runId: createRunId('run-gap-sqlite'),
    fromSequence: 1,
    toSequence: 3,
  })
  const incompleteReplay = await storage.replay({ runId: createRunId('run-gap-sqlite') })
  assert.equal(incompleteReplay.lastSequence, 0)
  assert.equal(incompleteReplay.lastCursor, undefined)
  assert.equal(incompleteReplay.complete, false)
  await storage.append([journalEvent('run-gap-sqlite', 1, 'event-gap-sqlite-1', { text: 'one' })])
  await storage.append([journalEvent('run-gap-sqlite', 2, 'event-gap-sqlite-2', { text: 'two' })])
  const replay = await storage.replay({ runId: createRunId('run-gap-sqlite') })
  assert.equal(replay.complete, true)
  assert.equal(replay.lastSequence, 3)
  assert.deepEqual(
    replay.events.map((event) => event.eventId),
    ['event-gap-sqlite-1', 'event-gap-sqlite-2', 'event-gap-sqlite-3'],
  )
  await storage.close()
})

test('production SQLite retention, redaction rewrite, and content-key destruction remove readable history', async () => {
  requireNativeStorage()
  const root = await mkdtemp(join(tmpdir(), 'braid-storage-retention-'))
  const canary = 'W5_RETENTION_SECRET_CANARY_2026'
  const storage = await openFileStorage(root)
  await storage.append([
    {
      ...journalEvent('run-retention', 1, 'event-retention-1', { text: canary }),
      receivedAt: '2026-08-02T00:00:00.000Z',
    },
    {
      ...journalEvent('run-retention', 2, 'event-retention-2', { text: canary }, true),
      receivedAt: '2026-08-02T00:00:00.000Z',
    },
  ])
  const retention = await storage.applyRetention({
    before: '2026-08-03T00:00:00.000Z',
    operation: mutation('retention', { before: '2026-08-03T00:00:00.000Z' }),
  })
  assert.equal(retention.redactedEvents, 2)
  assert.equal(
    (await storage.events()).every((event) => event.payloadState === 'redacted'),
    true,
  )
  await storage.compact(mutation('compact'))
  for (const path of [
    join(root, 'braid.sqlite'),
    join(root, 'braid.sqlite-wal'),
    join(root, 'braid.sqlite-shm'),
  ]) {
    assert.equal(
      (await readFile(path).catch(() => Buffer.alloc(0))).includes(Buffer.from(canary)),
      false,
      path,
    )
  }
  await storage.close()

  const redactionRoot = await mkdtemp(join(tmpdir(), 'braid-storage-redaction-'))
  const redactionCredentials = new FileCredentialStore(join(redactionRoot, 'credentials'))
  const redactionStorage = await openSqliteStorage({
    path: join(redactionRoot, 'braid.sqlite'),
    workspaceRoot: redactionRoot,
    credentialStore: redactionCredentials,
    databaseKeyRef: credentialRef('cred:v1:database-redaction-test'),
  })
  await redactionStorage.append([
    journalEvent('run-redaction', 1, 'event-redaction-1', { text: canary }),
    journalEvent('run-redaction', 2, 'event-redaction-2', { text: 'retain this event' }, true),
  ])
  const credentialsBefore = await readdir(join(redactionRoot, 'credentials'))
  const redactionOperation = mutation('redact', {
    conversationId,
    eventId: createEventId('event-redaction-1'),
    reasonDigest: canonicalDigest(canary),
  })
  const report = await redactionStorage.redact({
    conversationId,
    eventId: createEventId('event-redaction-1'),
    reason: canary,
    operation: redactionOperation,
  })
  assert.equal(report.rewrittenEvents, 2)
  const redactedEvents = await redactionStorage.events({ conversationId })
  assert.equal(redactedEvents[0]?.payloadState, 'redacted')
  assert.equal(redactedEvents[1]?.payloadState, 'available')
  assert.deepEqual(
    await redactionStorage.redact({
      conversationId,
      eventId: createEventId('event-redaction-1'),
      reason: canary,
      operation: redactionOperation,
    }),
    report,
  )
  await redactionStorage.close()

  const reopenedRedaction = await openSqliteStorage({
    path: join(redactionRoot, 'braid.sqlite'),
    workspaceRoot: redactionRoot,
    credentialStore: redactionCredentials,
    databaseKeyRef: credentialRef('cred:v1:database-redaction-test'),
  })
  const replayedRedaction = await reopenedRedaction.events({ conversationId })
  assert.equal(replayedRedaction[0]?.payloadState, 'redacted')
  assert.equal(replayedRedaction[1]?.payloadState, 'available')
  const journal = await StorageJournal.fromStorage(
    reopenedRedaction,
    new FixedClock('2026-08-02T00:00:00.000Z'),
    { workspaceId: createWorkspaceId('workspace-storage') },
  )
  assert.equal(journal.all()[0]?.event.kind, 'unknown.event')
  await reopenedRedaction.compact(mutation('compact'))
  assert.equal((await readdir(join(redactionRoot, 'credentials'))).length, credentialsBefore.length)
  for (const path of [
    join(redactionRoot, 'braid.sqlite'),
    join(redactionRoot, 'braid.sqlite-wal'),
    join(redactionRoot, 'braid.sqlite-shm'),
  ]) {
    assert.equal(
      (await readFile(path).catch(() => Buffer.alloc(0))).includes(Buffer.from(canary)),
      false,
      path,
    )
  }
  await reopenedRedaction.destroyConversation({
    conversationId,
    reason: 'destroy conversation',
    operation: mutation('destroy', {
      conversationId,
      reasonDigest: canonicalDigest('destroy conversation'),
    }),
  })
  await reopenedRedaction.close()

  const destroyed = await openSqliteStorage({
    path: join(redactionRoot, 'braid.sqlite'),
    workspaceRoot: redactionRoot,
    credentialStore: redactionCredentials,
    databaseKeyRef: credentialRef('cred:v1:database-redaction-test'),
  })
  assert.equal((await destroyed.events({ conversationId }))[0]?.payloadState, 'deleted')
  const deletedJournal = await StorageJournal.fromStorage(
    destroyed,
    new FixedClock('2026-08-02T00:00:00.000Z'),
    { workspaceId: createWorkspaceId('workspace-storage') },
  )
  assert.equal(deletedJournal.all()[0]?.event.kind, 'unknown.event')
  await destroyed.close()
})

test('production SQLite rejects projection tampering and interrupted migrations after an encrypted backup', async () => {
  requireNativeStorage()
  const root = await mkdtemp(join(tmpdir(), 'braid-storage-integrity-'))
  const storage = await openFileStorage(root)
  await storage.append([
    journalEvent('run-integrity', 1, 'event-integrity-1', { text: 'integrity' }),
  ])
  await storage.close()
  await withDatabaseKey(root, (key) => {
    const database = loadCipherDatabaseFactory()(join(root, 'braid.sqlite'), { timeout: 5_000 })
    try {
      configureCipherDatabase(database, key)
      applyConnectionPragmas(database, 5_000)
      database
        .prepare('UPDATE braid_projection_state SET checksum = ? WHERE projection_name = ?')
        .run('0'.repeat(64), 'canonical')
    } finally {
      database.close()
    }
  })
  await assert.rejects(
    () => openFileStorage(root),
    (error: unknown) =>
      error instanceof StorageError && error.code === 'PROJECTION_CHECKSUM_MISMATCH',
  )

  const migrationRoot = await mkdtemp(join(tmpdir(), 'braid-storage-migration-'))
  const migrationStorage = await openFileStorage(migrationRoot)
  await migrationStorage.append([
    journalEvent('run-migration', 1, 'event-migration-1', { text: 'migration' }),
  ])
  await migrationStorage.close()
  await withDatabaseKey(migrationRoot, (key) => {
    const database = loadCipherDatabaseFactory()(join(migrationRoot, 'braid.sqlite'), {
      timeout: 5_000,
    })
    try {
      configureCipherDatabase(database, key)
      applyConnectionPragmas(database, 5_000)
      database.exec('PRAGMA user_version = 1')
    } finally {
      database.close()
    }
  })
  await assert.rejects(
    () =>
      openSqliteStorage({
        path: join(migrationRoot, 'braid.sqlite'),
        workspaceRoot: migrationRoot,
        credentialStore: new FileCredentialStore(join(migrationRoot, 'credentials')),
        databaseKeyRef: credentialRef('cred:v1:database-file-test'),
        migrationHooks: {
          beforeVersionCommit: () => {
            throw new Error('migration interrupted')
          },
        },
      }),
    (error: unknown) => error instanceof StorageError,
  )
  assert.equal(
    (await readdir(migrationRoot)).some((name) => name.includes('pre-migration-v1')),
    true,
  )
  const migrated = await openFileStorage(migrationRoot)
  assert.equal((await migrated.integrity()).ok, true)
  await migrated.close()
})

test('production SQLite reports commit failures without exposing a plaintext fallback', async () => {
  requireNativeStorage()
  const root = await mkdtemp(join(tmpdir(), 'braid-storage-commit-failure-'))
  const baseFactory = loadCipherDatabaseFactory()
  let failCommit = false
  const storage = await openSqliteStorage({
    path: join(root, 'braid.sqlite'),
    workspaceRoot: root,
    credentialStore: new FileCredentialStore(join(root, 'credentials')),
    databaseKeyRef: credentialRef('cred:v1:database-commit-failure-test'),
    databaseFactory: (path, options) => {
      const database = baseFactory(path, options)
      return new Proxy(database, {
        get(target, property, receiver) {
          if (property === 'exec') {
            return (sql: string) => {
              if (failCommit && sql === 'COMMIT') throw new Error('database or disk is full')
              return target.exec(sql)
            }
          }
          return Reflect.get(target, property, receiver)
        },
      })
    },
  })
  failCommit = true
  await assert.rejects(
    () =>
      storage.append([
        journalEvent('run-commit-failure', 1, 'event-commit-failure', { text: 'must rollback' }),
      ]),
    (error: unknown) => error instanceof StorageError && error.code === 'STORAGE_COMMIT_FAILED',
  )
  failCommit = false
  assert.equal((await storage.events()).length, 0)
  await storage.close()
})
