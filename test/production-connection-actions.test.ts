import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ProductionConnectionOptions } from '../src/adapters/connections/production-connections.js'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import type { BraidApplication } from '../src/app/application.js'
import {
  createBraidApplication,
  createDurableBraidApplication,
  DETERMINISTIC_PROFILE,
} from '../src/app/composition.js'
import { ConnectionActionService } from '../src/app/connection-actions.js'
import { ConnectionError, ConnectionRemovalError } from '../src/app/connection-errors.js'
import { ConnectionRegistry } from '../src/app/connections.js'
import { MemoryJournal } from '../src/app/journal.js'
import { createProfileRecord } from '../src/app/profiles.js'
import { ProductionConnectionActions } from '../src/bin/production-connection-actions.js'
import { recoverPendingConnectionCredentialRemoval } from '../src/bin/production-connection-credential-cleanup.js'
import { defaultProductionCredentialRefResolver } from '../src/bin/production-credential-reference.js'
import { saveProductionStartupSelection } from '../src/bin/production-setup.js'
import { loadProductionStartup } from '../src/bin/production-startup.js'
import type { ConnectionKind, ConnectionRecord, IsoDateTime } from '../src/domain/entities.js'
import type { BraidEventEnvelope } from '../src/domain/events.js'
import { createConnectionId, createCredentialRefId } from '../src/domain/ids.js'
import { FixedClock } from '../src/ports/clock.js'
import { type CredentialPort, type CredentialRef, credentialRef } from '../src/ports/credentials.js'

const at = '2026-08-09T00:00:00.000Z'

function connection(
  kind: ConnectionKind,
  id: string,
  credential?: ReturnType<typeof createCredentialRefId>,
): ConnectionRecord {
  return {
    id: createConnectionId(`connection-${id}`),
    kind,
    name: `${kind} ${id}`,
    endpoint: kind === 'cli-bridge' ? 'http://127.0.0.1:3344' : 'https://router.example.test',
    ...(credential === undefined ? {} : { credentialRef: credential }),
    providerOptions: { transport: kind === 'cli-bridge' ? 'local' : 'https' },
    createdAt: at,
    updatedAt: at,
    lastHealth: { status: 'unknown' },
  }
}

function portCredentialRef(ref: ReturnType<typeof createCredentialRefId>): CredentialRef {
  return credentialRef(`cred:v1:${ref}`)
}

function startupSelection(connection: ConnectionRecord) {
  const profile = createProfileRecord(
    {
      kind: 'inline',
      reference: 'braid:production-connection-actions-test',
      label: 'Production connection actions test profile',
      writable: false,
      trusted: true,
    },
    DETERMINISTIC_PROFILE,
  )
  const connectionDigest = new ConnectionRegistry([connection]).select({
    connectionId: connection.id,
  }).digest
  return {
    profile,
    connection,
    profileDigest: profile.digest,
    connectionDigest,
  }
}

interface StartupDocument {
  readonly connectionId?: string
  readonly connections?: readonly ConnectionRecord[]
}

async function readStartupDocument(path: string): Promise<StartupDocument> {
  return JSON.parse(await readFile(path, 'utf8')) as StartupDocument
}

class FailingJournal extends MemoryJournal {
  #failed = false

  fail(): void {
    this.#failed = true
  }

  override append(envelope: BraidEventEnvelope): {
    readonly appended: boolean
    readonly duplicate: boolean
  } {
    if (this.#failed) throw new Error('injected connection action failure')
    return super.append(envelope)
  }
}

class RecordingCredentialStore implements CredentialPort {
  readonly #backing: MemoryCredentialStore
  beforeRemove?: (ref: CredentialRef) => Promise<void>

  constructor(backing: MemoryCredentialStore) {
    this.#backing = backing
  }

  store(input: Parameters<MemoryCredentialStore['store']>[0]): Promise<CredentialRef> {
    return this.#backing.store(input)
  }

  resolve(ref: Parameters<MemoryCredentialStore['resolve']>[0]) {
    return this.#backing.resolve(ref)
  }

  async remove(ref: Parameters<MemoryCredentialStore['remove']>[0]): Promise<void> {
    await this.beforeRemove?.(ref)
    await this.#backing.remove(ref)
  }

  available(): Promise<boolean> {
    return this.#backing.available()
  }
}

interface FixtureOptions {
  readonly records: readonly ConnectionRecord[]
  readonly selected: ConnectionRecord
  readonly durable?: boolean
  readonly chunkDelayMs?: number
  readonly journal?: MemoryJournal
  readonly credentials?: MemoryCredentialStore
  readonly credentialStore?: CredentialPort
  readonly productionConnection?: ProductionConnectionOptions
  readonly credentialRefResolver?: ProductionConnectionOptions['credentialRefResolver']
  readonly now?: () => IsoDateTime
}

interface Fixture {
  readonly workspace: string
  readonly configPath: string
  readonly app: BraidApplication
  readonly catalog: ConnectionRegistry
  readonly actions: ProductionConnectionActions
  readonly credentials: MemoryCredentialStore
  readonly journal: MemoryJournal
  readonly credentialStore: CredentialPort
  readonly close: () => Promise<void>
}

async function createFixture(options: FixtureOptions): Promise<Fixture> {
  const workspace = await mkdtemp(join(tmpdir(), 'braid-production-connection-actions-'))
  const configPath = join(workspace, '.braid', 'config.json')
  const clock = new FixedClock(at)
  const credentials = options.credentials ?? new MemoryCredentialStore()
  const credentialStore = options.credentialStore ?? credentials
  const resolver = options.credentialRefResolver ?? defaultProductionCredentialRefResolver
  const catalog = new ConnectionRegistry(options.records)
  const journal = options.journal ?? new MemoryJournal(clock)

  for (const record of options.records) {
    if (record.credentialRef !== undefined) {
      await credentialStore.store({
        ref: await resolver(record.credentialRef),
        value: Buffer.from(`seed-${record.id}`),
      })
    }
  }

  let app: BraidApplication
  let durableStorage: Awaited<ReturnType<typeof createDurableBraidApplication>>['storage']
  const production = {
    profile: DETERMINISTIC_PROFILE,
    connections: options.records,
    connectionId: options.selected.id,
    workspaceRoot: workspace,
    connectionOptions: {
      credentials: credentialStore,
      credentialRefResolver: resolver,
    },
  }
  if (options.durable) {
    const durable = await createDurableBraidApplication({
      path: join(workspace, 'braid.db'),
      storageRoot: workspace,
      workspaceRoot: workspace,
      credentialStore,
      production,
      connectionRegistry: catalog,
      clock,
    })
    app = durable.app
    durableStorage = durable.storage
  } else {
    app = createBraidApplication({
      fixture: 'deterministic',
      profile: DETERMINISTIC_PROFILE,
      clock,
      journal,
      effectStorage: journal,
      ...(options.chunkDelayMs === undefined ? {} : { chunkDelayMs: options.chunkDelayMs }),
    })
  }

  app.initialize(workspace)
  await app.whenDurable()
  const seed = new ConnectionActionService({
    host: {
      state: () => app.state(),
      configuration: app.configuration,
      runtime: app.runtimeSelection,
    },
    connections: options.records,
    now: () => at,
  })
  for (const [index, record] of options.records.entries()) {
    await seed.upsert({ operationId: `operation-seed-connection-${index}`, record })
  }
  await seed.select({
    operationId: 'operation-seed-connection-selection',
    connectionId: options.selected.id,
  })
  await app.whenDurable()

  await saveProductionStartupSelection(configPath, startupSelection(options.selected), {
    connections: options.records,
  })
  const startupOptions = {
    workspace,
    configPath,
    credentialStore,
    credentialRefResolver: resolver,
  }
  const actions = new ProductionConnectionActions({
    currentApp: () => app,
    currentCatalog: () => catalog,
    configPath,
    startupOptions,
    productionConnection: {
      ...(options.productionConnection ?? {}),
      credentials: credentialStore,
      credentialRefResolver: resolver,
    },
    now: options.now ?? (() => at),
  })
  return {
    workspace,
    configPath,
    app,
    catalog,
    actions,
    credentials,
    journal,
    credentialStore,
    close: async () => {
      try {
        await app.close()
      } finally {
        await durableStorage?.close().catch(() => undefined)
      }
    },
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for application state')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('create stores Tangle authentication by reference and updates config, catalog, and events', async () => {
  const base = connection('cli-bridge', 'create-base')
  const fixture = await createFixture({ records: [base], selected: base })
  const rawCredential = 'tangle-create-only-in-memory-secret'
  try {
    const created = await fixture.actions.create({
      operationId: 'operation-production-create-tangle',
      draft: {
        kind: 'tangle-inference',
        name: 'Created Tangle Inference',
        endpoint: 'https://router.created.example.test',
      },
      credential: Buffer.from(rawCredential),
    })
    assert.equal(created.replayed, false)
    assert.equal(created.connection.kind, 'tangle-inference')
    assert.equal(created.connection.credentialConfigured, true)

    const createdRecord = fixture.app
      .state()
      .connections.find((record) => record.id === created.connection.id)
    assert.ok(createdRecord)
    if (!createdRecord?.credentialRef)
      throw new Error('created Tangle record has no credential ref')
    const storedRef = portCredentialRef(createdRecord.credentialRef)
    assert.equal(fixture.credentials.has(storedRef), true)
    assert.equal(fixture.catalog.get(createdRecord.id)?.credentialRef, createdRecord.credentialRef)

    const document = await readStartupDocument(fixture.configPath)
    const persisted = document.connections?.find((record) => record.id === createdRecord.id)
    assert.ok(persisted)
    assert.equal(persisted?.credentialRef, createdRecord.credentialRef)
    assert.equal(document.connectionId, base.id)

    const event = fixture.app
      .events()
      .map(({ event }) => event)
      .filter((event) => event.kind === 'connection.upserted')
      .at(-1)
    assert.equal(event?.kind, 'connection.upserted')
    if (event?.kind === 'connection.upserted') {
      assert.equal(event.connection.id, createdRecord.id)
      assert.equal(event.connection.credentialRef, createdRecord.credentialRef)
    }

    for (const serialized of [
      JSON.stringify(createdRecord),
      JSON.stringify(fixture.catalog.list()),
      JSON.stringify(fixture.app.events()),
      await readFile(fixture.configPath, 'utf8'),
    ]) {
      assert.equal(serialized.includes(rawCredential), false)
    }
    const handle = await fixture.credentials.resolve(storedRef)
    try {
      assert.equal(new TextDecoder().decode(handle.read()), rawCredential)
    } finally {
      handle.dispose()
    }
  } finally {
    await fixture.close()
  }
})

test('select persists the selected connection and updates the live runtime selection in a durable app', async () => {
  const base = connection('cli-bridge', 'select-base')
  const alternate = connection('cli-bridge', 'select-alternate')
  const fixture = await createFixture({
    records: [base, alternate],
    selected: base,
    durable: true,
  })
  try {
    const selected = await fixture.actions.select({
      operationId: 'operation-production-select-alternate',
      connectionId: alternate.id,
    })
    assert.equal(selected.replayed, false)
    assert.equal(fixture.app.state().selectedConnectionId, alternate.id)
    assert.equal(fixture.app.runtimeSelection.connectionId(), alternate.id)
    assert.deepEqual(
      fixture.catalog
        .list()
        .map((record) => record.id)
        .sort(),
      [base.id, alternate.id].sort(),
    )

    const document = await readStartupDocument(fixture.configPath)
    assert.equal(document.connectionId, alternate.id)
    assert.deepEqual(
      document.connections?.map((record) => record.id).sort(),
      [base.id, alternate.id].sort(),
    )
    const reloaded = await loadProductionStartup({
      workspace: fixture.workspace,
      configPath: fixture.configPath,
    })
    assert.equal(reloaded.connectionId, alternate.id)
    assert.equal(
      fixture.app
        .events()
        .some(
          ({ event }) =>
            event.kind === 'connection.selected' && event.connectionId === alternate.id,
        ),
      true,
    )
  } finally {
    await fixture.close()
  }
})

test('remove is blocked before persistence when the target is selected', async () => {
  const target = connection('cli-bridge', 'remove-selected')
  const fallback = connection('cli-bridge', 'remove-selected-fallback')
  const fixture = await createFixture({ records: [target, fallback], selected: target })
  try {
    const beforeConfig = await readFile(fixture.configPath, 'utf8')
    const beforeEvents = fixture.app.events().length
    const beforeCatalog = fixture.catalog.list()
    await assert.rejects(
      fixture.actions.remove({
        operationId: 'operation-production-remove-selected',
        connectionId: target.id,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ConnectionRemovalError)
        assert.deepEqual(
          error.blockers.map((blocker) => blocker.kind),
          ['selected'],
        )
        return true
      },
    )
    assert.equal(await readFile(fixture.configPath, 'utf8'), beforeConfig)
    assert.equal(fixture.app.events().length, beforeEvents)
    assert.deepEqual(fixture.catalog.list(), beforeCatalog)
  } finally {
    await fixture.close()
  }
})

test('remove is blocked while an active run still references the target connection', async () => {
  const base = connection('cli-bridge', 'remove-active-base')
  const target = connection('cli-bridge', 'remove-active-target')
  const fixture = await createFixture({
    records: [base, target],
    selected: base,
    chunkDelayMs: 250,
  })
  try {
    await fixture.actions.select({
      operationId: 'operation-production-select-active-target',
      connectionId: target.id,
    })
    const send = fixture.app.send({
      operationId: 'operation-production-active-run',
      text: 'keep this target connection active',
    })
    await send.admissionReady
    await waitUntil(() => fixture.app.state().activeRunId === send.runId)
    await fixture.actions.select({
      operationId: 'operation-production-select-active-fallback',
      connectionId: base.id,
    })
    const preview = fixture.actions.previewRemoval(target.id)
    assert.equal(
      preview.blockers.some((blocker) => blocker.kind === 'run'),
      true,
    )
    await assert.rejects(
      fixture.actions.remove({
        operationId: 'operation-production-remove-active',
        connectionId: target.id,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ConnectionRemovalError)
        assert.equal(
          error.blockers.some((blocker) => blocker.kind === 'run'),
          true,
        )
        return true
      },
    )
  } finally {
    fixture.app.cancelActive()
    await fixture.app.waitForIdle().catch(() => undefined)
    await sendCompletionIfNeeded(fixture.app)
    await fixture.close()
  }
})

async function sendCompletionIfNeeded(app: BraidApplication): Promise<void> {
  if (app.state().activeRunId !== null) await app.waitForIdle()
}

test('safe remove keeps historical receipts, deletes only an unshared credential after metadata, and retains shared credentials', async () => {
  const targetCredential = createCredentialRefId('credential-remove-unique')
  const sharedCredential = createCredentialRefId('credential-remove-shared')
  const base = connection('cli-bridge', 'remove-safe-base')
  const target = connection('tangle-inference', 'remove-safe-target', targetCredential)
  const sharedFirst = connection('tangle-inference', 'remove-safe-shared-first', sharedCredential)
  const sharedSecond = connection('tangle-inference', 'remove-safe-shared-second', sharedCredential)
  const backing = new MemoryCredentialStore()
  const recording = new RecordingCredentialStore(backing)
  const fixture = await createFixture({
    records: [base, target, sharedFirst, sharedSecond],
    selected: base,
    credentials: backing,
    credentialStore: recording,
  })
  const observations: Array<{
    readonly ref: CredentialRef
    readonly configHasTarget: boolean
    readonly catalogHasTarget: boolean
    readonly hasRemovalEvent: boolean
    readonly storeHadCredential: boolean
  }> = []
  recording.beforeRemove = async (ref) => {
    const config = await readStartupDocument(fixture.configPath)
    observations.push({
      ref,
      configHasTarget: config.connections?.some((record) => record.id === target.id) ?? false,
      catalogHasTarget: fixture.catalog.get(target.id) !== undefined,
      hasRemovalEvent: fixture.app
        .events()
        .some(
          ({ event }) => event.kind === 'connection.removed' && event.connectionId === target.id,
        ),
      storeHadCredential: backing.has(ref),
    })
  }
  try {
    await fixture.actions.select({
      operationId: 'operation-production-history-target',
      connectionId: target.id,
    })
    const historicalReceipt = await fixture.app.send({
      operationId: 'operation-production-history-run',
      text: 'create a historical receipt',
    }).completion
    const historicalRun = historicalReceipt.runs.find(
      (run) => run.operationId === 'operation-production-history-run',
    )
    assert.ok(historicalRun)
    assert.equal(historicalRun?.receipt.requested.connectionId, target.id)
    await fixture.actions.select({
      operationId: 'operation-production-history-fallback',
      connectionId: base.id,
    })

    await fixture.actions.remove({
      operationId: 'operation-production-remove-unique',
      connectionId: target.id,
    })
    assert.equal(backing.has(portCredentialRef(targetCredential)), false)
    assert.equal(observations.length, 1)
    assert.equal(observations[0]?.configHasTarget, false)
    assert.equal(observations[0]?.catalogHasTarget, false)
    assert.equal(observations[0]?.hasRemovalEvent, true)
    assert.equal(observations[0]?.storeHadCredential, true)
    assert.equal(
      fixture.app.state().runs.some((run) => run.id === historicalRun?.id),
      true,
    )
    assert.equal(
      fixture.app
        .events()
        .some(
          ({ event }) => event.kind === 'connection.removed' && event.connectionId === target.id,
        ),
      true,
    )

    await fixture.actions.remove({
      operationId: 'operation-production-remove-shared',
      connectionId: sharedFirst.id,
    })
    assert.equal(backing.has(portCredentialRef(sharedCredential)), true)
    const finalDocument = await readStartupDocument(fixture.configPath)
    assert.equal(
      finalDocument.connections?.some((record) => record.id === sharedFirst.id),
      false,
    )
    assert.equal(
      finalDocument.connections?.some((record) => record.id === sharedSecond.id),
      true,
    )
  } finally {
    await fixture.close()
  }
})

test('removal retains credentials when different durable ids map to one protected value', async () => {
  const firstCredential = createCredentialRefId('credential-alias-first')
  const secondCredential = createCredentialRefId('credential-alias-second')
  const sharedPortRef = credentialRef('cred:v1:credential-alias-shared-value')
  const base = connection('cli-bridge', 'remove-alias-base')
  const first = connection('tangle-inference', 'remove-alias-first', firstCredential)
  const second = connection('tangle-inference', 'remove-alias-second', secondCredential)
  const credentials = new MemoryCredentialStore()
  const fixture = await createFixture({
    records: [base, first, second],
    selected: base,
    credentials,
    credentialRefResolver: () => sharedPortRef,
  })
  try {
    await fixture.actions.remove({
      operationId: 'operation-remove-aliased-credential',
      connectionId: first.id,
    })
    assert.equal(credentials.has(sharedPortRef), true)
    assert.equal(fixture.catalog.get(first.id), undefined)
    assert.ok(fixture.catalog.get(second.id))
  } finally {
    await fixture.close()
  }
})

test('startup and replay repair an earlier credential cleanup failure from its durable record', async () => {
  const targetCredential = createCredentialRefId('credential-remove-repair')
  const base = connection('cli-bridge', 'remove-repair-base')
  const target = connection('tangle-inference', 'remove-repair-target', targetCredential)
  const backing = new MemoryCredentialStore()
  const recording = new RecordingCredentialStore(backing)
  const fixture = await createFixture({
    records: [base, target],
    selected: base,
    credentials: backing,
    credentialStore: recording,
  })
  let failCleanup = true
  recording.beforeRemove = async () => {
    if (failCleanup) throw new Error('injected credential cleanup failure')
  }
  try {
    const expectedRevision = fixture.app.state().revision
    const removed = await fixture.actions.remove({
      operationId: 'operation-remove-repair',
      connectionId: target.id,
      expectedRevision,
    })
    assert.equal(removed.replayed, false)
    assert.equal(backing.has(portCredentialRef(targetCredential)), true)
    assert.match(fixture.app.cleanupUncertain() ?? '', /credential cleanup is pending/u)
    const markerPath = `${fixture.configPath}.pending-credential-removal`
    await access(markerPath)

    failCleanup = false
    await loadProductionStartup({
      workspace: fixture.workspace,
      configPath: fixture.configPath,
      credentialStore: recording,
    })
    assert.equal(backing.has(portCredentialRef(targetCredential)), false)
    await assert.rejects(() => access(markerPath))
    const repaired = await fixture.actions.remove({
      operationId: 'operation-remove-repair',
      connectionId: target.id,
      expectedRevision,
    })
    assert.equal(repaired.replayed, true)
    assert.equal(backing.has(portCredentialRef(targetCredential)), false)
  } finally {
    await fixture.close()
  }
})

test('removal records the latest saved identity before cleanup and replays that exact record', async () => {
  const staleCredential = createCredentialRefId('credential-remove-stale-identity')
  const savedCredential = createCredentialRefId('credential-remove-saved-identity')
  const base = connection('cli-bridge', 'remove-identity-base')
  const stale = connection('tangle-inference', 'remove-identity-target', staleCredential)
  const saved: ConnectionRecord = {
    ...stale,
    name: 'Latest saved target',
    endpoint: 'https://router.latest.example.test',
    credentialRef: savedCredential,
    updatedAt: '2026-08-09T01:00:00.000Z',
  }
  const backing = new MemoryCredentialStore()
  const recording = new RecordingCredentialStore(backing)
  const fixture = await createFixture({
    records: [base, stale],
    selected: base,
    credentials: backing,
    credentialStore: recording,
  })
  let failCleanup = true
  recording.beforeRemove = async () => {
    if (failCleanup) throw new Error('injected latest-identity cleanup failure')
  }
  try {
    await backing.store({
      ref: portCredentialRef(savedCredential),
      value: Buffer.from('latest-saved-credential'),
    })
    fixture.catalog.upsert(saved)
    await saveProductionStartupSelection(fixture.configPath, startupSelection(base), {
      connections: [base, saved],
    })

    const removed = await fixture.actions.remove({
      operationId: 'operation-remove-latest-saved-identity',
      connectionId: saved.id,
    })
    assert.equal(removed.replayed, false)
    const events = fixture.app.events().map(({ event }) => event)
    const removalIndex = events.findIndex(
      (event) => event.kind === 'connection.removed' && event.connectionId === saved.id,
    )
    const savedUpsert = [...events.slice(0, removalIndex)]
      .reverse()
      .find((event) => event.kind === 'connection.upserted' && event.connection.id === saved.id)
    assert.ok(savedUpsert?.kind === 'connection.upserted')
    if (savedUpsert?.kind !== 'connection.upserted') return
    assert.deepEqual(savedUpsert.connection, saved)
    assert.equal(backing.has(portCredentialRef(savedCredential)), true)
    assert.equal(backing.has(portCredentialRef(staleCredential)), true)

    failCleanup = false
    await loadProductionStartup({
      workspace: fixture.workspace,
      configPath: fixture.configPath,
      credentialStore: recording,
    })
    assert.equal(backing.has(portCredentialRef(savedCredential)), false)
    assert.equal(backing.has(portCredentialRef(staleCredential)), true)
    const replayed = await fixture.actions.remove({
      operationId: 'operation-remove-latest-saved-identity',
      connectionId: saved.id,
    })
    assert.equal(replayed.replayed, true)
  } finally {
    await fixture.close()
  }
})

test('one config lock preserves a second removal while the first credential deletion is pending', async () => {
  const firstCredential = createCredentialRefId('credential-concurrent-remove-first')
  const secondCredential = createCredentialRefId('credential-concurrent-remove-second')
  const base = connection('cli-bridge', 'concurrent-remove-base')
  const first = connection('tangle-inference', 'concurrent-remove-first', firstCredential)
  const second = connection('tangle-inference', 'concurrent-remove-second', secondCredential)
  const backing = new MemoryCredentialStore()
  const recording = new RecordingCredentialStore(backing)
  const fixture = await createFixture({
    records: [base, first, second],
    selected: base,
    credentials: backing,
    credentialStore: recording,
  })
  let releaseDeletion: (() => void) | undefined
  let markDeletionEntered: (() => void) | undefined
  const deletionEntered = new Promise<void>((resolve) => {
    markDeletionEntered = resolve
  })
  const deletionReleased = new Promise<void>((resolve) => {
    releaseDeletion = resolve
  })
  recording.beforeRemove = async (ref) => {
    if (ref !== portCredentialRef(firstCredential)) return
    markDeletionEntered?.()
    await deletionReleased
  }
  const secondActions = new ProductionConnectionActions({
    currentApp: () => fixture.app,
    currentCatalog: () => fixture.catalog,
    configPath: fixture.configPath,
    startupOptions: {
      workspace: fixture.workspace,
      configPath: fixture.configPath,
      credentialStore: recording,
      credentialRefResolver: defaultProductionCredentialRefResolver,
    },
    productionConnection: {
      credentials: recording,
      credentialRefResolver: defaultProductionCredentialRefResolver,
    },
    now: () => at,
  })
  try {
    const firstRemoval = fixture.actions.remove({
      operationId: 'operation-concurrent-remove-first',
      connectionId: first.id,
    })
    await deletionEntered
    await assert.rejects(
      secondActions.remove({
        operationId: 'operation-concurrent-remove-second',
        connectionId: second.id,
      }),
      /busy in another process/iu,
    )
    assert.ok(fixture.catalog.get(second.id))
    assert.equal(
      (await readStartupDocument(fixture.configPath)).connections?.some(
        (record) => record.id === second.id,
      ),
      true,
    )
    await access(`${fixture.configPath}.pending-credential-removal`)
    releaseDeletion?.()
    await firstRemoval
    assert.equal(backing.has(portCredentialRef(firstCredential)), false)
    assert.equal(backing.has(portCredentialRef(secondCredential)), true)
    assert.ok(fixture.catalog.get(second.id))
  } finally {
    releaseDeletion?.()
    await fixture.close()
  }
})

test('custom credential cleanup retains its marker and secret until its resolver returns', async () => {
  const targetCredential = createCredentialRefId('credential-custom-recovery-target')
  const remainingCredential = createCredentialRefId('credential-custom-recovery-remaining')
  const sharedPortRef = credentialRef('cred:v1:custom-recovery-shared')
  const base = connection('cli-bridge', 'custom-recovery-base')
  const remaining = connection('tangle-inference', 'custom-recovery-remaining', remainingCredential)
  const resolver = () => sharedPortRef
  const fixture = await createFixture({
    records: [base, remaining],
    selected: base,
    credentialRefResolver: resolver,
  })
  const markerPath = `${fixture.configPath}.pending-credential-removal`
  try {
    await writeFile(
      markerPath,
      `${JSON.stringify({
        format: 'braid-pending-connection-credential-removal',
        schemaVersion: 2,
        operationId: 'operation-custom-recovery-marker',
        connectionId: createConnectionId('connection-custom-recovery-target'),
        credentialId: targetCredential,
        portRef: sharedPortRef,
        mapping: 'custom',
      })}\n`,
      { mode: 0o600 },
    )
    await assert.rejects(
      recoverPendingConnectionCredentialRemoval(fixture.configPath, {
        credentialStore: fixture.credentials,
      }),
      /requires the custom credential reference resolver/iu,
    )
    await access(markerPath)
    assert.equal(fixture.credentials.has(sharedPortRef), true)

    await recoverPendingConnectionCredentialRemoval(fixture.configPath, {
      credentialStore: fixture.credentials,
      credentialRefResolver: resolver,
    })
    await assert.rejects(() => access(markerPath))
    assert.equal(fixture.credentials.has(sharedPortRef), true)
  } finally {
    await fixture.close()
  }
})

test('credential cleanup rejects a marker whose durable and protected references disagree', async () => {
  const targetCredential = createCredentialRefId('credential-mismatched-marker-target')
  const unrelatedRef = credentialRef('cred:v1:mismatched-marker-unrelated')
  const base = connection('cli-bridge', 'mismatched-marker-base')
  const fixture = await createFixture({ records: [base], selected: base })
  const markerPath = `${fixture.configPath}.pending-credential-removal`
  try {
    await fixture.credentials.store({
      ref: unrelatedRef,
      value: Buffer.from('unrelated-protected-secret'),
    })
    await writeFile(
      markerPath,
      `${JSON.stringify({
        format: 'braid-pending-connection-credential-removal',
        schemaVersion: 2,
        operationId: 'operation-mismatched-recovery-marker',
        connectionId: createConnectionId('connection-mismatched-recovery-target'),
        credentialId: targetCredential,
        portRef: unrelatedRef,
        mapping: 'default',
      })}\n`,
      { mode: 0o600 },
    )
    await assert.rejects(
      recoverPendingConnectionCredentialRemoval(fixture.configPath, {
        credentialStore: fixture.credentials,
      }),
      /mismatched protected reference/iu,
    )
    await access(markerPath)
    assert.equal(fixture.credentials.has(unrelatedRef), true)
  } finally {
    await fixture.close()
  }
})

test('removal resumes after config committed but the durable removal event was interrupted', async () => {
  const targetCredential = createCredentialRefId('credential-remove-interrupted')
  const base = connection('cli-bridge', 'remove-interrupted-base')
  const target = connection('tangle-inference', 'remove-interrupted-target', targetCredential)
  const fixture = await createFixture({ records: [base, target], selected: base })
  try {
    await saveProductionStartupSelection(fixture.configPath, startupSelection(base), {
      connections: [base],
    })
    fixture.catalog.remove({ connectionId: target.id })
    assert.equal(
      fixture.app.state().connections.some((record) => record.id === target.id),
      true,
    )

    const removed = await fixture.actions.remove({
      operationId: 'operation-remove-interrupted-resume',
      connectionId: target.id,
      expectedRevision: fixture.app.state().revision,
    })
    assert.equal(removed.replayed, false)
    assert.equal(
      fixture.app.state().connections.some((record) => record.id === target.id),
      false,
    )
    assert.equal(fixture.credentials.has(portCredentialRef(targetCredential)), false)
    assert.equal(
      (await readStartupDocument(fixture.configPath)).connections?.some(
        (record) => record.id === target.id,
      ),
      false,
    )
  } finally {
    await fixture.close()
  }
})

test('config is restored and the live catalog stays unchanged when the durable action fails', async () => {
  const base = connection('cli-bridge', 'failure-base')
  const journal = new FailingJournal(new FixedClock(at))
  const fixture = await createFixture({ records: [base], selected: base, journal })
  const candidate = connection('cli-bridge', 'failure-candidate')
  try {
    const beforeConfig = await readFile(fixture.configPath, 'utf8')
    const beforeCatalog = fixture.catalog.list()
    journal.fail()
    await assert.rejects(
      fixture.actions.upsert({
        operationId: 'operation-production-action-failure',
        record: candidate,
      }),
      /injected connection action failure/u,
    )
    assert.equal(await readFile(fixture.configPath, 'utf8'), beforeConfig)
    assert.deepEqual(fixture.catalog.list(), beforeCatalog)
    assert.equal(fixture.catalog.get(candidate.id), undefined)
    assert.equal(
      fixture.app.state().connections.some((record) => record.id === candidate.id),
      false,
    )
    assert.equal(
      fixture.app
        .events()
        .some(
          ({ event }) =>
            event.kind === 'connection.upserted' && event.connection.id === candidate.id,
        ),
      false,
    )
  } finally {
    await fixture.close().catch(() => undefined)
  }
})

test('headless upsert rejects a remote cleartext endpoint before changing product state', async () => {
  const base = connection('cli-bridge', 'insecure-base')
  const fixture = await createFixture({ records: [base], selected: base })
  const remote = {
    ...connection('cli-bridge', 'insecure-remote'),
    endpoint: 'http://bridge.example.test',
  }
  try {
    const beforeConfig = await readFile(fixture.configPath, 'utf8')
    await assert.rejects(
      fixture.actions.upsert({
        operationId: 'operation-insecure-remote-upsert',
        record: remote,
      }),
      (error: unknown) =>
        error instanceof ConnectionError && error.code === 'CONNECTION_ENDPOINT_INSECURE',
    )
    assert.equal(await readFile(fixture.configPath, 'utf8'), beforeConfig)
    assert.equal(fixture.catalog.get(remote.id), undefined)
  } finally {
    await fixture.close()
  }
})

test('headless upsert rejects an opaque credential id with no protected value', async () => {
  const base = connection('cli-bridge', 'missing-credential-base')
  const fixture = await createFixture({ records: [base], selected: base })
  const candidate = connection(
    'tangle-inference',
    'missing-credential-target',
    createCredentialRefId('credential-missing-protected-value'),
  )
  try {
    const beforeConfig = await readFile(fixture.configPath, 'utf8')
    await assert.rejects(
      fixture.actions.upsert({
        operationId: 'operation-missing-protected-credential',
        record: candidate,
      }),
      (error: unknown) =>
        error instanceof ConnectionError && error.code === 'CONNECTION_CREDENTIAL_UNAVAILABLE',
    )
    assert.equal(await readFile(fixture.configPath, 'utf8'), beforeConfig)
    assert.equal(fixture.catalog.get(candidate.id), undefined)
  } finally {
    await fixture.close()
  }
})

test('headless upsert cannot replace or drop a saved credential reference', async () => {
  const originalCredential = createCredentialRefId('credential-upsert-original')
  const replacementCredential = createCredentialRefId('credential-upsert-replacement')
  const base = connection('cli-bridge', 'credential-change-base')
  const target = connection('tangle-inference', 'credential-change-target', originalCredential)
  const fixture = await createFixture({ records: [base, target], selected: base })
  await fixture.credentials.store({
    ref: portCredentialRef(replacementCredential),
    value: Buffer.from('replacement-was-never-attached'),
  })
  try {
    const beforeConfig = await readFile(fixture.configPath, 'utf8')
    const { credentialRef: _savedCredential, ...withoutCredential } = target
    for (const [operationId, credential] of [
      ['operation-replace-protected-credential', replacementCredential],
      ['operation-drop-protected-credential', undefined],
    ] as const) {
      await assert.rejects(
        fixture.actions.upsert({
          operationId,
          record:
            credential === undefined
              ? { ...withoutCredential, name: 'Credential mutation must fail' }
              : {
                  ...target,
                  name: 'Credential mutation must fail',
                  credentialRef: credential,
                },
        }),
        (error: unknown) =>
          error instanceof ConnectionError &&
          error.code === 'CONNECTION_CREDENTIAL_CHANGE_REQUIRES_SECURE_FLOW',
      )
    }
    assert.equal(await readFile(fixture.configPath, 'utf8'), beforeConfig)
    assert.equal(fixture.catalog.get(target.id)?.credentialRef, originalCredential)
    assert.equal(fixture.credentials.has(portCredentialRef(originalCredential)), true)
    assert.equal(fixture.credentials.has(portCredentialRef(replacementCredential)), true)
  } finally {
    await fixture.close()
  }
})

test('saved connection identity overrides stale journal data for list, select, and probe', async () => {
  const oldCredential = createCredentialRefId('credential-authority-old')
  const newCredential = createCredentialRefId('credential-authority-new')
  const base = connection('cli-bridge', 'authority-base')
  const stale = connection('tangle-inference', 'authority-target', oldCredential)
  const requests: Array<{ readonly url: string; readonly authorization: string | null }> = []
  const request: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
    })
    return new Response('{}', { status: 200 })
  }
  const fixture = await createFixture({
    records: [base, stale],
    selected: base,
    productionConnection: { fetch: request },
  })
  const saved: ConnectionRecord = {
    ...stale,
    name: 'Authoritative saved connection',
    endpoint: 'https://new-authoritative.example.test',
    credentialRef: newCredential,
    updatedAt: '2026-08-09T00:30:00.000Z',
  }
  await fixture.credentials.store({
    ref: portCredentialRef(newCredential),
    value: Buffer.from('new-authoritative-secret'),
  })
  fixture.catalog.upsert(saved)
  await saveProductionStartupSelection(fixture.configPath, startupSelection(base), {
    connections: [base, saved],
  })
  try {
    const listed = await fixture.actions.list()
    assert.equal(
      listed.connections.find((candidate) => candidate.id === saved.id)?.endpoint,
      saved.endpoint,
    )
    const selected = await fixture.actions.select({
      operationId: 'operation-select-authoritative-saved-record',
      connectionId: saved.id,
    })
    assert.equal(selected.connection.endpoint, saved.endpoint)
    await fixture.actions.test({
      operationId: 'operation-test-authoritative-saved-record',
      connectionId: saved.id,
    })
    assert.ok(requests.length >= 1)
    assert.equal(
      requests.every(
        ({ url, authorization }) =>
          url.startsWith(saved.endpoint ?? 'missing') &&
          authorization === 'Bearer new-authoritative-secret',
      ),
      true,
    )
  } finally {
    await fixture.close()
  }
})

test('retrying the same create operation is idempotent across config, catalog, credential, and events', async () => {
  const base = connection('cli-bridge', 'retry-base')
  let actionNow: IsoDateTime = at
  const fixture = await createFixture({
    records: [base],
    selected: base,
    now: () => actionNow,
  })
  const originalCredential = 'retry-original-secret'
  const input = {
    operationId: 'operation-production-create-retry',
    draft: {
      kind: 'tangle-sandbox' as const,
      name: 'Retry Tangle Sandbox',
      endpoint: 'https://sandbox.retry.example.test',
    },
    credential: Buffer.from(originalCredential),
    expectedRevision: fixture.app.state().revision,
  }
  try {
    const first = await fixture.actions.create(input)
    const eventsAfterFirst = fixture.app.events().length
    const configAfterFirst = await readFile(fixture.configPath, 'utf8')
    const catalogAfterFirst = fixture.catalog.list()
    actionNow = '2026-08-09T01:00:00.000Z'
    const second = await fixture.actions.create({
      ...input,
      credential: Buffer.from('retry-must-not-replace-secret'),
    })
    assert.equal(second.replayed, true)
    assert.equal(second.connection.id, first.connection.id)
    assert.equal(fixture.app.events().length, eventsAfterFirst)
    assert.equal(await readFile(fixture.configPath, 'utf8'), configAfterFirst)
    assert.deepEqual(fixture.catalog.list(), catalogAfterFirst)
    const created = fixture.app
      .state()
      .connections.find((record) => record.id === first.connection.id)
    assert.ok(created?.credentialRef)
    if (created?.credentialRef === undefined) throw new Error('retry record has no credential ref')
    const stored = await fixture.credentials.resolve(portCredentialRef(created.credentialRef))
    try {
      assert.equal(new TextDecoder().decode(stored.read()), originalCredential)
    } finally {
      stored.dispose()
    }
  } finally {
    await fixture.close()
  }
})

test('the same create operation in two workspaces gets isolated credential references', async () => {
  const sharedCredentials = new MemoryCredentialStore()
  const firstBase = connection('cli-bridge', 'workspace-first-base')
  const secondBase = connection('cli-bridge', 'workspace-second-base')
  const first = await createFixture({
    records: [firstBase],
    selected: firstBase,
    credentials: sharedCredentials,
  })
  const second = await createFixture({
    records: [secondBase],
    selected: secondBase,
    credentials: sharedCredentials,
  })
  const operationId = 'operation-shared-id-across-workspaces'
  try {
    const firstCreated = await first.actions.create({
      operationId,
      draft: {
        kind: 'tangle-inference',
        name: 'First workspace inference',
        endpoint: 'https://first-workspace.example.test',
      },
      credential: Buffer.from('first-workspace-secret'),
    })
    const secondCreated = await second.actions.create({
      operationId,
      draft: {
        kind: 'tangle-inference',
        name: 'Second workspace inference',
        endpoint: 'https://second-workspace.example.test',
      },
      credential: Buffer.from('second-workspace-secret'),
    })
    const firstRef = first.catalog.get(firstCreated.connection.id)?.credentialRef
    const secondRef = second.catalog.get(secondCreated.connection.id)?.credentialRef
    assert.ok(firstRef)
    assert.ok(secondRef)
    assert.notEqual(firstRef, secondRef)
    if (firstRef === undefined || secondRef === undefined) throw new Error('credential ref missing')
    const firstHandle = await sharedCredentials.resolve(portCredentialRef(firstRef))
    const secondHandle = await sharedCredentials.resolve(portCredentialRef(secondRef))
    try {
      assert.equal(new TextDecoder().decode(firstHandle.read()), 'first-workspace-secret')
      assert.equal(new TextDecoder().decode(secondHandle.read()), 'second-workspace-secret')
    } finally {
      firstHandle.dispose()
      secondHandle.dispose()
    }
  } finally {
    await first.close()
    await second.close()
  }
})

test('replaying an older selection never rewinds config or the live runtime selection', async () => {
  const base = connection('cli-bridge', 'select-replay-base')
  const alternate = connection('cli-bridge', 'select-replay-alternate')
  const fixture = await createFixture({
    records: [base, alternate],
    selected: base,
    durable: true,
  })
  try {
    const expectedRevision = fixture.app.state().revision
    await fixture.actions.select({
      operationId: 'operation-select-replay-old',
      connectionId: alternate.id,
      expectedRevision,
    })
    await fixture.actions.select({
      operationId: 'operation-select-replay-new',
      connectionId: base.id,
    })
    const replayed = await fixture.actions.select({
      operationId: 'operation-select-replay-old',
      connectionId: alternate.id,
      expectedRevision,
    })
    assert.equal(replayed.replayed, true)
    assert.equal(fixture.app.runtimeSelection.connectionId(), base.id)
    assert.equal((await readStartupDocument(fixture.configPath)).connectionId, base.id)
  } finally {
    await fixture.close()
  }
})

test('replaying a create after later removal does not restore metadata or credentials', async () => {
  const base = connection('cli-bridge', 'create-remove-replay-base')
  const fixture = await createFixture({ records: [base], selected: base })
  const createInput = {
    operationId: 'operation-create-then-remove',
    draft: {
      kind: 'tangle-inference' as const,
      name: 'Create then remove',
      endpoint: 'https://router.create-remove.example.test',
    },
    credential: Buffer.from('create-remove-secret'),
  }
  try {
    const created = await fixture.actions.create(createInput)
    const createdRecord = fixture.catalog.get(created.connection.id)
    assert.ok(createdRecord?.credentialRef)
    await fixture.actions.remove({
      operationId: 'operation-remove-after-create',
      connectionId: created.connection.id,
    })
    const eventCount = fixture.app.events().length
    const replayed = await fixture.actions.create({
      ...createInput,
      credential: Buffer.from('must-not-be-restored'),
    })
    assert.equal(replayed.replayed, true)
    assert.equal(fixture.catalog.get(created.connection.id), undefined)
    assert.equal(
      (await readStartupDocument(fixture.configPath)).connections?.some(
        (record) => record.id === created.connection.id,
      ),
      false,
    )
    assert.equal(fixture.app.events().length, eventCount)
    if (createdRecord?.credentialRef !== undefined) {
      assert.equal(fixture.credentials.has(portCredentialRef(createdRecord.credentialRef)), false)
    }
  } finally {
    await fixture.close()
  }
})
