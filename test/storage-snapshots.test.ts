import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import { openSqliteStorage } from '../src/adapters/storage/sqlite.js'
import type { SqliteDatabase } from '../src/adapters/storage/sqlite-driver.js'
import {
  configureCipherDatabase,
  loadCipherDatabaseFactory,
} from '../src/adapters/storage/sqlite-driver.js'
import { applyConnectionPragmas } from '../src/adapters/storage/sqlite-schema.js'
import { STARTER_PROFILE } from '../src/app/composition.js'
import {
  createInteractionRequest,
  interactionResponseBinding,
} from '../src/app/interaction-request.js'
import { StorageJournal } from '../src/app/storage-journal.js'
import { toJson } from '../src/app/storage-journal-support.js'
import { canonicalDigest } from '../src/domain/canonical.js'
import type { BraidEventEnvelope } from '../src/domain/events.js'
import {
  createConversationId,
  createEventId,
  createInteractionId,
  createMessageId,
  createOperationId,
  createRunId,
  createTurnId,
  createWorkspaceId,
} from '../src/domain/ids.js'
import {
  createMaterializedStateSnapshot,
  restoreMaterializedState,
} from '../src/domain/materialized-state-snapshot.js'
import { reduceEvent, replayEvents } from '../src/domain/reducer.js'
import { initialState } from '../src/domain/state.js'
import { type CredentialRef, credentialRef } from '../src/ports/credentials.js'
import type { JournalEvent } from '../src/ports/storage.js'

const require = createRequire(import.meta.url)
const sqliteAvailable = (() => {
  try {
    require('better-sqlite3-multiple-ciphers')
    return true
  } catch {
    return false
  }
})()

const databaseKeyRef = credentialRef('cred:v1:snapshot-test-database')
const workspaceId = createWorkspaceId('workspace-snapshot-test')
const conversationId = createConversationId('conversation-snapshot-test')
const runId = createRunId('run-snapshot-test')
const canary = 'SNAPSHOT_MESSAGE_CANARY_2026'

class TrackingCredentialStore extends MemoryCredentialStore {
  readonly removedRefs = new Set<CredentialRef>()

  override async remove(ref: CredentialRef): Promise<void> {
    await super.remove(ref)
    this.removedRefs.add(ref)
  }
}

interface SnapshotFixture {
  readonly events: readonly JournalEvent[]
  readonly snapshots: readonly ReturnType<typeof createMaterializedStateSnapshot>[]
}

function fixture(): SnapshotFixture {
  let state = initialState(STARTER_PROFILE, { conversationId })
  const events: JournalEvent[] = []
  const snapshots: ReturnType<typeof createMaterializedStateSnapshot>[] = []
  for (let index = 1; index <= 3; index += 1) {
    const eventId = createEventId(`event-snapshot-${index}`)
    const envelope: BraidEventEnvelope = {
      eventId,
      sequence: index,
      revision: index,
      occurredAt: '2026-08-03T00:00:00.000Z',
      event: { kind: 'draft.changed', text: `${canary}-${index}` },
    }
    state = reduceEvent(state, envelope)
    events.push({
      workspaceId,
      conversationId,
      runId,
      eventId,
      sequence: index,
      kind: envelope.event.kind,
      payload: toJson({
        __braidEvent: envelope.event,
        __braidEnvelope: {
          sequence: envelope.sequence,
          revision: envelope.revision,
          occurredAt: envelope.occurredAt,
          eventId,
        },
      }),
      occurredAt: envelope.occurredAt,
      terminal: false,
    })
    snapshots.push(
      createMaterializedStateSnapshot({
        scopeId: 'pending',
        generation: state.sequence,
        eventId,
        state,
      }),
    )
  }
  return { events, snapshots }
}

test('restores a prior snapshot with the removed top-level interaction projection', () => {
  const interactionId = createInteractionId('interaction-snapshot')
  const runId = createRunId('run-snapshot-interaction')
  const request = createInteractionRequest({
    id: interactionId,
    kind: 'question',
    title: 'Continue after restart?',
    answerSpec: {
      fields: [{ type: 'boolean', name: 'continue', label: 'Continue', required: true }],
    },
    binding: {
      runId,
      provider: 'fixture',
      environmentId: 'environment-snapshot-interaction',
      sessionId: 'session-snapshot-interaction',
      executionId: 'execution-snapshot-interaction',
      interactionId,
    },
  })
  const at = '2026-08-03T00:00:00.000Z'
  const state = replayEvents(initialState(STARTER_PROFILE, { conversationId }), [
    {
      eventId: createEventId('event-snapshot-interaction-workspace'),
      sequence: 1,
      revision: 1,
      occurredAt: at,
      event: { kind: 'workspace.opened', workspace: '/workspace' },
    },
    {
      eventId: createEventId('event-snapshot-interaction-requested'),
      sequence: 2,
      revision: 2,
      occurredAt: at,
      event: {
        kind: 'run.requested',
        operationId: createOperationId('operation-snapshot-interaction'),
        runId,
        turnId: createTurnId('turn-snapshot-interaction'),
        userMessageId: createMessageId('message-snapshot-interaction-user'),
        assistantMessageId: createMessageId('message-snapshot-interaction-assistant'),
        text: 'wait for the answer',
      },
    },
    {
      eventId: createEventId('event-snapshot-interaction'),
      sequence: 3,
      revision: 3,
      occurredAt: at,
      event: {
        kind: 'run.interaction',
        runId,
        request,
        responseBinding: interactionResponseBinding(request),
        provider: {
          eventId: 'provider-snapshot-interaction',
          providerSequence: 1,
          occurredAt: at,
        },
      },
    },
  ])
  const snapshot = createMaterializedStateSnapshot({
    scopeId: 'snapshot-legacy-interaction',
    generation: state.sequence,
    eventId: createEventId('event-snapshot-interaction'),
    state,
  })
  assert.equal(Object.hasOwn(snapshot.state, 'interactions'), false)

  const legacyState = {
    ...snapshot.state,
    interactions: [
      {
        id: interactionId,
        runId,
        request: {
          id: interactionId,
          kind: request.kind,
          title: request.title,
          answerSpec: request.answerSpec,
        },
        status: 'pending',
        createdAt: at,
        updatedAt: at,
      },
    ],
  }
  const restored = restoreMaterializedState({
    ...snapshot,
    state: legacyState,
    stateChecksum: canonicalDigest(legacyState),
  })
  assert.equal(Object.hasOwn(restored, 'interactions'), false)
  assert.deepEqual(
    restored.runs.find((run) => run.id === runId)?.interactions.map((item) => item.request.id),
    [interactionId],
  )
})

async function withRawDatabase<T>(
  root: string,
  credentials: MemoryCredentialStore,
  action: (database: SqliteDatabase) => T,
): Promise<T> {
  const handle = await credentials.resolve(databaseKeyRef)
  const key = Buffer.from(handle.read())
  handle.dispose()
  const database = loadCipherDatabaseFactory()(join(root, 'braid.sqlite'), { timeout: 5_000 })
  try {
    configureCipherDatabase(database, key)
    applyConnectionPragmas(database, 5_000)
    return action(database)
  } finally {
    database.close()
    key.fill(0)
  }
}

function snapshotRows(database: SqliteDatabase): readonly Record<string, unknown>[] {
  return database
    .prepare(
      `SELECT snapshot_id, generation, key_ref, state_ciphertext
       FROM braid_state_snapshots ORDER BY generation DESC`,
    )
    .all() as readonly Record<string, unknown>[]
}

function snapshotKeyRefs(database: SqliteDatabase): readonly string[] {
  return (
    database
      .prepare('SELECT credential_ref FROM braid_state_snapshot_keys ORDER BY generation')
      .all() as readonly { readonly credential_ref?: unknown }[]
  ).flatMap((row) => (typeof row.credential_ref === 'string' ? [row.credential_ref] : []))
}

async function snapshotModuleArchitecture(): Promise<{
  readonly graph: ReadonlyMap<string, readonly string[]>
  readonly lineCounts: ReadonlyMap<string, number>
}> {
  const storageDirectory = join(process.cwd(), 'src/adapters/storage')
  const storageFiles = (await readdir(storageDirectory))
    .filter((name) => /^sqlite-state-snapshot.*\.ts$/u.test(name))
    .map((name) => join(storageDirectory, name))
  const files = [...storageFiles, join(process.cwd(), 'src/domain/materialized-state-snapshot.ts')]
  const fileSet = new Set(files)
  const graph = new Map<string, readonly string[]>()
  const lineCounts = new Map<string, number>()
  const importPattern = /(?:from\s+|import\s*)['"]([^'"]+)['"]/gu
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    const lines = source.split(/\r?\n/u)
    lineCounts.set(
      file,
      source === '' ? 0 : source.endsWith('\n') ? lines.length - 1 : lines.length,
    )
    const dependencies: string[] = []
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1]
      if (specifier === undefined || !specifier.startsWith('.')) continue
      const dependency = resolve(dirname(file), specifier.replace(/\.js$/u, '.ts'))
      if (fileSet.has(dependency)) dependencies.push(dependency)
    }
    graph.set(file, dependencies)
  }
  return { graph, lineCounts }
}

function assertSnapshotModuleGraphIsAcyclic(graph: ReadonlyMap<string, readonly string[]>): void {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (file: string, path: readonly string[]): void => {
    if (visiting.has(file)) {
      throw new Error(`Snapshot module cycle: ${[...path, file].join(' -> ')}`)
    }
    if (visited.has(file)) return
    visiting.add(file)
    for (const dependency of graph.get(file) ?? []) visit(dependency, [...path, file])
    visiting.delete(file)
    visited.add(file)
  }
  for (const file of graph.keys()) visit(file, [])
}

test('snapshot modules stay bounded and acyclic', async () => {
  const { graph, lineCounts } = await snapshotModuleArchitecture()
  for (const [file, lineCount] of lineCounts) {
    assert.ok(lineCount <= 300, `${file} has ${lineCount} lines; maximum is 300`)
  }
  assertSnapshotModuleGraphIsAcyclic(graph)
})

test('latest valid generation restores after a process restart', async (t) => {
  if (!sqliteAvailable) {
    throw new Error(
      'W5_NATIVE_STORAGE_BLOCKED: better-sqlite3-multiple-ciphers@13.0.3 is not installed',
    )
  }
  const root = await mkdtemp(join(tmpdir(), 'braid-snapshot-restart-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const credentials = new MemoryCredentialStore()
  const path = join(root, 'braid.sqlite')
  let storage = await openSqliteStorage({
    path,
    workspaceRoot: root,
    credentialStore: credentials,
    databaseKeyRef,
  })
  t.after(() => storage.close())
  const source = fixture()
  const scopeId = storage.snapshotScopeId()
  await storage.append(source.events)
  for (const snapshot of source.snapshots)
    await storage.writeStateSnapshot({ ...snapshot, scopeId })
  await storage.close()

  storage = await openSqliteStorage({
    path,
    workspaceRoot: root,
    credentialStore: credentials,
    databaseKeyRef,
  })
  const latest = await storage.latestStateSnapshot()
  assert.equal(latest?.generation, 3)
  assert.equal(latest?.sequence, 3)
  assert.equal(latest?.state.draft, `${canary}-3`)
  const journal = await StorageJournal.fromStorage(storage, {
    now: () => '2026-08-03T00:00:00.000Z',
  })
  assert.equal(journal.initialState()?.draft, `${canary}-3`)
  assert.equal(journal.all().length, 0)
  const persistedEvents = await journal.loadEvents({ runId })
  assert.equal(persistedEvents.length, 3)
  assert.deepEqual(
    persistedEvents.map((event) => event.event.kind),
    ['draft.changed', 'draft.changed', 'draft.changed'],
  )
})

test('append with a snapshot rolls back the event when snapshot storage fails', async (t) => {
  if (!sqliteAvailable) {
    throw new Error(
      'W5_NATIVE_STORAGE_BLOCKED: better-sqlite3-multiple-ciphers@13.0.3 is not installed',
    )
  }
  const root = await mkdtemp(join(tmpdir(), 'braid-snapshot-atomic-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const credentials = new MemoryCredentialStore()
  const storage = await openSqliteStorage({
    path: join(root, 'braid.sqlite'),
    workspaceRoot: root,
    credentialStore: credentials,
    databaseKeyRef,
  })
  t.after(() => storage.close())
  const source = fixture()
  const scopeId = storage.snapshotScopeId()
  const first = source.events[0]
  const second = source.events[1]
  const firstSnapshot = source.snapshots[0]
  assert.ok(first && second && firstSnapshot)
  await storage.appendWithSnapshot({
    events: [first],
    snapshot: { ...firstSnapshot, scopeId },
  })
  await assert.rejects(
    storage.appendWithSnapshot({
      events: [second],
      snapshot: { ...firstSnapshot, scopeId, eventId: second.eventId },
    }),
  )
  assert.equal((await storage.events()).length, 1)
  assert.equal((await storage.latestStateSnapshot())?.generation, 1)
  const refs = await withRawDatabase(root, credentials, snapshotKeyRefs)
  assert.equal(refs.length, 1)
  const retainedRef = refs[0]
  if (retainedRef === undefined) throw new Error('Expected the committed snapshot key')
  assert.equal(await credentials.has(credentialRef(retainedRef)), true)
})

test('snapshot writes fail closed when an event id is ambiguous', async (t) => {
  if (!sqliteAvailable) {
    throw new Error(
      'W5_NATIVE_STORAGE_BLOCKED: better-sqlite3-multiple-ciphers@13.0.3 is not installed',
    )
  }
  const root = await mkdtemp(join(tmpdir(), 'braid-snapshot-ambiguous-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const credentials = new MemoryCredentialStore()
  const storage = await openSqliteStorage({
    path: join(root, 'braid.sqlite'),
    workspaceRoot: root,
    credentialStore: credentials,
    databaseKeyRef,
  })
  t.after(() => storage.close())
  const source = fixture()
  const scopeId = storage.snapshotScopeId()
  const first = source.events[0]
  const firstSnapshot = source.snapshots[0]
  assert.ok(first && firstSnapshot)
  await storage.append([first, { ...first, runId: createRunId('run-snapshot-ambiguous') }])
  await assert.rejects(storage.writeStateSnapshot({ ...firstSnapshot, scopeId }))
  assert.equal((await storage.events()).length, 2)
  assert.equal(await storage.latestStateSnapshot(), null)
  assert.equal((await withRawDatabase(root, credentials, snapshotKeyRefs)).length, 0)
})

test('redaction erases snapshot keys before rollback and falls back to journal replay', async (t) => {
  if (!sqliteAvailable) {
    throw new Error(
      'W5_NATIVE_STORAGE_BLOCKED: better-sqlite3-multiple-ciphers@13.0.3 is not installed',
    )
  }
  const root = await mkdtemp(join(tmpdir(), 'braid-snapshot-key-retain-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const credentials = new TrackingCredentialStore()
  let snapshotKeyRef: CredentialRef | undefined
  let snapshotKeyGoneBeforeMutation = false
  const storage = await openSqliteStorage({
    path: join(root, 'braid.sqlite'),
    workspaceRoot: root,
    credentialStore: credentials,
    databaseKeyRef,
    durableBoundaryHook: (boundary) => {
      if (boundary !== 'before:redaction') return
      snapshotKeyGoneBeforeMutation =
        snapshotKeyRef !== undefined &&
        credentials.removedRefs.has(snapshotKeyRef) &&
        !credentials.has(snapshotKeyRef)
      throw new Error('force redaction rollback after snapshot key erasure')
    },
  })
  t.after(() => storage.close())
  const source = fixture()
  const scopeId = storage.snapshotScopeId()
  const first = source.events[0]
  const firstSnapshot = source.snapshots[0]
  assert.ok(first && firstSnapshot)
  await storage.append([first])
  await storage.writeStateSnapshot({ ...firstSnapshot, scopeId })
  const refs = await withRawDatabase(root, credentials, snapshotKeyRefs)
  const rawSnapshotKeyRef = refs[0]
  if (rawSnapshotKeyRef === undefined) throw new Error('snapshot key reference is missing')
  const snapshotCredentialRef = credentialRef(rawSnapshotKeyRef)
  snapshotKeyRef = snapshotCredentialRef

  const reason = 'rolled back snapshot-backed redaction'
  const request = {
    conversationId,
    eventId: first.eventId,
    reasonDigest: canonicalDigest(reason),
  } as const
  await assert.rejects(
    storage.redact({
      conversationId,
      eventId: first.eventId,
      reason,
      operation: {
        operationId: createOperationId('op-snapshot-key-rollback'),
        kind: 'redaction',
        request,
        requestDigest: canonicalDigest(request),
      },
    }),
  )
  assert.equal(snapshotKeyGoneBeforeMutation, true)
  assert.equal(await credentials.has(snapshotCredentialRef), false)
  assert.equal((await withRawDatabase(root, credentials, snapshotRows)).length, 1)
  assert.equal(await storage.latestStateSnapshot(), null)
  assert.equal((await withRawDatabase(root, credentials, snapshotRows)).length, 0)
  const journal = await StorageJournal.fromStorage(storage, {
    now: () => '2026-08-03T00:00:00.000Z',
  })
  const replayed = journal.replay()
  assert.equal(journal.initialState(), undefined)
  assert.equal(replayed.length, 1)
  const replayedState = replayed.reduce(
    (state, event) => reduceEvent(state, event),
    initialState(STARTER_PROFILE, { conversationId }),
  )
  assert.equal(replayedState.sequence, 1)
  assert.equal(replayedState.draft, `${canary}-1`)
})

test('production snapshots are encrypted, bounded, replayable, and key-deletable', async () => {
  if (!sqliteAvailable) {
    throw new Error(
      'W5_NATIVE_STORAGE_BLOCKED: better-sqlite3-multiple-ciphers@13.0.3 is not installed',
    )
  }
  const root = await mkdtemp(join(tmpdir(), 'braid-snapshot-'))
  const credentials = new MemoryCredentialStore()
  let committedSnapshots = 0
  const storage = await openSqliteStorage({
    path: join(root, 'braid.sqlite'),
    workspaceRoot: root,
    credentialStore: credentials,
    databaseKeyRef,
    durableBoundaryHook: (boundary) => {
      if (boundary !== 'after:state.snapshot') return
      committedSnapshots += 1
      if (committedSnapshots === 3) credentials.setAvailable(false)
    },
  })
  const source = fixture()
  const scopeId = storage.snapshotScopeId()
  const snapshots = source.snapshots.map((snapshot) => ({ ...snapshot, scopeId }))

  await storage.append(source.events)
  for (const snapshot of snapshots) await storage.writeStateSnapshot(snapshot)
  credentials.setAvailable(true)
  assert.equal(committedSnapshots, 3)

  const initialRows = await withRawDatabase(root, credentials, snapshotRows)
  assert.equal(initialRows.length, 2)
  assert.deepEqual(
    initialRows.map((row) => row.generation),
    [3, 2],
  )
  for (const row of initialRows) {
    if (!Buffer.isBuffer(row.state_ciphertext)) throw new Error('snapshot ciphertext is missing')
    assert.equal(
      row.state_ciphertext.includes(Buffer.from(canary)),
      false,
      'snapshot ciphertext must not contain plaintext state',
    )
  }
  const snapshotTableColumns = await withRawDatabase(root, credentials, (database) =>
    (
      database.prepare('PRAGMA table_info(braid_state_snapshots)').all() as readonly {
        readonly name?: unknown
      }[]
    ).map((row) => row.name),
  )
  assert.equal(snapshotTableColumns.includes('state_json'), false)
  const projectionState = await withRawDatabase(
    root,
    credentials,
    (database) =>
      database
        .prepare('SELECT state_json FROM braid_projection_state WHERE projection_name = ?')
        .get('canonical') as { readonly state_json?: unknown } | undefined,
  )
  assert.equal(
    typeof projectionState?.state_json === 'string' && projectionState.state_json.includes(canary),
    false,
  )

  const latest = await storage.latestStateSnapshot()
  assert.equal(latest?.generation, 3)

  credentials.setAvailable(false)
  await assert.rejects(
    storage.latestStateSnapshot(),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'CREDENTIAL_STORE_UNAVAILABLE',
  )
  credentials.setAvailable(true)
  const rowsAfterTransientFailure = await withRawDatabase(root, credentials, snapshotRows)
  assert.equal(rowsAfterTransientFailure.length, 2)
  for (const keyRef of await withRawDatabase(root, credentials, snapshotKeyRefs)) {
    assert.equal(await credentials.has(credentialRef(keyRef)), true)
  }
  assert.equal((await storage.latestStateSnapshot())?.generation, 3)
  await storage.close()

  const newest = await withRawDatabase(root, credentials, (database) => {
    const row = snapshotRows(database)[0]
    assert.ok(row)
    const keyRef = row.key_ref
    if (typeof keyRef !== 'string') throw new Error('snapshot key reference is missing')
    if (!Buffer.isBuffer(row.state_ciphertext)) throw new Error('snapshot ciphertext is missing')
    if (typeof row.snapshot_id !== 'number' && typeof row.snapshot_id !== 'bigint') {
      throw new Error('snapshot id is invalid')
    }
    const corrupted = Buffer.from(row.state_ciphertext)
    const last = corrupted.length - 1
    assert.ok(last >= 0)
    corrupted[last] = (corrupted[last] ?? 0) ^ 0xff
    database
      .prepare('UPDATE braid_state_snapshots SET state_ciphertext = ? WHERE snapshot_id = ?')
      .run(corrupted, row.snapshot_id)
    corrupted.fill(0)
    return { keyRef, generation: row.generation }
  })
  assert.equal(newest.generation, 3)

  const reopened = await openSqliteStorage({
    path: join(root, 'braid.sqlite'),
    workspaceRoot: root,
    credentialStore: credentials,
    databaseKeyRef,
  })
  const fallback = await reopened.latestStateSnapshot()
  assert.equal(fallback?.generation, 2)
  assert.equal(await credentials.has(credentialRef(newest.keyRef)), false)
  const secondRead = await reopened.latestStateSnapshot()
  assert.equal(secondRead?.generation, 2)
  assert.equal(
    (await withRawDatabase(root, credentials, snapshotRows)).length,
    1,
    'invalid newest snapshot is quarantined once',
  )

  const journal = await StorageJournal.fromStorage(reopened, {
    now: () => '2026-08-03T00:00:00.000Z',
  })
  assert.equal(journal.initialState()?.sequence, 2)
  assert.equal(journal.replay().length, 1)

  const priorKeyRefs = await withRawDatabase(root, credentials, snapshotKeyRefs)
  assert.equal(priorKeyRefs.length, 1)
  const reasonDigest = canonicalDigest('remove snapshot canary')
  const request = {
    conversationId,
    eventId: createEventId('event-snapshot-1'),
    reasonDigest,
  } as const
  const redactionOperation = {
    operationId: 'op-snapshot-redact',
    kind: 'redaction',
    request,
    requestDigest: canonicalDigest(request),
  } as const
  await reopened.redact({
    conversationId,
    eventId: createEventId('event-snapshot-1'),
    reason: 'remove snapshot canary',
    operation: redactionOperation,
  })
  const priorKeyRef = priorKeyRefs[0]
  if (priorKeyRef === undefined) throw new Error('snapshot key reference is missing')
  assert.equal(await credentials.has(credentialRef(priorKeyRef)), false)
  assert.equal((await withRawDatabase(root, credentials, snapshotRows)).length, 0)
  await reopened.close()
})

test('a checksum-valid but impossible materialized state is quarantined once', async (t) => {
  if (!sqliteAvailable) {
    throw new Error(
      'W5_NATIVE_STORAGE_BLOCKED: better-sqlite3-multiple-ciphers@13.0.3 is not installed',
    )
  }
  const root = await mkdtemp(join(tmpdir(), 'braid-snapshot-domain-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const credentials = new MemoryCredentialStore()
  const storage = await openSqliteStorage({
    path: join(root, 'braid.sqlite'),
    workspaceRoot: root,
    credentialStore: credentials,
    databaseKeyRef,
  })
  t.after(() => storage.close())
  const source = fixture()
  const scopeId = storage.snapshotScopeId()
  const first = source.snapshots[0]
  const second = source.snapshots[1]
  const third = source.snapshots[2]
  assert.ok(first && second && third)
  await storage.append(source.events)
  await storage.writeStateSnapshot({ ...first, scopeId })
  await storage.writeStateSnapshot({ ...second, scopeId })
  const impossibleState = { ...third.state, activeRunId: runId }
  await storage.writeStateSnapshot({
    ...third,
    scopeId,
    state: impossibleState,
    stateChecksum: canonicalDigest(impossibleState),
  })

  assert.equal((await storage.latestStateSnapshot())?.generation, 2)
  assert.equal((await storage.latestStateSnapshot())?.generation, 2)
  assert.equal((await withRawDatabase(root, credentials, snapshotRows)).length, 1)
  assert.equal((await withRawDatabase(root, credentials, snapshotKeyRefs)).length, 1)
})
