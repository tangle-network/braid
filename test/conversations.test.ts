import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { AppError } from '../src/app/application.js'
import { createBraidApplication } from '../src/app/composition.js'
import { messagesVisibleOnBranch } from '../src/app/conversation-context.js'
import { createInteractionRequest } from '../src/app/interaction-request.js'
import { MemoryJournal } from '../src/app/journal.js'
import { canonicalDigest } from '../src/domain/canonical.js'
import { localInteractionId } from '../src/domain/interaction-identity.js'
import { assertBraidState } from '../src/domain/invariants.js'
import { FixedClock } from '../src/ports/clock.js'
import { DEFAULT_RUN_CAPABILITIES, type ExecutionPort } from '../src/ports/execution.js'

async function initializedApp() {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  await app.whenDurable()
  return app
}

interface MutableConversationExport {
  exportedAt: string
  contentDigest: string
  content: {
    conversation: Record<string, unknown>
    graphNodes: Array<{
      id: string
      reference: { kind: string; id: string }
      [key: string]: unknown
    }>
    graphEdges: Array<{
      id: string
      kind: string
      source: string
      destination: string
      provenance: Record<string, unknown>
      createdAt: string
    }>
    [key: string]: unknown
  }
  [key: string]: unknown
}

function parseExport(value: string): MutableConversationExport {
  return JSON.parse(value) as MutableConversationExport
}

function refreshDigest(document: MutableConversationExport): void {
  document.contentDigest = canonicalDigest(document.content)
}

async function rejectsImport(
  app: Awaited<ReturnType<typeof initializedApp>>,
  operationId: string,
  document: MutableConversationExport,
  code: string,
): Promise<void> {
  const before = app.state()
  const eventCount = app.events().length
  await assert.rejects(
    () =>
      app.conversations.imports.import({
        operationId,
        content: JSON.stringify(document),
      }),
    (error: unknown) => error instanceof AppError && error.code === code,
  )
  assert.deepEqual(app.state(), before)
  assert.equal(app.events().length, eventCount)
  assert.equal(app.storageFailure(), undefined)
}

test('conversation lifecycle is durable, searchable, and retry safe', async () => {
  const app = await initializedApp()
  const initialConversationId = app.state().conversationId

  const created = await app.conversations.lifecycle.create({
    operationId: 'op-conversation-create',
    title: 'Investigate queue behavior',
  })
  const replay = await app.conversations.lifecycle.create({
    operationId: 'op-conversation-create',
    title: 'Investigate queue behavior',
  })

  assert.equal(replay.id, created.id)
  assert.equal(app.state().conversationId, created.id)
  assert.deepEqual(
    app.conversations.lifecycle.list({ query: 'queue', status: 'all' }).map((item) => item.id),
    [created.id],
  )
  await assert.rejects(
    () =>
      app.conversations.lifecycle.create({
        operationId: 'op-conversation-create',
        title: 'Changed request',
      }),
    (error: unknown) => error instanceof AppError && error.code === 'OPERATION_ID_CONFLICT',
  )

  const renamed = await app.conversations.lifecycle.rename({
    operationId: 'op-conversation-rename',
    conversationId: created.id,
    title: 'Queue reliability',
  })
  assert.equal(renamed.title, 'Queue reliability')
  const archived = await app.conversations.lifecycle.archive({
    operationId: 'op-conversation-archive',
    conversationId: created.id,
    archived: true,
  })
  assert.equal(archived.archived, true)
  assert.equal(app.conversations.lifecycle.list({ status: 'archived' }).length, 1)

  const opened = await app.conversations.lifecycle.open({
    operationId: 'op-conversation-open',
    conversationId: initialConversationId,
  })
  assert.equal(app.state().conversationId, initialConversationId)
  assert.equal(app.state().branchId, opened.activeBranchId)
  assertBraidState(app.state())
})

test('drafts are branch scoped, redacted, bounded, and retry safe', async () => {
  const app = await initializedApp()
  const conversationId = app.state().conversationId
  const firstBranchId = app.state().branchId
  const credential = 'sk-proj-draftcanary0123456789abcdefghijklmnopqrstuvwxyz' // sample credential
  const first = await app.conversations.drafts.set({
    operationId: 'op-draft-first',
    conversationId,
    branchId: firstBranchId,
    text: `inspect ${credential}`,
  })
  const replay = await app.conversations.drafts.set({
    operationId: 'op-draft-first',
    conversationId,
    branchId: firstBranchId,
    text: `inspect ${credential}`,
  })

  assert.equal(first.replayed, false)
  assert.equal(replay.replayed, true)
  assert.equal(first.draft.text.includes(credential), false)
  assert.match(first.draft.text, /redacted/iu)
  assert.equal(app.state().draft, first.draft.text)
  assert.equal(
    app
      .events()
      .filter(
        (event) =>
          event.event.kind === 'draft.recorded' && event.event.operation?.id === 'op-draft-first',
      ).length,
    1,
  )
  await assert.rejects(
    () =>
      app.conversations.drafts.set({
        operationId: 'op-draft-first',
        conversationId,
        branchId: firstBranchId,
        text: 'different input',
      }),
    (error: unknown) => error instanceof AppError && error.code === 'OPERATION_ID_CONFLICT',
  )

  const secondBranch = await app.conversations.branches.create({
    operationId: 'op-draft-branch',
    conversationId,
    branchId: firstBranchId,
  })
  await app.conversations.drafts.set({
    operationId: 'op-draft-second',
    conversationId,
    branchId: secondBranch.id,
    text: 'second branch draft',
  })
  await app.conversations.lifecycle.open({
    operationId: 'op-draft-return',
    conversationId,
    branchId: firstBranchId,
  })
  assert.equal(app.state().draft, first.draft.text)

  await app.conversations.drafts.set({
    operationId: 'op-draft-send',
    conversationId,
    branchId: firstBranchId,
    text: 'send this draft',
  })
  await app.send({ operationId: 'op-draft-send-turn', text: 'send this draft' }).completion
  assert.equal(app.state().drafts.find((draft) => draft.branchId === firstBranchId)?.text, '')
  assert.equal(
    app.state().drafts.find((draft) => draft.branchId === secondBranch.id)?.text,
    'second branch draft',
  )
  await assert.rejects(
    () =>
      app.conversations.drafts.set({
        operationId: 'op-draft-too-large',
        text: 'x'.repeat(1024 * 1024 + 1),
      }),
    (error: unknown) => error instanceof AppError && error.code === 'DRAFT_TOO_LARGE',
  )
  assertBraidState(app.state())
})

test('branch, clone, context, and fork use one canonical conversation graph', async () => {
  const app = await initializedApp()
  const sourceConversationId = app.state().conversationId
  const sourceBranchId = app.state().branchId
  await app.send({ operationId: 'op-source-turn', text: 'source message' }).completion
  const sourceMessages = messagesVisibleOnBranch(app.state(), sourceBranchId)
  const boundary = sourceMessages[0]
  assert(boundary)

  const branch = await app.conversations.branches.create({
    operationId: 'op-create-branch',
    throughMessageId: boundary.id,
  })
  assert.equal(branch.conversationId, sourceConversationId)
  assert.deepEqual(
    messagesVisibleOnBranch(app.state(), branch.id).map((message) => message.id),
    [boundary.id],
  )
  await app.send({ operationId: 'op-branch-turn', text: 'branch-only message' }).completion
  assert.equal(messagesVisibleOnBranch(app.state(), sourceBranchId).length, 2)
  assert.equal(messagesVisibleOnBranch(app.state(), branch.id).length, 3)

  const clone = await app.conversations.branches.clone({
    operationId: 'op-clone-conversation',
    title: 'Independent copy',
  })
  assert.notEqual(clone.id, sourceConversationId)
  assert.equal(app.state().conversationId, clone.id)
  assert.equal(app.state().queuedInputs.length, 0)
  const context = app.conversations.context.plan({ branchId: clone.activeBranchId })
  assert.equal(context.messages.length, 3)
  assert.equal(context.complete, true)

  await app.conversations.lifecycle.open({
    operationId: 'op-return-source',
    conversationId: sourceConversationId,
    branchId: sourceBranchId,
  })
  const plan = app.conversations.branches.plan({
    operationId: 'op-fork-conversation',
    kind: 'conversation',
    throughMessageId: boundary.id,
  })
  const repeatedPlan = app.conversations.branches.plan({
    operationId: 'op-fork-conversation',
    kind: 'conversation',
    throughMessageId: boundary.id,
  })
  assert.deepEqual(repeatedPlan, plan)
  assert.equal(plan.allowed, true)
  const fork = await app.conversations.branches.execute({
    operationId: 'op-fork-conversation',
    kind: 'conversation',
    throughMessageId: boundary.id,
    planDigest: plan.digest,
  })
  assert.equal(fork.id, plan.destinationBranchId)
  await assert.rejects(
    () =>
      app.conversations.branches.execute({
        operationId: 'op-fork-conflict',
        kind: 'conversation',
        throughMessageId: boundary.id,
        planDigest: plan.digest,
      }),
    (error: unknown) => error instanceof AppError && error.code === 'FORK_PLAN_CONFLICT',
  )
  const workspacePlan = app.conversations.branches.plan({
    operationId: 'op-workspace-fork',
    kind: 'workspace',
  })
  assert.equal(workspacePlan.allowed, false)
  assert.equal(workspacePlan.environment, 'unavailable')
  assertBraidState(app.state())
})

test('branch run configuration merges, replays, rejects conflicts, and clears atomically', async () => {
  const app = await initializedApp()
  const conversationId = app.state().conversationId
  const branchId = app.state().branchId
  const first = await app.conversations.branches.setRunOverrides({
    operationId: 'op-run-override-first',
    runner: 'codex',
    model: 'openai/gpt-5.6',
    effort: 'high',
    mode: 'interactive',
  })
  const replay = await app.conversations.branches.setRunOverrides({
    operationId: 'op-run-override-first',
    runner: 'codex',
    model: 'openai/gpt-5.6',
    effort: 'high',
    mode: 'interactive',
  })

  assert.deepEqual(replay, first)
  assert.deepEqual(first.overrides, {
    runner: 'codex',
    model: 'openai/gpt-5.6',
    effort: 'high',
    mode: 'interactive',
  })
  assert.equal(
    app
      .events()
      .filter(
        (entry) =>
          entry.event.kind === 'branch.updated' &&
          entry.event.operation.id === 'op-run-override-first',
      ).length,
    1,
  )

  const merged = await app.conversations.branches.setRunOverrides({
    operationId: 'op-run-override-merge',
    model: 'anthropic/claude-opus-5',
  })
  assert.deepEqual(merged.overrides, {
    runner: 'codex',
    model: 'anthropic/claude-opus-5',
    effort: 'high',
    mode: 'interactive',
  })

  const beforeFailures = app.state()
  const eventCount = app.events().length
  await assert.rejects(
    () =>
      app.conversations.branches.setRunOverrides({
        operationId: 'op-run-override-first',
        runner: 'pi',
        model: 'openai/gpt-5.6',
        effort: 'high',
        mode: 'interactive',
      }),
    (error: unknown) => error instanceof AppError && error.code === 'OPERATION_ID_CONFLICT',
  )
  await assert.rejects(
    () =>
      app.conversations.branches.setRunOverrides({
        operationId: 'op-run-override-invalid-runner',
        runner: 'not-a-runner',
      }),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_RUNNER',
  )
  await assert.rejects(
    () =>
      app.conversations.branches.setRunOverrides({
        operationId: 'op-run-override-invalid-effort',
        effort: 'maximum-ish',
      }),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_EFFORT',
  )
  await assert.rejects(
    () =>
      app.conversations.branches.setRunOverrides({
        operationId: 'op-run-override-invalid-clear',
        clear: true,
        runner: 'pi',
      }),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_RUN_OVERRIDE',
  )
  assert.deepEqual(app.state(), beforeFailures)
  assert.equal(app.events().length, eventCount)

  const child = await app.conversations.branches.create({
    operationId: 'op-run-override-child',
    conversationId,
    branchId,
  })
  assert.deepEqual(child.overrides, merged.overrides)
  const changedChild = await app.conversations.branches.setRunOverrides({
    operationId: 'op-run-override-child-change',
    conversationId,
    branchId: child.id,
    runner: 'pi',
  })
  assert.equal(changedChild.overrides.runner, 'pi')
  assert.equal(
    app.state().branches.find((branch) => branch.id === branchId)?.overrides.runner,
    'codex',
  )

  const cleared = await app.conversations.branches.setRunOverrides({
    operationId: 'op-run-override-clear',
    conversationId,
    branchId: child.id,
    clear: true,
  })
  assert.deepEqual(cleared.overrides, {})
  assertBraidState(app.state())
})

test('branch run configuration survives journal replay and can change future runs during a run', async () => {
  const journal = new MemoryJournal(new FixedClock())
  const first = createBraidApplication({ fixture: 'deterministic', journal, chunkDelayMs: 100 })
  first.initialize('/workspace')
  await first.conversations.branches.setRunOverrides({
    operationId: 'op-run-override-durable',
    runner: 'codex',
    model: 'openai/gpt-5.6',
    effort: 'xhigh',
  })
  await first.whenDurable()

  const restarted = createBraidApplication({ fixture: 'deterministic', journal, chunkDelayMs: 100 })
  await restarted.whenDurable()
  assert.deepEqual(
    restarted.state().branches.find((branch) => branch.id === restarted.state().branchId)
      ?.overrides,
    { runner: 'codex', model: 'openai/gpt-5.6', effort: 'xhigh' },
  )

  const active = restarted.send({
    operationId: 'op-run-override-active-send',
    text: 'keep configuration stable while this runs',
  })
  await active.admissionReady
  const changed = await restarted.conversations.branches.setRunOverrides({
    operationId: 'op-run-override-active-change',
    runner: 'pi',
  })
  assert.equal(changed.overrides.runner, 'pi')
  await active.completion
  assert.equal(
    restarted.state().branches.find((branch) => branch.id === restarted.state().branchId)?.overrides
      .runner,
    'pi',
  )
  assertBraidState(restarted.state())
})

test('conversation exports are redacted, bounded, and never overwrite a path', async () => {
  const app = await initializedApp()
  const credential = 'sk-proj-exportcanary0123456789abcdefghijklmnopqrstuvwxyz'
  await app.send({
    operationId: 'op-export-turn',
    text: `inspect ${credential}`,
  }).completion
  const controller = createApplicationUiController(app)
  const publicSurfaces = JSON.stringify({
    state: app.state(),
    events: app.events(),
    view: controller.view(),
    headless: controller.state(),
  })
  assert.equal(publicSurfaces.includes(credential), false)
  const root = await mkdtemp(join(tmpdir(), 'braid-conversation-export-'))
  await chmod(root, 0o755)
  const destination = join(root, 'conversation.json')
  const exported = await app.conversations.exports.export({
    operationId: 'op-export-json',
    format: 'json',
    destination,
  })
  assert.equal(exported.destination, destination)
  const bytes = await readFile(destination, 'utf8')
  assert.equal(bytes.includes(credential), false)
  assert.match(bytes, /redacted/iu)
  assert.equal((await stat(destination)).mode & 0o777, 0o600)
  assert.equal((await stat(root)).mode & 0o777, 0o755)
  const replay = await app.conversations.exports.export({
    operationId: 'op-export-json',
    format: 'json',
    destination,
  })
  assert.equal(replay.replayed, true)

  await assert.rejects(
    () =>
      app.conversations.exports.export({
        operationId: 'op-export-other',
        format: 'json',
        destination,
      }),
    (error: unknown) => error instanceof Error,
  )
  const symlinkPath = join(root, 'symlink.json')
  await symlink(destination, symlinkPath)
  await assert.rejects(
    () =>
      app.conversations.exports.export({
        operationId: 'op-export-symlink',
        format: 'json',
        destination: symlinkPath,
      }),
    (error: unknown) => error instanceof Error,
  )
})

test('conversation import round-trips history offline and retries exactly once', async () => {
  const app = await initializedApp()
  const sourceConversationId = app.state().conversationId
  await app.send({ operationId: 'op-import-source-turn', text: 'portable history' }).completion
  const exported = await app.conversations.exports.export({
    operationId: 'op-import-source-export',
    format: 'json',
  })
  assert(exported.content)
  const sourceState = app.state()
  const sourceMessages = sourceState.messages.filter(
    (message) => message.conversationId === sourceConversationId,
  )
  const imported = await app.conversations.imports.import({
    operationId: 'op-import-round-trip',
    content: exported.content,
  })
  const replay = await app.conversations.imports.import({
    operationId: 'op-import-round-trip',
    content: exported.content,
  })
  const state = app.state()
  const importedConversation = state.conversations.find(
    (conversation) => conversation.id === imported.conversationId,
  )
  const importedBranches = state.branches.filter(
    (branch) => branch.conversationId === imported.conversationId,
  )
  const importedMessages = state.messages.filter(
    (message) => message.conversationId === imported.conversationId,
  )
  const importedTurns = state.turns.filter(
    (turn) => turn.conversationId === imported.conversationId,
  )
  const importedRunIds = new Set(importedTurns.flatMap((turn) => turn.runIds))
  const importedRuns = state.runs.filter((run) => importedRunIds.has(run.id))
  const sourceMessageIds = new Set(sourceMessages.map((message) => message.id))
  const sourceDigestEdges = state.graphEdges.filter(
    (edge) => edge.provenance.sourceDigest === exported.contentDigest,
  )

  assert.notEqual(imported.conversationId, sourceConversationId)
  assert.equal(imported.contentDigest, exported.contentDigest)
  assert.equal(replay.replayed, true)
  assert.deepEqual(replay, { ...imported, replayed: true })
  assert.equal(importedConversation?.title, 'New conversation')
  assert.deepEqual(
    importedMessages.map((message) => message.text),
    sourceMessages.map((message) => message.text),
  )
  assert.deepEqual(
    importedMessages.map((message) => message.parts.map((part) => [part.kind, part.text])),
    sourceMessages.map((message) => message.parts.map((part) => [part.kind, part.text])),
  )
  assert.equal(
    importedMessages.some((message) => sourceMessageIds.has(message.id)),
    false,
  )
  assert.equal(
    importedBranches.every(
      (branch) =>
        branch.connectionId === undefined &&
        branch.bindingId === undefined &&
        branch.environmentId === undefined &&
        branch.profileId === undefined &&
        branch.profileSnapshotId === undefined &&
        Object.keys(branch.overrides).length === 0,
    ),
    true,
  )
  assert.equal(
    importedBranches.every(
      (branch) =>
        state.drafts.find((draft) => draft.id === branch.draftId)?.text === '' &&
        state.queues.find((queue) => queue.id === branch.queueId)?.entryIds.length === 0,
    ),
    true,
  )
  assert.equal(
    importedRuns.every(
      (run) =>
        run.providerSessionId === undefined &&
        run.environmentId === undefined &&
        run.bindingId === undefined &&
        run.connectionId === undefined &&
        run.replayCursor === undefined &&
        run.interactions.length === 0 &&
        run.capabilities.controls.cancel === false &&
        run.capabilities.controls.steer === false &&
        run.receipt.admissionStatus === 'unavailable',
    ),
    true,
  )
  assert.equal(state.activeRunId, null)
  assert.equal(
    app
      .events()
      .filter(
        (event) =>
          event.event.kind === 'conversation.imported' &&
          event.event.operation.id === 'op-import-round-trip',
      ).length,
    1,
  )
  assert.equal(sourceDigestEdges.length > 0, true)
  assert.equal(
    sourceDigestEdges.every(
      (edge) =>
        edge.provenance.operationId === undefined && edge.provenance.receiptId === undefined,
    ),
    true,
  )
  assertBraidState(state)
})

test('conversation import preserves histories larger than the default structured array limit', async () => {
  const app = await initializedApp()
  const sourceConversationId = app.state().conversationId
  for (let index = 0; index < 129; index += 1) {
    await app.send({ operationId: `op-import-scale-send-${index}`, text: `turn ${index}` })
      .completion
  }
  const sourceMessages = app
    .state()
    .messages.filter((message) => message.conversationId === sourceConversationId)
  assert.equal(sourceMessages.length, 258)

  const exported = await app.conversations.exports.export({
    operationId: 'op-import-scale-export',
    format: 'json',
  })
  assert(exported.content)
  const imported = await app.conversations.imports.import({
    operationId: 'op-import-scale-import',
    content: exported.content,
  })
  const importedMessages = app
    .state()
    .messages.filter((message) => message.conversationId === imported.conversationId)

  assert.equal(imported.messages, 258)
  assert.deepEqual(
    importedMessages.map((message) => message.text),
    sourceMessages.map((message) => message.text),
  )
  assertBraidState(app.state())
})

test('conversation import rejects tampering, unsafe data, hostile graphs, and operation conflicts', async () => {
  const app = await initializedApp()
  await app.send({ operationId: 'op-import-attack-source', text: 'safe source' }).completion
  const exported = await app.conversations.exports.export({
    operationId: 'op-import-attack-export',
    format: 'json',
  })
  assert(exported.content)
  const baseline = app.state()

  const tampered = parseExport(exported.content)
  tampered.contentDigest = '0'.repeat(64)
  await rejectsImport(app, 'op-import-tampered', tampered, 'IMPORT_DIGEST_MISMATCH')

  const secret = parseExport(exported.content)
  secret.content.conversation.title =
    'api_key=sk-proj-importcanary0123456789abcdefghijklmnopqrstuvwxyz'
  refreshDigest(secret)
  await rejectsImport(app, 'op-import-secret', secret, 'IMPORT_REDACTION_REQUIRED')

  const dangling = parseExport(exported.content)
  const danglingEdge = dangling.content.graphEdges[0]
  assert(danglingEdge)
  danglingEdge.destination = 'node-missing'
  refreshDigest(dangling)
  await rejectsImport(app, 'op-import-dangling', dangling, 'IMPORT_INVALID')

  const cyclic = parseExport(exported.content)
  const conversationNode = cyclic.content.graphNodes.find(
    (node) => node.reference.kind === 'conversation',
  )
  const branchNode = cyclic.content.graphNodes.find((node) => node.reference.kind === 'branch')
  assert(conversationNode && branchNode)
  cyclic.content.graphEdges.push({
    id: 'edge-import-cycle',
    kind: 'attached',
    source: branchNode.id,
    destination: conversationNode.id,
    provenance: {},
    createdAt: cyclic.exportedAt,
  })
  refreshDigest(cyclic)
  await rejectsImport(app, 'op-import-cycle', cyclic, 'IMPORT_INVALID')

  const deep = parseExport(exported.content)
  let nested: Record<string, unknown> = {}
  for (let index = 0; index < 30; index += 1) nested = { child: nested }
  deep.content.conversation.retention = nested
  refreshDigest(deep)
  await rejectsImport(app, 'op-import-deep', deep, 'IMPORT_TOO_COMPLEX')

  const invalidReceiptDate = parseExport(exported.content)
  const importedRuns = invalidReceiptDate.content.runs as Array<{
    receipt?: { admittedAt?: unknown }
  }>
  assert(importedRuns[0]?.receipt)
  importedRuns[0].receipt.admittedAt = 'not-a-date'
  refreshDigest(invalidReceiptDate)
  await rejectsImport(app, 'op-import-invalid-receipt-date', invalidReceiptDate, 'IMPORT_INVALID')

  await assert.rejects(
    () =>
      app.conversations.imports.import({
        operationId: 'op-import-oversize',
        content: 'x'.repeat(2 * 1024 * 1024 + 1),
      }),
    (error: unknown) => error instanceof AppError && error.code === 'IMPORT_TOO_LARGE',
  )

  const accepted = await app.conversations.imports.import({
    operationId: 'op-import-conflict',
    content: exported.content,
  })
  const changed = parseExport(exported.content)
  changed.content.conversation.title = 'Different valid import'
  refreshDigest(changed)
  await assert.rejects(
    () =>
      app.conversations.imports.import({
        operationId: 'op-import-conflict',
        content: JSON.stringify(changed),
      }),
    (error: unknown) => error instanceof AppError && error.code === 'OPERATION_ID_CONFLICT',
  )
  assert.notEqual(accepted.conversationId, baseline.conversationId)
  assert.equal(app.storageFailure(), undefined)
  assertBraidState(app.state())
})

test('conversation import reads only regular no-follow files', async () => {
  const app = await initializedApp()
  const exported = await app.conversations.exports.export({
    operationId: 'op-import-file-export',
    format: 'json',
  })
  assert(exported.content)
  const root = await mkdtemp(join(tmpdir(), 'braid-conversation-import-'))
  const source = join(root, 'conversation.json')
  const link = join(root, 'conversation-link.json')
  await writeFile(source, exported.content, { mode: 0o600 })
  await symlink(source, link)
  const result = await app.conversations.imports.import({
    operationId: 'op-import-file',
    source,
  })
  assert.equal(result.contentDigest, exported.contentDigest)
  await assert.rejects(
    () =>
      app.conversations.imports.import({
        operationId: 'op-import-file-link',
        source: link,
      }),
    (error: unknown) => error instanceof AppError && error.code === 'IMPORT_SOURCE_UNSAFE',
  )
  await unlink(source)
  const replay = await app.conversations.imports.import({
    operationId: 'op-import-file',
    source,
  })
  assert.equal(replay.replayed, true)
  assert.deepEqual(replay, { ...result, replayed: true })
})

test('conversation import rejects cyclic, orphaned, and cross-linked records atomically', async () => {
  const app = await initializedApp()
  await app.send({ operationId: 'op-import-relations-source', text: 'linked history' }).completion
  const exported = await app.conversations.exports.export({
    operationId: 'op-import-relations-export',
    format: 'json',
  })
  assert(exported.content)

  const cyclic = parseExport(exported.content)
  const cyclicConversation = cyclic.content.conversation
  const cyclicBranches = cyclic.content.branches as Array<Record<string, unknown>>
  const firstBranch = cyclicBranches[0]
  assert(firstBranch)
  const secondBranchId = 'branch-import-cycle-second'
  const secondBranch: Record<string, unknown> = { ...firstBranch, id: secondBranchId }
  firstBranch.source = {
    conversationId: cyclicConversation.id,
    branchId: secondBranchId,
  }
  secondBranch.source = {
    conversationId: cyclicConversation.id,
    branchId: firstBranch.id,
  }
  cyclicBranches.push(secondBranch)
  refreshDigest(cyclic)
  await rejectsImport(app, 'op-import-relations-cycle', cyclic, 'IMPORT_INVALID')

  const crossBoundary = parseExport(exported.content)
  const boundaryConversation = crossBoundary.content.conversation
  const boundaryBranches = crossBoundary.content.branches as Array<Record<string, unknown>>
  const boundaryMessages = crossBoundary.content.messages as Array<Record<string, unknown>>
  const boundarySource = boundaryBranches[0]
  const foreignMessage = boundaryMessages[0]
  assert(boundarySource && foreignMessage)
  const emptyBranchId = 'branch-import-boundary-empty'
  boundaryBranches.push({ ...boundarySource, id: emptyBranchId })
  boundarySource.source = {
    conversationId: boundaryConversation.id,
    branchId: emptyBranchId,
    throughMessageId: foreignMessage.id,
  }
  refreshDigest(crossBoundary)
  await rejectsImport(app, 'op-import-relations-boundary', crossBoundary, 'IMPORT_INVALID')

  const orphanRun = parseExport(exported.content)
  const runs = orphanRun.content.runs as Array<Record<string, unknown>>
  const sourceRun = runs[0]
  assert(sourceRun)
  runs.push({ ...sourceRun, id: 'run-import-orphan' })
  refreshDigest(orphanRun)
  await rejectsImport(app, 'op-import-relations-orphan', orphanRun, 'IMPORT_INVALID')

  const crossedCitation = parseExport(exported.content)
  const citationConversation = crossedCitation.content.conversation
  const citationMessages = crossedCitation.content.messages as Array<{ id: string }>
  const citationParts = crossedCitation.content.messageParts as Array<{
    id: string
    messageId: string
  }>
  const citedMessage = citationMessages[0]
  const foreignPart = citationParts.find((part) => part.messageId !== citedMessage?.id)
  assert(citedMessage && foreignPart)
  const analyses = crossedCitation.content.analyses as Array<Record<string, unknown>>
  analyses.push({
    id: 'analysis-import-crossed-citation',
    source: {
      conversationId: citationConversation.id,
      branchId: citationConversation.activeBranchId,
      digest: 'b'.repeat(64),
      complete: true,
    },
    status: 'completed',
    findings: [
      {
        id: 'finding-import-crossed-citation',
        text: 'Mismatched evidence must not be accepted',
        citations: [
          {
            id: 'citation-import-crossed',
            messageId: citedMessage.id,
            partId: foreignPart.id,
          },
        ],
        supported: true,
      },
    ],
    createdAt: crossedCitation.exportedAt,
    updatedAt: crossedCitation.exportedAt,
  })
  refreshDigest(crossedCitation)
  await rejectsImport(app, 'op-import-relations-citation', crossedCitation, 'IMPORT_INVALID')
})

test('conversation import retains normalized part provenance without enabling replay', async () => {
  const app = await initializedApp()
  await app.send({ operationId: 'op-import-part-source', text: 'part provenance' }).completion
  const exported = await app.conversations.exports.export({
    operationId: 'op-import-part-export',
    format: 'json',
  })
  assert(exported.content)
  const document = parseExport(exported.content)
  const messages = document.content.messages as Array<{
    parts: Array<{ source?: Record<string, unknown> }>
  }>
  const sourcePart = messages.flatMap((message) => message.parts).find((part) => part.source)
  assert(sourcePart?.source)
  sourcePart.source.cursor = 'cursor-historical-only'
  refreshDigest(document)

  const imported = await app.conversations.imports.import({
    operationId: 'op-import-part-provenance',
    content: JSON.stringify(document),
  })
  const importedMessages = app
    .state()
    .messages.filter((message) => message.conversationId === imported.conversationId)

  assert.equal(
    importedMessages.some((message) =>
      message.parts.some((part) => part.source?.cursor === 'cursor-historical-only'),
    ),
    true,
  )
  assert.equal(
    app
      .state()
      .runs.some(
        (run) => run.conversationId === imported.conversationId && run.lastCursor !== undefined,
      ),
    false,
  )
})

test('conversation import retains event-only analysis citations as historical evidence', async () => {
  const app = await initializedApp()
  await app.send({
    operationId: 'op-import-event-citation-source',
    text: 'message-backed evidence',
  }).completion
  const exported = await app.conversations.exports.export({
    operationId: 'op-import-event-citation-export',
    format: 'json',
  })
  assert(exported.content)
  const document = parseExport(exported.content)
  const sourceConversation = document.content.conversation
  const sourceConversationId = sourceConversation.id
  const sourceBranchId = sourceConversation.activeBranchId
  assert.equal(typeof sourceConversationId, 'string')
  assert.equal(typeof sourceBranchId, 'string')
  const sourceMessages = document.content.messages as Array<{ id: string }>
  const sourceMessageId = sourceMessages[0]?.id
  assert.equal(typeof sourceMessageId, 'string')
  const analyses = document.content.analyses as Array<Record<string, unknown>>
  analyses.push({
    id: 'analysis-event-citation',
    source: {
      conversationId: sourceConversationId,
      branchId: sourceBranchId,
      digest: 'a'.repeat(64),
      complete: true,
    },
    status: 'completed',
    findings: [
      {
        id: 'finding-event-citation',
        text: 'The retained event supports this finding',
        citations: [{ id: 'citation-event-only', eventId: 'event-imported-history' }],
        supported: true,
      },
      {
        id: 'finding-message-citation',
        text: 'The imported message supports this finding',
        citations: [{ id: 'citation-message', messageId: sourceMessageId }],
        supported: true,
      },
    ],
    createdAt: document.exportedAt,
    updatedAt: document.exportedAt,
  })
  refreshDigest(document)

  const result = await app.conversations.imports.import({
    operationId: 'op-import-event-citation',
    content: JSON.stringify(document),
  })
  const analysis = app
    .state()
    .analyses.find((candidate) => candidate.source.conversationId === result.conversationId)

  assert.equal(analysis?.findings[0]?.supported, false)
  assert.equal(analysis?.findings[0]?.citations[0]?.eventId !== undefined, true)
  assert.equal(analysis?.findings[1]?.supported, true)
  assert.equal(analysis?.findings[1]?.citations[0]?.messageId !== undefined, true)
})

test('conversation deletion purges owned data and retains an honest tombstone', async () => {
  const app = await initializedApp()
  const fallbackId = app.state().conversationId
  const target = await app.conversations.lifecycle.create({
    operationId: 'op-delete-target-create',
    title: 'Delete me',
  })
  await app.send({ operationId: 'op-delete-target-turn', text: 'private target text' }).completion
  const targetBranchIds = new Set(
    app
      .state()
      .branches.filter((branch) => branch.conversationId === target.id)
      .map((branch) => branch.id),
  )

  const tombstone = await app.conversations.lifecycle.delete({
    operationId: 'op-delete-target',
    conversationId: target.id,
  })
  const state = app.state()
  assert.equal(tombstone.deletedAt !== undefined, true)
  assert.equal(state.conversationId, fallbackId)
  assert.equal(
    state.conversations.find((conversation) => conversation.id === target.id)?.title,
    'Deleted conversation',
  )
  assert.equal(
    state.branches.some((branch) => targetBranchIds.has(branch.id)),
    false,
  )
  assert.equal(
    state.messages.some((message) => message.conversationId === target.id),
    false,
  )
  assert.equal(JSON.stringify(state).includes('private target text'), false)
  assertBraidState(state)
})

test('conversation deletion blocks on a pending interaction retained by a terminal run', async () => {
  const execution: ExecutionPort = {
    capabilities: () => DEFAULT_RUN_CAPABILITIES,
    async *streamTurn(input) {
      const request = createInteractionRequest({
        id: 'interaction-delete-pending',
        kind: 'question',
        title: 'Confirm deletion',
        answerSpec: {
          fields: [{ type: 'boolean', name: 'confirm', label: 'Confirm', required: true }],
        },
        binding: {
          runId: input.runId,
          provider: 'fixture',
          environmentId: 'environment-delete-test',
          sessionId: 'session-delete-test',
          executionId: input.runId,
          interactionId: 'interaction-delete-pending',
        },
      })
      yield { type: 'interaction', request }
      yield {
        type: 'final',
        status: 'completed',
        reason: 'complete',
        text: 'finished before the interaction was observed',
        metadata: { tokenUsage: { input: 1, output: 1 } },
        task: { id: 'task-delete-interaction', intent: 'deletion test' },
        timestamp: '2026-08-01T00:00:00.000Z',
      }
    },
  }
  const app = createBraidApplication({
    fixture: 'deterministic',
    execution,
    clock: new FixedClock('2026-08-01T00:00:00.000Z'),
  })
  app.initialize('/workspace')
  const send = app.send({ operationId: 'op-delete-interaction-send', text: 'finish first' })
  await send.completion

  const run = app.state().runs[0]
  assert.ok(run)
  const pendingInteractionId = localInteractionId(run.id, 'interaction-delete-pending')
  assert.equal(run.complete, true)
  assert.equal(app.state().runs[0]?.interactions[0]?.status, 'pending')

  await assert.rejects(
    () =>
      app.conversations.lifecycle.delete({
        operationId: 'op-delete-interaction-blocked',
        conversationId: app.state().conversationId,
      }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'DELETE_BLOCKED' &&
      error.message.includes(pendingInteractionId),
  )
})

test('conversation deletion retains pending identity after 257-entry interaction eviction', async () => {
  const execution: ExecutionPort = {
    capabilities: () => DEFAULT_RUN_CAPABILITIES,
    async *streamTurn(input) {
      for (let index = 0; index < 257; index += 1) {
        const interactionId = `interaction-delete-evicted-${index}`
        yield {
          type: 'interaction',
          request: createInteractionRequest({
            id: interactionId,
            kind: 'question',
            title: `Confirm eviction ${index}`,
            answerSpec: {
              fields: [{ type: 'boolean', name: 'confirm', label: 'Confirm', required: true }],
            },
            binding: {
              runId: input.runId,
              provider: 'fixture',
              environmentId: 'environment-delete-eviction',
              sessionId: 'session-delete-eviction',
              executionId: input.runId,
              interactionId,
            },
          }),
        }
      }
      yield {
        type: 'final',
        status: 'completed',
        reason: 'complete',
        text: 'finished after interaction eviction',
        metadata: { tokenUsage: { input: 1, output: 1 } },
        task: { id: 'task-delete-eviction', intent: 'deletion eviction test' },
        timestamp: '2026-08-01T00:00:00.000Z',
      }
    },
  }
  const app = createBraidApplication({
    fixture: 'deterministic',
    execution,
    clock: new FixedClock('2026-08-01T00:00:00.000Z'),
  })
  app.initialize('/workspace')
  await app.send({ operationId: 'op-delete-eviction-send', text: 'finish after eviction' })
    .completion

  const run = app.state().runs[0]
  assert.ok(run)
  assert.equal(run.complete, true)
  assert.equal(run.interactions.length, 256)
  assert.equal(
    run.interactions.some(
      (item) => item.request.id === localInteractionId(run.id, 'interaction-delete-evicted-0'),
    ),
    false,
  )
  assert.equal(run.pendingInteractionIds?.length, 257)
  assert.equal(
    run.pendingInteractionIds?.includes(localInteractionId(run.id, 'interaction-delete-evicted-0')),
    true,
  )

  await assert.rejects(
    () =>
      app.conversations.lifecycle.delete({
        operationId: 'op-delete-eviction-blocked',
        conversationId: app.state().conversationId,
      }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'DELETE_BLOCKED' &&
      error.message.includes(localInteractionId(run.id, 'interaction-delete-evicted-0')),
  )

  const state = app.state()
  const withoutPendingIndex = state.runs.map((candidate) => {
    if (candidate.id !== run.id) return candidate
    const { pendingInteractionIds: _pendingInteractionIds, ...legacyRun } = candidate
    return legacyRun
  })
  const restoredJournal = Object.assign(
    new MemoryJournal(new FixedClock('2026-08-01T00:00:00.000Z')),
    {
      initialState: () => ({ ...state, runs: withoutPendingIndex }),
    },
  )
  const restarted = createBraidApplication({
    fixture: 'deterministic',
    journal: restoredJournal,
    execution: {
      capabilities: () => DEFAULT_RUN_CAPABILITIES,
      async *streamTurn(): AsyncIterable<never> {},
    },
  })
  await assert.rejects(
    () =>
      restarted.conversations.lifecycle.delete({
        operationId: 'op-delete-eviction-legacy-blocked',
        conversationId: state.conversationId,
      }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'DELETE_BLOCKED' &&
      error.message.includes('pending state is not provable'),
  )
})

test('deletion refuses to break a cloned conversation ancestry link', async () => {
  const app = await initializedApp()
  const sourceId = app.state().conversationId
  await app.send({ operationId: 'op-delete-block-source', text: 'source' }).completion
  const clone = await app.conversations.branches.clone({ operationId: 'op-delete-block-clone' })
  assert.notEqual(clone.id, sourceId)

  await assert.rejects(
    () =>
      app.conversations.lifecycle.delete({
        operationId: 'op-delete-blocked',
        conversationId: sourceId,
      }),
    (error: unknown) => error instanceof AppError && error.code === 'DELETE_BLOCKED',
  )
  assert.equal(
    app.state().conversations.find((conversation) => conversation.id === sourceId)?.deletedAt,
    undefined,
  )
})
