import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { FileCredentialStore } from './file-credential-store.mjs'
import { loadPackedRuntime } from './packed-runtime.mjs'

const require = createRequire(import.meta.url)
const FIXED_TIME = '2026-08-03T00:00:00.000Z'
const BATCH_SIZE = 1_000
const PROFILE = Object.freeze({ name: 'Braid performance profile', harness: 'pi' })

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function requireNativeSqlite() {
  try {
    require.resolve('better-sqlite3-multiple-ciphers')
  } catch {
    throw new Error(
      'PERF_PREREQUISITE: better-sqlite3-multiple-ciphers@13.0.3 is required for encrypted SQLite performance proof',
    )
  }
}

async function assertCredentialFacility(credentials) {
  const expected = randomBytes(32)
  let ref
  let handle
  try {
    ref = await credentials.store({ value: expected })
    handle = await credentials.resolve(ref)
    const observed = handle.read()
    assert(
      Buffer.from(observed).equals(expected),
      'Credential facility returned a different secret during the performance probe',
    )
  } catch (error) {
    throw new Error('PERF_PREREQUISITE: the operating-system credential facility is unavailable', {
      cause: error,
    })
  } finally {
    handle?.dispose()
    expected.fill(0)
    if (ref !== undefined) await credentials.remove(ref).catch(() => undefined)
  }
}

const runtimeCache = new Map()
async function runtime(packageRoot) {
  if (!packageRoot)
    throw new Error('PERF_PREREQUISITE: storage probes require a packed package root')
  if (!runtimeCache.has(packageRoot)) runtimeCache.set(packageRoot, loadPackedRuntime(packageRoot))
  try {
    return await runtimeCache.get(packageRoot)
  } catch (error) {
    throw new Error(
      `PERF_PREREQUISITE: build Braid before running performance proof (${String(error)})`,
      {
        cause: error,
      },
    )
  }
}

function seedContext(count, index, workspace) {
  const runId = `run-perf-${count}`
  const turnId = `turn-perf-${count}`
  const operationId = `op-perf-${count}`
  const text = 'Performance seed conversation with normalized text events.'
  const receipt = index.createAdmissionReceipt({
    runId,
    turnId,
    operationId,
    conversationId: 'conv-1',
    branchId: 'branch-1',
    admittedAt: FIXED_TIME,
    profile: PROFILE,
    connectionId: 'connection-performance-local',
    text,
    capabilities: index.DEFAULT_RUN_CAPABILITIES,
    provider: 'local-performance',
    environmentId: `environment-performance-${count}`,
    providerSessionId: `session-performance-${count}`,
  })
  return { operationId, receipt, runId, text, turnId, workspace }
}

function createPersistedEvent(count, index, context) {
  const eventId = `event-perf-${count}-${String(index).padStart(6, '0')}`
  const { operationId, receipt, runId, text, turnId } = context
  const appSequence = index
  let event
  let kind
  if (index === 1) {
    kind = 'workspace.opened'
    event = { kind, workspace: context.workspace }
  } else if (index === 2) {
    kind = 'run.requested'
    event = {
      kind,
      operationId,
      runId,
      turnId,
      userMessageId: `message-perf-user-${count}`,
      assistantMessageId: `message-perf-assistant-${count}`,
      text,
      requestDigest: receipt.requestDigest,
      receipt,
    }
  } else if (index === count) {
    kind = 'run.finished'
    event = {
      kind,
      runId,
      status: 'completed',
      finalText: `Completed Braid performance conversation (${count} committed events); recent event ${count - 3}.`,
      usage: { input: 1, output: count - 3, model: 'fixture/model' },
      reason: 'performance fixture complete',
      provider: {
        eventId: `provider-perf-${count}-final`,
        providerSequence: count - 2,
        occurredAt: FIXED_TIME,
        receivedAt: FIXED_TIME,
      },
    }
  } else {
    kind = 'run.text.delta'
    const deltaSequence = index - 2
    event = {
      kind,
      runId,
      text:
        deltaSequence === count - 2
          ? `Recent seeded event ${deltaSequence} remains observable. `
          : 'x',
      provider: {
        eventId: `provider-perf-${count}-${String(deltaSequence).padStart(6, '0')}`,
        providerSequence: deltaSequence,
        occurredAt: FIXED_TIME,
        receivedAt: FIXED_TIME,
      },
    }
  }
  return {
    workspaceId: `workspace-perf-${count}`,
    conversationId: `conversation-perf-${count}`,
    runId,
    eventId,
    sequence: index,
    kind,
    payload: {
      __braidEvent: event,
      __braidEnvelope: {
        eventId,
        sequence: appSequence,
        revision: appSequence,
        occurredAt: FIXED_TIME,
      },
    },
    occurredAt: FIXED_TIME,
    receivedAt: FIXED_TIME,
    terminal: index === count,
  }
}

export function assertValidConversationSeed(state, eventCount, workspace) {
  assert(state && typeof state === 'object', 'Seed replay did not produce a state')
  assert(
    state.sequence === eventCount,
    `Seed sequence is ${state.sequence}, expected ${eventCount}`,
  )
  assert(state.workspace === workspace, 'Seed workspace does not match the launched workspace')
  assert(
    Array.isArray(state.missingHistory) && state.missingHistory.length === 0,
    'Seed replay contains missing provider history',
  )
  assert(state.projectionChecksum, 'Seed replay has no projection checksum')
  const run = state.runs?.find((candidate) => candidate.id === `run-perf-${eventCount}`)
  assert(run, 'Seed replay did not produce the expected run')
  assert(run.status === 'completed' && run.complete, 'Seed run is not a complete successful run')
  assert(
    run.receipt.digest && run.receipt.requestDigest,
    'Seed run has no admission receipt digests',
  )
  assert(run.eventCount === eventCount - 2, `Seed run event count is ${run.eventCount}`)
  assert(run.lastProviderSequence === eventCount - 2, 'Seed provider sequence is incomplete')
  const assistant = state.messages?.find(
    (message) => message.role === 'assistant' && message.runId === run.id,
  )
  assert(
    assistant?.status === 'complete' && assistant.complete,
    'Seed assistant message is incomplete',
  )
  assert(
    assistant.text.includes(
      `Completed Braid performance conversation (${eventCount} committed events)`,
    ),
    'Seed assistant message has no useful recent content',
  )
  return state
}

export function assertUsefulViewport(view, eventCount) {
  assert(view && Array.isArray(view.messages), 'Viewport is missing transcript messages')
  assert(view.messages.length > 0, 'Viewport is empty for a seeded conversation')
  assert(
    view.messages.some((message) =>
      message.text.includes(
        `Completed Braid performance conversation (${eventCount} committed events)`,
      ),
    ),
    'Viewport does not show the seeded recent conversation content',
  )
  assert(
    view.messages.length <= 200,
    'Viewport rendered more than the bounded recent message window',
  )
  return view
}

async function fileBytes(path) {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

async function storageBytes(storage) {
  const artifacts = storage.artifacts()
  const database = await fileBytes(artifacts.database)
  const wal = await fileBytes(artifacts.wal)
  const sharedMemory = await fileBytes(artifacts.sharedMemory)
  return {
    database,
    wal,
    sharedMemory,
    total: database + wal + sharedMemory,
  }
}

export async function createEncryptedStorageFixture(eventCount, { packageRoot } = {}) {
  requireNativeSqlite()
  const { index, clock, journal, journalSupport, materializedState, state } =
    await runtime(packageRoot)
  const root = await mkdtemp(join(tmpdir(), `braid-performance-${eventCount}-`))
  const keyRoot = await mkdtemp(join(tmpdir(), 'braid-performance-key-'))
  const keyPath = join(keyRoot, 'database.key')
  try {
    await writeFile(keyPath, randomBytes(32), { mode: 0o600 })
    await chmod(keyPath, 0o600)
    const credentialRoot = join(root, '.credentials')
    const credentials = new FileCredentialStore(credentialRoot)
    const path = join(root, 'braid.sqlite')
    const databaseKeySource = { type: 'file', path: keyPath, workspaceRoot: root }
    let seeded = false
    const fixture = {
      eventCount,
      root,
      path,
      keyPath,
      credentialRoot,
      credentials,
      databaseKeySource,
      packageRoot,
      async open() {
        const storage = await index.openSqliteStorage({
          path,
          workspaceRoot: root,
          credentialStore: credentials,
          databaseKeySource,
          maxEventsPerTransaction: BATCH_SIZE,
          maxPayloadBytesPerTransaction: 8 * 1024 * 1024,
        })
        return storage
      },
      async seed() {
        if (seeded) return
        const storage = await fixture.open()
        try {
          const context = seedContext(eventCount, index, root)
          for (let offset = 1; offset <= eventCount; offset += BATCH_SIZE) {
            const events = []
            const end = Math.min(eventCount, offset + BATCH_SIZE - 1)
            for (let eventIndex = offset; eventIndex <= end; eventIndex += 1) {
              events.push(createPersistedEvent(eventCount, eventIndex, context))
            }
            await storage.append(events)
          }
          const projection = await storage.projection()
          assert(
            projection.eventCount === eventCount,
            `Seeded ${eventCount} events but projection reports ${projection.eventCount}`,
          )
          const integrity = await storage.integrity()
          assert(
            integrity.ok && integrity.encryption === 'verified',
            `Encrypted SQLite integrity failed for ${eventCount} events`,
          )
          const stored = await storage.events()
          const envelopes = journalSupport.envelopesFromStored(stored)
          const replayed = index.replayEvents(state.initialState(PROFILE), envelopes)
          assertValidConversationSeed(replayed, eventCount, root)
          const last = stored.at(-1)
          assert(last !== undefined, 'Performance seed has no final stored event')
          await storage.writeStateSnapshot(
            materializedState.createMaterializedStateSnapshot({
              scopeId: storage.snapshotScopeId(),
              generation: replayed.sequence,
              eventId: last.eventId,
              state: replayed,
            }),
          )
          const storageJournal = await journal.StorageJournal.fromStorage(
            storage,
            new clock.SystemClock(),
          )
          assert(
            storageJournal.initialState()?.sequence === eventCount,
            'Performance snapshot did not restore the complete state',
          )
          assert(
            storageJournal.replay().length === 0,
            'Final performance snapshot unexpectedly retained a journal tail',
          )
          seeded = true
        } finally {
          await storage.close()
        }
      },
      async bytes() {
        await fixture.seed()
        const storage = await fixture.open()
        try {
          const bytes = await storageBytes(storage)
          const integrity = await storage.integrity()
          assert(
            integrity.ok && integrity.encryption === 'verified',
            'Database integrity changed before byte measurement',
          )
          return bytes
        } finally {
          await storage.close()
        }
      },
      async cleanup() {
        await rm(root, { force: true, recursive: true })
        await rm(keyRoot, { force: true, recursive: true })
      },
    }
    return fixture
  } catch (error) {
    await rm(root, { force: true, recursive: true }).catch(() => undefined)
    await rm(keyRoot, { force: true, recursive: true }).catch(() => undefined)
    throw error
  }
}

export async function createHeadlessProductionProcessFixture(eventCount, { packageRoot } = {}) {
  const fixture = await createEncryptedStorageFixture(eventCount, { packageRoot })
  return prepareHeadlessProductionProcessFixture(fixture)
}

export async function prepareHeadlessProductionProcessFixture(fixture) {
  await fixture.seed()
  return {
    ...fixture,
    processMode: 'isolated-production-pty',
    database: `${fixture.eventCount}-event-encrypted-sqlite-headless-production`,
  }
}

export async function measureReplayReduce(fixture, repetitions) {
  const { index, journalSupport, state } = await runtime(fixture.packageRoot)
  await fixture.seed()
  const samples = []
  let finalState
  let eventCount = 0
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const startedAt = performance.now()
    const storage = await fixture.open()
    try {
      const envelopes = journalSupport.envelopesFromStored(await storage.events())
      finalState = index.replayEvents(state.initialState(PROFILE), envelopes)
      eventCount = envelopes.length
      samples.push(performance.now() - startedAt)
    } finally {
      await storage.close()
    }
  }
  assert(
    eventCount === fixture.eventCount,
    `Replay loaded ${eventCount} events instead of ${fixture.eventCount}`,
  )
  assert(
    finalState?.sequence === fixture.eventCount,
    'Replay sequence did not reach the seeded event count',
  )
  assert(finalState?.projectionChecksum, 'Replay did not produce a projection checksum')
  return { samples, eventCount, projectionChecksum: finalState.projectionChecksum }
}

export async function measureOpenViewport(fixture, repetitions) {
  const { index, tui } = await runtime(fixture.packageRoot)
  await fixture.seed()
  const samples = []
  const renderedRows = []
  const loadedTailEvents = []
  let eventCount = 0
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const startedAt = performance.now()
    const durable = await index.createDurableBraidApplication({
      path: fixture.path,
      workspaceRoot: fixture.root,
      credentialStore: fixture.credentials,
      databaseKeySource: fixture.databaseKeySource,
      profile: PROFILE,
    })
    try {
      const view = tui.buildBraidViewModel(
        durable.app.state(),
        'transcript',
        { color: 'none' },
        false,
      )
      samples.push(performance.now() - startedAt)
      eventCount = durable.app.state().sequence
      loadedTailEvents.push(durable.app.events().length)
      renderedRows.push(view.messages.length + (view.activity?.length ?? 0))
      assertUsefulViewport(view, fixture.eventCount)
      assert(
        view.messages.length <= 200,
        `Viewport rendered ${view.messages.length} messages from ${fixture.eventCount} events`,
      )
    } finally {
      await durable.app.close()
    }
  }
  assert(
    eventCount === fixture.eventCount,
    `Viewport opened ${eventCount} events instead of ${fixture.eventCount}`,
  )
  assert(
    loadedTailEvents.every((count) => count <= 256),
    'Viewport retained more than the bounded post-snapshot journal tail',
  )
  return { samples, eventCount, renderedRows, loadedTailEvents }
}

export async function measureResidentMemory(fixture, repetitions, childPath) {
  await fixture.seed()
  const { spawn } = await import('node:child_process')
  const samples = []
  const observations = []
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--expose-gc',
          childPath,
          fixture.path,
          fixture.root,
          fixture.keyPath,
          fixture.credentialRoot,
          fixture.packageRoot,
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, NO_COLOR: '1', NODE_NO_WARNINGS: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      child.once('error', reject)
      child.once('close', (code) => {
        if (code !== 0) {
          reject(new Error(`PERF-09 memory child failed with ${code}: ${stderr}`))
          return
        }
        try {
          resolve(JSON.parse(stdout.trim()))
        } catch (error) {
          reject(
            new Error(`PERF-09 memory child emitted invalid JSON: ${stdout}`, { cause: error }),
          )
        }
      })
    })
    assert(
      result.eventCount === fixture.eventCount,
      'PERF-09 child did not open the complete database',
    )
    assert(
      result.loadedTailEventCount <= 256,
      'PERF-09 child retained more than the bounded post-snapshot journal tail',
    )
    assert(result.renderedRows <= 200, 'PERF-09 child rendered more than the bounded viewport')
    assert(
      result.recentContent?.includes(
        `Completed Braid performance conversation (${fixture.eventCount} committed events)`,
      ),
      'PERF-09 child did not render useful recent seeded content',
    )
    samples.push(result.rssMiB)
    observations.push({
      baselineRssMiB: result.baselineRssMiB,
      openedRssMiB: result.rssMiB,
      loadedTailEventCount: result.loadedTailEventCount,
      renderedRows: result.renderedRows,
    })
  }
  return { samples, observations }
}

export async function measureDatabaseGrowth(eventCount, repetitions, { packageRoot } = {}) {
  const samples = []
  const observations = []
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const fixture = await createEncryptedStorageFixture(eventCount, { packageRoot })
    try {
      const bytes = await fixture.bytes()
      samples.push(bytes.total / (1024 * 1024))
      observations.push(bytes)
    } finally {
      await fixture.cleanup()
    }
  }
  return { samples, observations }
}

export async function createProductionProcessFixture(eventCount, { packageRoot } = {}) {
  requireNativeSqlite()
  const { index, clock, journal, state } = await runtime(packageRoot)
  const credentials = index.createOperatingSystemCredentialStore()
  await assertCredentialFacility(credentials)
  const root = await mkdtemp(join(tmpdir(), `braid-packed-performance-${eventCount}-`))
  const configDirectory = join(root, '.braid')
  const configPath = join(configDirectory, 'config.json')
  const path = join(root, 'braid.sqlite')
  const credentialRef = `cred:v1:database-${createHash('sha256').update(path).digest('hex')}`
  try {
    const connection = {
      id: 'connection-performance-local',
      kind: 'cli-bridge',
      name: 'Performance local bridge',
      endpoint: 'http://127.0.0.1:9',
      providerOptions: { transport: 'local' },
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
      lastHealth: { status: 'unknown' },
    }
    const config = {
      format: 'braid-startup-config',
      schemaVersion: 2,
      profile: PROFILE,
      connectionId: connection.id,
      connections: [connection],
    }
    const { mkdir } = await import('node:fs/promises')
    await mkdir(configDirectory, { recursive: true, mode: 0o700 })
    await writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 })
    const storage = await index.openSqliteStorage({
      path,
      workspaceRoot: root,
      credentialStore: credentials,
      maxEventsPerTransaction: BATCH_SIZE,
      maxPayloadBytesPerTransaction: 8 * 1024 * 1024,
    })
    try {
      const context = seedContext(eventCount, index, root)
      for (let offset = 1; offset <= eventCount; offset += BATCH_SIZE) {
        const events = []
        const end = Math.min(eventCount, offset + BATCH_SIZE - 1)
        for (let eventIndex = offset; eventIndex <= end; eventIndex += 1)
          events.push(createPersistedEvent(eventCount, eventIndex, context))
        await storage.append(events)
      }
      const projection = await storage.projection()
      assert(
        projection.eventCount === eventCount,
        `Packed process database seed reports ${projection.eventCount} events`,
      )
      const integrity = await storage.integrity()
      assert(
        integrity.ok && integrity.encryption === 'verified',
        `Packed process encrypted SQLite integrity failed for ${eventCount} events`,
      )
      const storageJournal = await journal.StorageJournal.fromStorage(
        storage,
        new clock.SystemClock(),
      )
      const replayed = index.replayEvents(state.initialState(PROFILE), storageJournal.all())
      assertValidConversationSeed(replayed, eventCount, root)
    } finally {
      await storage.close()
    }
    return {
      eventCount,
      root,
      path,
      configPath,
      packageRoot,
      database: eventCount === 0 ? 'warm-empty' : `${eventCount}-event`,
      async cleanup() {
        await credentials.remove(credentialRef).catch(() => undefined)
        await rm(root, { force: true, recursive: true })
      },
    }
  } catch (error) {
    await credentials.remove(credentialRef).catch(() => undefined)
    await rm(root, { force: true, recursive: true }).catch(() => undefined)
    throw error
  }
}

export { FIXED_TIME, PROFILE }
