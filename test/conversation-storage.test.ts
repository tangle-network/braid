import assert from 'node:assert/strict'
import { mkdtemp, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import { UnavailableExecutionPort } from '../src/adapters/runtime/unavailable-execution.js'
import { openSqliteStorage } from '../src/adapters/storage/sqlite.js'
import { BraidApplication } from '../src/app/application.js'
import {
  createBraidApplication,
  createDurableBraidApplication,
  DETERMINISTIC_PROFILE,
} from '../src/app/composition.js'
import { StorageJournal } from '../src/app/storage-journal.js'
import { assertBraidState } from '../src/domain/invariants.js'
import { SystemClock } from '../src/ports/clock.js'
import { SequenceIds } from '../src/ports/ids.js'

test('encrypted conversations survive restart and deleted content stays unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-conversation-storage-'))
  const path = join(root, 'braid.sqlite')
  const credentialStore = new MemoryCredentialStore()
  const first = await createDurableBraidApplication({
    path,
    workspaceRoot: root,
    credentialStore,
    profile: DETERMINISTIC_PROFILE,
  })
  first.app.initialize('/workspace')
  await first.app.whenDurable()
  const fallbackId = first.app.state().conversationId
  const target = await first.app.conversations.lifecycle.create({
    operationId: 'op-storage-conversation-create',
    title: 'Encrypted target',
  })
  const branch = await first.app.conversations.branches.create({
    operationId: 'op-storage-conversation-branch',
    conversationId: target.id,
    branchId: target.activeBranchId,
  })
  await first.app.conversations.lifecycle.rename({
    operationId: 'op-storage-conversation-rename',
    conversationId: target.id,
    title: 'Encrypted renamed target',
  })
  await first.app.whenDurable()
  const beforeRestart = structuredClone(first.app.state())
  await first.storage.close()

  const second = await createDurableBraidApplication({
    path,
    workspaceRoot: root,
    credentialStore,
    profile: DETERMINISTIC_PROFILE,
  })
  assert.equal(second.app.state().projectionChecksum, beforeRestart.projectionChecksum)
  assert.equal(second.app.state().conversationId, target.id)
  assert.equal(second.app.state().branchId, branch.id)
  assert.equal(
    second.app.state().conversations.find((conversation) => conversation.id === target.id)?.title,
    'Encrypted renamed target',
  )

  await second.app.conversations.lifecycle.delete({
    operationId: 'op-storage-conversation-delete',
    conversationId: target.id,
  })
  await second.app.whenDurable()
  const deletedRows = await second.storage.events({ conversationId: target.id })
  assert.equal(deletedRows.length > 0, true)
  assert.equal(
    deletedRows.every(
      (row) => row.payloadState === 'deleted' || row.payloadState === 'content-key-unavailable',
    ),
    true,
  )
  assert.equal(second.app.state().conversationId, fallbackId)
  await second.storage.close()

  const third = await createDurableBraidApplication({
    path,
    workspaceRoot: root,
    credentialStore,
    profile: DETERMINISTIC_PROFILE,
  })
  const finalState = third.app.state()
  assert.equal(finalState.conversationId, fallbackId)
  assert.equal(
    finalState.conversations.find((conversation) => conversation.id === target.id)?.deletedAt !==
      undefined,
    true,
  )
  assert.equal(
    finalState.branches.some((candidate) => candidate.conversationId === target.id),
    false,
  )
  assert.equal(JSON.stringify(finalState).includes('Encrypted renamed target'), false)
  assertBraidState(finalState)
  await third.storage.close()
})

test('branch drafts survive an encrypted restart independently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-draft-storage-'))
  const path = join(root, 'braid.sqlite')
  const credentialStore = new MemoryCredentialStore()
  const first = await createDurableBraidApplication({
    path,
    workspaceRoot: root,
    credentialStore,
    profile: DETERMINISTIC_PROFILE,
  })
  first.app.initialize('/workspace')
  await first.app.whenDurable()
  const conversationId = first.app.state().conversationId
  const firstBranchId = first.app.state().branchId
  await first.app.conversations.drafts.set({
    operationId: 'op-storage-draft-first',
    text: 'first branch draft',
  })
  const secondBranch = await first.app.conversations.branches.create({
    operationId: 'op-storage-draft-branch',
    conversationId,
    branchId: firstBranchId,
  })
  await first.app.conversations.drafts.set({
    operationId: 'op-storage-draft-second',
    text: 'second branch draft',
  })
  await first.app.conversations.lifecycle.open({
    operationId: 'op-storage-draft-open-first',
    conversationId,
    branchId: firstBranchId,
  })
  await first.app.whenDurable()
  await first.storage.close()

  const second = await createDurableBraidApplication({
    path,
    workspaceRoot: root,
    credentialStore,
    profile: DETERMINISTIC_PROFILE,
  })
  assert.equal(second.app.state().conversationId, conversationId)
  assert.equal(second.app.state().branchId, firstBranchId)
  assert.equal(second.app.state().draft, 'first branch draft')
  assert.equal(
    second.app.state().drafts.find((draft) => draft.branchId === firstBranchId)?.text,
    'first branch draft',
  )
  assert.equal(
    second.app.state().drafts.find((draft) => draft.branchId === secondBranch.id)?.text,
    'second branch draft',
  )
  assertBraidState(second.app.state())
  await second.storage.close()
})

test('an imported conversation survives an encrypted restart with controls disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-import-storage-'))
  const path = join(root, 'braid.sqlite')
  const credentialStore = new MemoryCredentialStore()
  const sourceApp = createBraidApplication({ fixture: 'deterministic' })
  sourceApp.initialize('/source-workspace')
  await sourceApp.whenDurable()
  const source = await sourceApp.conversations.lifecycle.create({
    operationId: 'op-storage-import-source',
    title: 'Portable encrypted conversation',
  })
  await sourceApp.send({ operationId: 'op-storage-import-source-turn', text: 'encrypted history' })
    .completion
  await sourceApp.conversations.branches.create({
    operationId: 'op-storage-import-source-branch',
    conversationId: source.id,
    branchId: source.activeBranchId,
  })
  const exported = await sourceApp.conversations.exports.export({
    operationId: 'op-storage-import-export',
    conversationId: source.id,
    format: 'json',
  })
  assert(exported.content)
  const importSource = join(root, 'portable-conversation.json')
  await writeFile(importSource, exported.content, { mode: 0o600 })

  const first = await createDurableBraidApplication({
    path,
    workspaceRoot: root,
    credentialStore,
    profile: DETERMINISTIC_PROFILE,
  })
  first.app.initialize('/workspace')
  await first.app.whenDurable()
  const imported = await first.app.conversations.imports.import({
    operationId: 'op-storage-import',
    source: importSource,
  })
  await first.app.whenDurable()
  await first.storage.close()
  await unlink(importSource)

  const second = await createDurableBraidApplication({
    path,
    workspaceRoot: root,
    credentialStore,
    profile: DETERMINISTIC_PROFILE,
  })
  const state = second.app.state()
  const replay = await second.app.conversations.imports.import({
    operationId: 'op-storage-import',
    source: importSource,
  })
  assert.deepEqual(replay, { ...imported, replayed: true })
  const branches = state.branches.filter(
    (branch) => branch.conversationId === imported.conversationId,
  )
  assert.equal(state.conversationId, imported.conversationId)
  assert.equal(branches.length, 2)
  const turns = state.turns.filter((turn) => turn.conversationId === imported.conversationId)
  const runIds = new Set(turns.flatMap((turn) => turn.runIds))
  const runs = state.runs.filter((run) => runIds.has(run.id))
  assert.equal(runs.length, 1)
  assert.equal(runs[0]?.inputTokens, 0)
  assert.equal(runs[0]?.outputTokens, 0)
  assert.equal(runs[0]?.capabilities.controls.cancel, false)
  assert.equal(runs[0]?.receipt.admissionStatus, 'unavailable')
  assert.equal(
    branches.every(
      (branch) =>
        branch.connectionId === undefined &&
        branch.bindingId === undefined &&
        branch.environmentId === undefined &&
        state.drafts.find((draft) => draft.id === branch.draftId)?.text === '' &&
        state.queues.find((queue) => queue.id === branch.queueId)?.entryIds.length === 0,
    ),
    true,
  )
  assert.equal(
    second.app
      .events()
      .filter(
        (event) =>
          event.event.kind === 'conversation.imported' &&
          event.event.operation.id === 'op-storage-import',
      ).length,
    1,
  )
  assertBraidState(state)
  await second.storage.close()
})

test('restart completes deletion when key destruction won but acknowledgement was lost', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-conversation-delete-recovery-'))
  const path = join(root, 'braid.sqlite')
  const credentialStore = new MemoryCredentialStore()
  const clock = new SystemClock()
  const storage = await openSqliteStorage({
    path,
    workspaceRoot: root,
    credentialStore,
  })
  const journal = await StorageJournal.fromStorage(storage, clock)
  let interrupted = false
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution: new UnavailableExecutionPort(),
    clock,
    ids: new SequenceIds(),
    journal,
    effectStorage: storage,
    conversationStorage: {
      destroyConversation: async (input) => {
        const result = await storage.destroyConversation(input)
        if (!interrupted) {
          interrupted = true
          throw new Error('simulated process loss after content-key destruction')
        }
        return result
      },
    },
  })
  app.initialize('/workspace')
  await app.whenDurable()
  const target = await app.conversations.lifecycle.create({
    operationId: 'op-storage-recovery-create',
    title: 'Interrupted deletion',
  })
  await assert.rejects(
    () =>
      app.conversations.lifecycle.delete({
        operationId: 'op-storage-recovery-delete',
        conversationId: target.id,
      }),
    /simulated process loss/u,
  )
  assert.equal(
    app.state().operations.find((operation) => operation.id === 'op-storage-recovery-delete')
      ?.status,
    'pending',
  )
  await storage.close()

  const restarted = await createDurableBraidApplication({
    path,
    workspaceRoot: root,
    credentialStore,
    profile: DETERMINISTIC_PROFILE,
  })
  await restarted.app.whenDurable()
  const recovered = restarted.app
    .state()
    .operations.find((operation) => operation.id === 'op-storage-recovery-delete')
  assert.equal(recovered?.status, 'acknowledged')
  assert.equal(restarted.app.state().conversationId === target.id, false)
  assert.equal(
    restarted.app.state().conversations.find((conversation) => conversation.id === target.id)
      ?.deletedAt !== undefined,
    true,
  )
  await restarted.storage.close()
})

test('concurrent replay of one export operation performs one durable mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-conversation-export-race-'))
  const path = join(root, 'braid.sqlite')
  const destination = join(root, 'conversation.json')
  const credentialStore = new MemoryCredentialStore()
  const durable = await createDurableBraidApplication({
    path,
    workspaceRoot: root,
    credentialStore,
    profile: DETERMINISTIC_PROFILE,
  })
  durable.app.initialize('/workspace')
  await durable.app.whenDurable()
  const conversations = await Promise.all(
    Array.from({ length: 20 }, () =>
      durable.app.conversations.lifecycle.create({
        operationId: 'op-storage-concurrent-create',
        title: 'Concurrent conversation',
      }),
    ),
  )
  assert.equal(new Set(conversations.map((conversation) => conversation.id)).size, 1)
  assert.equal(
    durable.app
      .events()
      .filter(
        (event) =>
          event.event.kind === 'conversation.created' &&
          event.event.operation?.id === 'op-storage-concurrent-create',
      ).length,
    1,
  )
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, () =>
      durable.app.conversations.exports.export({
        operationId: 'op-storage-concurrent-export',
        format: 'json',
        destination,
      }),
    ),
  )
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 20)
  assert.equal(
    durable.app
      .events()
      .filter(
        (event) =>
          event.event.kind === 'operation.updated' &&
          event.event.operation.id === 'op-storage-concurrent-export',
      ).length,
    1,
  )
  const first = durable.app.conversations.exports.export({
    operationId: 'op-storage-concurrent-conflict',
    format: 'json',
  })
  await assert.rejects(
    () =>
      durable.app.conversations.exports.export({
        operationId: 'op-storage-concurrent-conflict',
        format: 'markdown',
      }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'OPERATION_ID_CONFLICT',
  )
  await first
  await durable.storage.close()
})
