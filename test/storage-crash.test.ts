import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openSqliteStorage } from '../src/adapters/storage/sqlite.js'
import {
  configureCipherDatabase,
  loadCipherDatabaseFactory,
} from '../src/adapters/storage/sqlite-driver.js'
import {
  applyConnectionPragmas,
  SQLITE_SCHEMA_VERSION,
} from '../src/adapters/storage/sqlite-schema.js'
import { canonicalDigest } from '../src/domain/canonical.js'
import {
  createConversationId,
  createEventId,
  createOperationId,
  createRunId,
  createWorkspaceId,
} from '../src/domain/ids.js'
import { credentialRef } from '../src/ports/credentials.js'
import { FileCredentialStore } from './support/file-credentials.js'
import { seedSnapshots } from './support/storage-snapshot-fixture.js'

const require = createRequire(import.meta.url)
const sqliteAvailable = (() => {
  try {
    require('better-sqlite3-multiple-ciphers')
    return true
  } catch {
    return false
  }
})()

const childPath = join(
  process.env.BRAID_TEST_DIST ?? join(process.cwd(), '.test-dist'),
  'test/storage-crash-child.js',
)
const workspaceId = createWorkspaceId('workspace-crash')
const conversationId = createConversationId('conversation-crash')
const runId = createRunId('run-crash')

function mutation(kind: string, request: import('../src/ports/storage.js').JsonValue = {}) {
  return {
    operationId: createOperationId(`op-${kind}`),
    kind,
    request,
    requestDigest: canonicalDigest(request),
  }
}

function journalEvent(sequence: number, eventId: string, terminal = false) {
  return {
    workspaceId,
    conversationId,
    runId,
    eventId: createEventId(eventId),
    sequence,
    kind: terminal ? 'run.finished' : 'run.text.delta',
    payload: { text: `crash-${sequence}` },
    occurredAt: '2026-08-02T00:00:00.000Z',
    receivedAt: '2026-08-02T00:00:00.000Z',
    terminal,
  } as const
}

async function open(root: string) {
  return openSqliteStorage({
    path: join(root, 'braid.sqlite'),
    workspaceRoot: root,
    credentialStore: new FileCredentialStore(join(root, 'credentials')),
    databaseKeyRef: credentialRef('cred:v1:test-crash-database'),
  })
}

async function prepare(root: string, action: string): Promise<void> {
  if (action === 'open') return
  const storage = await open(root)
  const snapshotScopeId = storage.snapshotScopeId()
  try {
    if (action === 'rebuild') await storage.append([journalEvent(1, 'event-crash-1')])
    if (
      action === 'retention' ||
      action === 'redaction' ||
      action === 'redaction-prepare-cleanup' ||
      action === 'destruction' ||
      action === 'key-reconcile' ||
      action === 'restore' ||
      action === 'snapshot-write' ||
      action === 'snapshot-prune' ||
      action === 'snapshot-quarantine' ||
      action === 'snapshot-reconcile'
    ) {
      await storage.append([
        journalEvent(1, 'event-crash-1'),
        ...(action === 'snapshot-write' || action === 'snapshot-quarantine'
          ? []
          : [journalEvent(2, 'event-crash-2', action !== 'snapshot-prune')]),
      ])
    }
    if (
      action === 'retention' ||
      action === 'redaction' ||
      action === 'destruction' ||
      action === 'snapshot-prune'
    ) {
      await seedSnapshots(storage, ['event-crash-1', 'event-crash-2'])
    }
    if (action === 'snapshot-quarantine') {
      await seedSnapshots(storage, ['event-crash-1'])
    }
    const crashOperation = {
      operationId: createOperationId('op-crash'),
      kind: 'send',
      request: { text: 'crash' },
      requestDigest: canonicalDigest({ text: 'crash' }),
    }
    if (
      action === 'effect-reserve-replay' ||
      action === 'effect-reserve-conflict' ||
      action === 'operation-reserve-replay' ||
      action === 'operation-reserve-conflict' ||
      action === 'operation-complete' ||
      action === 'operation-complete-conflict' ||
      action === 'operation-complete-replay' ||
      action === 'operation-conflict'
    ) {
      await storage.reserveOperation(crashOperation)
    }
    if (action === 'effect-reserve-replay' || action === 'effect-reserve-conflict') {
      await storage.reserveEffect({
        operationId: 'op-crash',
        effectKind: 'test.effect',
        requestDigest: 'a'.repeat(64),
        status: 'pending',
        attempt: 1,
        createdAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
        metadata: { action: 'crash' },
      })
    }
    if (action === 'operation-complete-replay') {
      await storage.completeOperation({
        operationId: crashOperation.operationId,
        requestDigest: crashOperation.requestDigest,
        status: 'terminal',
        result: { prepared: true },
      })
    }
    if (action === 'restore') {
      const path = join(root, 'crash-restore-source.sqlite')
      await storage.backup({ path, operation: mutation('prepare-restore', { path }) })
    }
  } finally {
    await storage.close()
  }
  if (action === 'migration') {
    await withDatabase(root, (database) => {
      database.exec('DROP INDEX IF EXISTS braid_journal_event_id_unique')
      database.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION - 1}`)
    })
  }
  if (action === 'key-reconcile') {
    const credentials = new FileCredentialStore(join(root, 'credentials'))
    const newRef = credentialRef('cred:v1:crash-key-reconcile-new')
    await credentials.store({ ref: newRef, value: Buffer.alloc(32, 29) })
    await withDatabase(root, (database) => {
      const current = database
        .prepare('SELECT credential_ref FROM braid_conversation_keys WHERE conversation_id = ?')
        .get(conversationId) as { readonly credential_ref: string }
      database
        .prepare(
          `INSERT INTO braid_content_key_rotations(
             conversation_id, old_credential_ref, new_credential_ref, prepared_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(conversationId, current.credential_ref, newRef, '2026-08-02T00:00:00.000Z')
    })
  }
  if (action === 'snapshot-reconcile') {
    const credentials = new FileCredentialStore(join(root, 'credentials'))
    const staleRef = credentialRef('cred:v1:crash-snapshot-reconcile-stale')
    await credentials.store({ ref: staleRef, value: Buffer.alloc(32, 31) })
    await withDatabase(root, (database) => {
      database
        .prepare(
          `INSERT INTO braid_state_snapshot_keys(
             scope_id, generation, credential_ref, retired, created_at
           ) VALUES (?, ?, ?, 0, ?)`,
        )
        .run(snapshotScopeId, 901, staleRef, '2026-08-02T00:00:00.000Z')
    })
  }
  if (action === 'snapshot-quarantine') {
    await withDatabase(root, (database) => {
      const row = database
        .prepare('SELECT snapshot_id, state_ciphertext FROM braid_state_snapshots LIMIT 1')
        .get() as { readonly snapshot_id?: unknown; readonly state_ciphertext?: unknown }
      if (typeof row.snapshot_id !== 'number' && typeof row.snapshot_id !== 'bigint')
        throw new Error('Snapshot fixture id is invalid')
      if (!Buffer.isBuffer(row.state_ciphertext))
        throw new Error('Snapshot fixture ciphertext is invalid')
      const corrupted = Buffer.from(row.state_ciphertext)
      const last = corrupted.length - 1
      if (last < 0) throw new Error('Snapshot fixture ciphertext is empty')
      corrupted[last] = (corrupted[last] ?? 0) ^ 0xff
      database
        .prepare('UPDATE braid_state_snapshots SET state_ciphertext = ? WHERE snapshot_id = ?')
        .run(corrupted, row.snapshot_id)
      corrupted.fill(0)
    })
  }
}

async function withDatabase(
  root: string,
  action: (database: import('../src/adapters/storage/sqlite-driver.js').SqliteDatabase) => void,
): Promise<void> {
  const credentials = new FileCredentialStore(join(root, 'credentials'))
  const handle = await credentials.resolve(credentialRef('cred:v1:test-crash-database'))
  const key = Buffer.from(handle.read())
  handle.dispose()
  const database = loadCipherDatabaseFactory()(join(root, 'braid.sqlite'), { timeout: 5_000 })
  try {
    configureCipherDatabase(database, key)
    applyConnectionPragmas(database, 5_000)
    action(database)
  } finally {
    database.close()
    key.fill(0)
  }
}

async function schemaVersion(root: string): Promise<number> {
  let version = -1
  await withDatabase(root, (database) => {
    version = Number(database.pragma('user_version', { simple: true }))
  })
  return version
}

async function rotationCount(root: string): Promise<number> {
  let count = -1
  await withDatabase(root, (database) => {
    const row = database
      .prepare('SELECT COUNT(*) AS count FROM braid_content_key_rotations')
      .get() as {
      readonly count: number | bigint
    }
    count = Number(row.count)
  })
  return count
}

async function hasGlobalEventIndex(root: string): Promise<boolean> {
  let present = false
  await withDatabase(root, (database) => {
    const row = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'braid_journal_event_id_unique'",
      )
      .get()
    present = row !== undefined
  })
  return present
}

async function runCrash(root: string, action: string, boundary: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [childPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CRASH_ROOT: root,
        CRASH_DATABASE: join(root, 'braid.sqlite'),
        CRASH_ACTION: action,
        CRASH_BOUNDARY: boundary,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (signal !== 'SIGKILL') {
        reject(
          new Error(
            `crash child action=${action} boundary=${boundary} exited with code=${String(code)} signal=${String(signal)} stderr=${stderr}`,
          ),
        )
        return
      }
      resolve()
    })
  })
}

const commitCrashCases = [
  { action: 'open', label: 'schema.initialize' },
  { action: 'open', label: 'projection.initialize' },
  { action: 'migration', label: 'migration' },
  { action: 'key-reconcile', label: 'key.reconcile' },
  { action: 'append', label: 'append' },
  { action: 'rebuild', label: 'rebuild' },
  { action: 'operation-reserve', label: 'operation.reserve' },
  { action: 'operation-reserve-replay', label: 'operation.reserve.replay' },
  { action: 'operation-reserve-conflict', label: 'operation.reserve.conflict' },
  { action: 'operation-complete', label: 'operation.complete' },
  { action: 'operation-complete-replay', label: 'operation.complete.replay' },
  { action: 'operation-complete-conflict', label: 'operation.complete.conflict' },
  { action: 'operation-conflict', label: 'operation.conflict' },
  { action: 'effect-reserve', label: 'effect.reserve' },
  { action: 'effect-reserve-replay', label: 'effect.reserve.replay' },
  { action: 'effect-reserve-conflict', label: 'effect.reserve.conflict' },
  { action: 'effect', label: 'effect' },
  { action: 'retention', label: 'retention' },
  { action: 'redaction', label: 'redaction.prepare' },
  { action: 'redaction', label: 'redaction' },
  { action: 'redaction-prepare-cleanup', label: 'redaction.prepare.cleanup' },
  { action: 'redaction', label: 'redaction.cleanup' },
  { action: 'destruction', label: 'destruction' },
  { action: 'restore', label: 'restore.operation.reserve' },
  { action: 'snapshot-write', label: 'state.snapshot' },
  { action: 'snapshot-prune', label: 'state.snapshot.prune' },
  { action: 'snapshot-prune', label: 'state.snapshot.keys.remove' },
  { action: 'snapshot-reconcile', label: 'state.snapshot.key.reconcile' },
  { action: 'snapshot-quarantine', label: 'state.snapshot.quarantine' },
  { action: 'snapshot-quarantine', label: 'state.snapshot.quarantine.cleanup' },
  { action: 'redaction', label: 'state.snapshot.invalidation.cleanup' },
] as const

const externalCrashCases = [
  { action: 'redaction', label: 'redaction.key.store' },
  { action: 'redaction', label: 'redaction.old-key.remove' },
  { action: 'backup', label: 'backup' },
  { action: 'backup', label: 'backup.publish' },
  { action: 'backup', label: 'backup.temp.remove' },
  { action: 'restore', label: 'backup' },
  { action: 'restore', label: 'backup.publish' },
  { action: 'restore', label: 'backup.temp.remove' },
  { action: 'restore', label: 'restore.manifest.prepared' },
  { action: 'restore', label: 'restore.copy' },
  { action: 'restore', label: 'restore.manifest.candidate-ready' },
  { action: 'restore', label: 'restore.displace' },
  { action: 'restore', label: 'restore.displace-wal' },
  { action: 'restore', label: 'restore.displace-shm' },
  { action: 'restore', label: 'restore.manifest.live-displaced' },
  { action: 'restore', label: 'restore.install' },
  { action: 'restore', label: 'restore.manifest.installed' },
  { action: 'restore', label: 'restore.manifest.verified' },
  { action: 'restore', label: 'restore.cleanup' },
  { action: 'restore', label: 'restore.cleanup-wal' },
  { action: 'restore', label: 'restore.cleanup-shm' },
  { action: 'restore', label: 'restore.manifest.remove' },
] as const

const crashCases = [...commitCrashCases, ...externalCrashCases]

test('forced-kill cases enumerate every SQLite commit point', async () => {
  const sqliteSources = (await readdir(join(process.cwd(), 'src/adapters/storage')))
    .filter((name) => /^sqlite.*\.ts$/u.test(name))
    .sort()
  const source = (
    await Promise.all(
      sqliteSources.map((name) =>
        readFile(join(process.cwd(), 'src/adapters/storage', name), 'utf8'),
      ),
    )
  ).join('\n')
  const implementationLabels = [
    ...new Set(
      [...source.matchAll(/commit\(([^)]*)\)/gu)].flatMap((call) =>
        [...(call[1] ?? '').matchAll(/'([^']+)'/gu)].map((literal) => literal[1]),
      ),
    ),
  ].sort()
  assert.deepEqual(commitCrashCases.map((entry) => entry.label).sort(), implementationLabels)
})

test('production SQLite recovers at every commit and external key/file boundary after forced kill', async () => {
  if (!sqliteAvailable) {
    throw new Error(
      'W5_NATIVE_STORAGE_BLOCKED: better-sqlite3-multiple-ciphers@13.0.3 is not installed',
    )
  }
  for (const current of crashCases) {
    const phases =
      current.label === 'restore.displace-wal' || current.label === 'restore.displace-shm'
        ? (['before'] as const)
        : (['before', 'after'] as const)
    for (const phase of phases) {
      const root = await mkdtemp(join(tmpdir(), `braid-crash-${current.action}-${phase}-`))
      await prepare(root, current.action)
      await runCrash(root, current.action, `${phase}:${current.label}`)

      if (current.action === 'migration') {
        assert.equal(
          await schemaVersion(root),
          phase === 'after' ? SQLITE_SCHEMA_VERSION : SQLITE_SCHEMA_VERSION - 1,
        )
        assert.equal(await hasGlobalEventIndex(root), false)
      }
      if (current.action === 'key-reconcile' || current.action === 'redaction-prepare-cleanup') {
        assert.equal(await rotationCount(root), phase === 'after' ? 0 : 1)
      }

      const storage = await open(root)
      try {
        assert.equal((await storage.integrity()).ok, true, `${current.label} ${phase}`)
        const committed = phase === 'after'
        if (current.action === 'append') {
          assert.equal((await storage.events()).length, committed ? 1 : 0)
        } else if (current.action === 'snapshot-write') {
          assert.equal((await storage.latestStateSnapshot())?.generation, committed ? 1 : undefined)
        } else if (current.action === 'snapshot-prune') {
          assert.equal((await storage.events()).length, 3)
          assert.equal((await storage.latestStateSnapshot())?.generation, 3)
        } else if (current.action === 'snapshot-quarantine') {
          assert.equal((await storage.latestStateSnapshot())?.generation, undefined)
        } else if (current.action === 'operation-reserve') {
          const operation = await storage.operation(createOperationId('op-crash'))
          assert.equal(operation !== null, committed)
        } else if (
          current.action === 'operation-reserve-conflict' ||
          current.action === 'operation-complete-conflict' ||
          current.action === 'operation-conflict'
        ) {
          const operation = await storage.operation(createOperationId('op-crash'))
          assert.equal(operation?.status, 'pending', `${current.action} ${current.label} ${phase}`)
        } else if (current.action === 'operation-complete') {
          const operation = await storage.operation(createOperationId('op-crash'))
          assert.equal(operation?.status, committed ? 'terminal' : 'pending')
        } else if (current.action === 'operation-complete-replay') {
          const operation = await storage.operation(createOperationId('op-crash'))
          assert.equal(operation?.status, 'terminal')
        } else if (current.action === 'operation-reserve-replay') {
          const operation = await storage.operation(createOperationId('op-crash'))
          assert.equal(operation?.status, 'pending')
        } else if (current.action === 'effect') {
          assert.equal(storage.history('op-crash').length, committed ? 1 : 0)
        } else if (current.action === 'effect-reserve') {
          assert.equal(storage.history('op-crash').length, committed ? 1 : 0)
        } else if (current.action === 'effect-reserve-replay') {
          assert.equal(storage.history('op-crash').length, 1)
        } else if (current.action === 'effect-reserve-conflict') {
          assert.equal(storage.history('op-crash').length, committed ? 2 : 1)
        } else if (current.action === 'retention') {
          const events = await storage.events({ conversationId })
          assert.equal(
            events.every((event) => event.payloadState === 'redacted'),
            committed,
          )
        } else if (current.action === 'redaction') {
          const event = (await storage.events({ conversationId })).find(
            (item) => item.eventId === 'event-crash-1',
          )
          const rewriteCommitted =
            current.label === 'redaction.prepare' || current.label === 'redaction.key.store'
              ? false
              : current.label === 'redaction'
                ? committed
                : true
          assert.equal(event?.payloadState === 'redacted', rewriteCommitted)
        } else if (current.action === 'redaction-prepare-cleanup') {
          const event = (await storage.events({ conversationId })).find(
            (item) => item.eventId === 'event-crash-1',
          )
          assert.equal(event?.payloadState, 'available')
        } else if (current.action === 'destruction') {
          const event = (await storage.events({ conversationId }))[0]
          assert.equal(event?.payloadState, committed ? 'deleted' : 'available')
        } else if (current.action === 'backup') {
          const backupExists = await stat(join(root, 'crash-backup.sqlite'))
            .then(() => true)
            .catch(() => false)
          const expected =
            current.label === 'backup'
              ? committed
              : current.label === 'backup.publish'
                ? committed
                : true
          assert.equal(backupExists, expected, `${current.label} ${phase}`)
        } else if (current.action === 'restore') {
          const operation = await storage.operation(createOperationId('op-restore'))
          const candidateHasBeenInstalled =
            (current.label === 'restore.install' && phase === 'after') ||
            current.label === 'restore.manifest.installed'
          const expected =
            current.label === 'restore.operation.reserve'
              ? phase === 'after'
              : !candidateHasBeenInstalled
          assert.equal(operation !== null, expected, `${current.label} ${phase}`)
          const leftovers = await readdir(root)
          assert.equal(leftovers.includes('braid.sqlite.restore.manifest'), false)
          assert.equal(
            leftovers.some(
              (name) =>
                /\.restore-[0-9a-f-]+\.tmp$/u.test(name) || /\.displaced-[0-9a-f-]+$/u.test(name),
            ),
            false,
            `${current.label} ${phase}`,
          )
        }
      } finally {
        await storage.close()
      }
    }
  }
})
