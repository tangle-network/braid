import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type {
  InteractionRequest,
  InteractionRequestMaterial,
} from '@tangle-network/agent-interface'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import { openSqliteStorage } from '../src/adapters/storage/sqlite.js'
import { createBraidApplication, DETERMINISTIC_PROFILE } from '../src/app/composition.js'
import { InteractionAutomationCoordinator } from '../src/app/interaction-automation-coordinator.js'
import { automationOperationRecord } from '../src/app/automation-rule-store.js'
import { ruleUseReservationId } from '../src/app/automation-rule-persistence.js'
import { StorageJournal } from '../src/app/storage-journal.js'
import { canonicalDigest } from '../src/domain/canonical.js'
import type { BraidEvent, BraidEventEnvelope } from '../src/domain/events.js'
import {
  createConversationId,
  createEventId,
  createInteractionId,
  createMessageId,
  createOperationId,
  createRuleId,
  createRunId,
  createTurnId,
  createWorkspaceId,
} from '../src/domain/ids.js'
import { createMaterializedStateSnapshot } from '../src/domain/materialized-state-snapshot.js'
import { replayEvents } from '../src/domain/reducer.js'
import { type BraidState, initialState } from '../src/domain/state.js'
import type { ExecutionPort } from '../src/ports/execution.js'
import { DEFAULT_RUN_CAPABILITIES } from '../src/ports/execution.js'
import type { JournalEvent } from '../src/ports/storage.js'
import { toJson } from '../src/app/storage-journal-support.js'
import {
  createInteractionRequest,
  interactionResponseBinding,
  rebindInteractionRequest,
} from '../src/app/interaction-request.js'
import type { StoredAutomationRule } from '../src/app/automation-matching.js'
import type { SqliteStorage } from '../src/adapters/storage/sqlite.js'

const NOW = '2026-08-09T00:00:00.000Z'
const RESPONSE_TIMEOUT_MS = 25
const RESPONSE_SETTLE_TIMEOUT_MS = 150
const SNAPSHOT_SEQUENCE = 128

function interactionRequest(id: string, runId = 'run-response-durability'): InteractionRequest {
  const material: InteractionRequestMaterial = {
    id,
    kind: 'question',
    title: 'Continue?',
    answerSpec: {
      fields: [{ type: 'boolean', name: 'continue', label: 'Continue', required: true }],
    },
    responseScopes: ['interaction'],
    binding: {
      runId,
      provider: 'test-provider',
      environmentId: 'environment-test',
      sessionId: 'session-test',
      executionId: runId,
      interactionId: id,
    },
  }
  return createInteractionRequest(material)
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the expected state')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function observeSettlement(
  label: string,
  action: Promise<unknown>,
): Promise<{
  readonly label: string
  readonly status: 'fulfilled' | 'rejected' | 'timed-out'
  readonly error?: string
}> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  try {
    await Promise.race([
      action,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          reject(new Error(`${label} did not settle within ${RESPONSE_SETTLE_TIMEOUT_MS}ms`))
        }, RESPONSE_SETTLE_TIMEOUT_MS)
      }),
    ])
    return { label, status: 'fulfilled' }
  } catch (error) {
    return {
      label,
      status: timedOut ? 'timed-out' : 'rejected',
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

test('a hung provider response cannot strand manual response, rule mutation, or shutdown', async () => {
  const source = interactionRequest('interaction-hung-provider')
  let responseStarted: (() => void) | undefined
  const responseStartedPromise = new Promise<void>((resolve) => {
    responseStarted = resolve
  })
  let responseCalls = 0
  let receivedSignal: AbortSignal | undefined
  const execution: ExecutionPort = {
    capabilities: () => DEFAULT_RUN_CAPABILITIES,
    async *streamTurn(input): AsyncIterable<{
      readonly type: 'interaction'
      readonly request: InteractionRequest
    }> {
      yield {
        type: 'interaction',
        request: rebindInteractionRequest(source, {
          ...source.binding,
          runId: input.runId,
          executionId: input.runId,
        }),
      }
      await responseStartedPromise
    },
    respondInteraction: (input) => {
      responseCalls += 1
      receivedSignal = input.signal
      responseStarted?.()
      return new Promise<never>(() => {})
    },
  }
  const app = createBraidApplication({
    fixture: 'deterministic',
    execution,
    interactionResponseTimeoutMs: RESPONSE_TIMEOUT_MS,
  })
  app.initialize('/workspace')
  await app.automation.create({
    operationId: 'operation-create-hung-provider-rule',
    ruleId: 'rule-hung-provider',
    request: source,
    answer: { continue: true },
    responseScope: 'once',
    maximumUses: 1,
  })

  const send = app.send({ operationId: 'operation-send-hung-provider', text: 'ask' })
  await responseStartedPromise
  await waitFor(() => app.state().runs[0]?.interactions[0]?.status === 'responding')
  const run = app.state().runs[0]
  const interaction = run?.interactions[0]
  assert(run && interaction)

  const manual = app.respondInteraction({
    operationId: 'operation-manual-after-hung-provider',
    runId: run.id,
    interactionId: interaction.request.id,
    response: {
      id: interaction.request.id,
      outcome: 'accepted',
      data: { continue: false },
    },
  })
  const disable = app.automation.disable({
    operationId: 'operation-disable-hung-provider-rule',
    ruleId: 'rule-hung-provider',
  })
  const close = app.close()
  const settlements = await Promise.all([
    observeSettlement('manual response', manual),
    observeSettlement('rule disable', disable),
    observeSettlement('app close', close),
  ])

  assert.deepEqual(
    settlements.map(({ label, status }) => ({ label, status })),
    [
      { label: 'manual response', status: 'rejected' },
      { label: 'rule disable', status: 'fulfilled' },
      { label: 'app close', status: 'fulfilled' },
    ],
  )
  assert.equal(responseCalls, 1)
  assert.equal(receivedSignal?.aborted, true)
  assert.equal(app.state().runs[0]?.interactions[0]?.status, 'unknown')
  assert.equal(app.state().rules[0]?.enabled, false)
  await observeSettlement('send completion', send.completion)
})

function envelope(sequence: number, event: BraidEvent): BraidEventEnvelope {
  return {
    eventId: createEventId(`event-response-durability-${sequence}`),
    sequence,
    revision: sequence,
    occurredAt: NOW,
    event,
  }
}

function journalEvent(
  item: BraidEventEnvelope,
  workspaceId: ReturnType<typeof createWorkspaceId>,
  conversationId: ReturnType<typeof createConversationId>,
  runId: ReturnType<typeof createRunId>,
): JournalEvent {
  if (item.eventId === undefined) throw new Error('Durability fixture event needs an event ID')
  return {
    workspaceId,
    conversationId,
    runId,
    eventId: item.eventId,
    sequence: item.sequence,
    kind: item.event.kind,
    payload: toJson({
      __braidEvent: item.event,
      __braidEnvelope: {
        sequence: item.sequence,
        revision: item.revision,
        occurredAt: item.occurredAt,
        eventId: item.eventId,
      },
    }),
    occurredAt: item.occurredAt,
    terminal: false,
  }
}

function boundaryFixture(): {
  readonly events: readonly BraidEventEnvelope[]
  readonly state: BraidState
  readonly runId: ReturnType<typeof createRunId>
  readonly interactionId: ReturnType<typeof createInteractionId>
  readonly operationId: ReturnType<typeof createOperationId>
  readonly rule: StoredAutomationRule
  readonly workspaceId: ReturnType<typeof createWorkspaceId>
  readonly conversationId: ReturnType<typeof createConversationId>
} {
  const workspaceId = createWorkspaceId('workspace-response-durability')
  const conversationId = createConversationId('conversation-response-durability')
  const runId = createRunId('run-response-durability')
  const turnId = createTurnId('turn-response-durability')
  const interactionId = createInteractionId('interaction-response-durability')
  const operationId = createOperationId('operation-automation-response-durability')
  const userMessageId = createMessageId('message-user-response-durability')
  const assistantMessageId = createMessageId('message-assistant-response-durability')
  const request = interactionRequest(interactionId, runId)
  const rule: StoredAutomationRule = {
    id: createRuleId('rule-response-durability'),
    enabled: true,
    matcher: { interactionKind: 'question' },
    answer: { continue: true },
    responseScope: 'once',
    createdAt: NOW,
    maximumUses: 2,
    uses: 0,
  }
  const reservedRule: StoredAutomationRule = { ...rule, uses: 1 }
  const reservationId = ruleUseReservationId(operationId, rule.id)
  const reservationDigest = canonicalDigest({
    kind: 'automation.rule.use',
    operationId,
    ruleId: rule.id,
    uses: reservedRule.uses,
  })
  const events: BraidEventEnvelope[] = [
    envelope(1, { kind: 'workspace.opened', workspace: '/workspace/response-durability' }),
    envelope(2, {
      kind: 'run.requested',
      operationId,
      runId,
      turnId,
      userMessageId,
      assistantMessageId,
      text: 'wait for an interaction',
    }),
    envelope(3, {
      kind: 'run.interaction',
      runId,
      request,
      responseBinding: interactionResponseBinding(request),
      provider: {
        eventId: 'provider-event-response-durability',
        providerSequence: 1,
        occurredAt: NOW,
      },
    }),
    envelope(4, {
      kind: 'rule.upserted',
      rule,
      operation: automationOperationRecord(
        createOperationId('operation-create-response-durability-rule'),
        canonicalDigest({ kind: 'automation.rule.create', rule }),
        NOW,
      ),
    }),
  ]
  for (let sequence = 5; sequence < SNAPSHOT_SEQUENCE - 1; sequence += 1) {
    events.push(envelope(sequence, { kind: 'draft.changed', text: `history-${sequence}` }))
  }
  events.push(
    envelope(SNAPSHOT_SEQUENCE - 1, {
      kind: 'rule.upserted',
      rule: reservedRule,
      operation: automationOperationRecord(reservationId, reservationDigest, NOW),
    }),
    envelope(SNAPSHOT_SEQUENCE, {
      kind: 'run.interaction.response.requested',
      runId,
      interactionId,
      operationId,
      outcome: 'accepted',
      containsSecret: false,
      automationRule: reservedRule,
    }),
  )
  return {
    events,
    state: replayEvents(initialState(DETERMINISTIC_PROFILE, { conversationId }), events),
    runId,
    interactionId,
    operationId,
    rule: reservedRule,
    workspaceId,
    conversationId,
  }
}

test('a response request at the snapshot boundary resumes its reserved answer after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-interaction-response-durability-'))
  const path = join(root, 'braid.sqlite')
  const credentials = new MemoryCredentialStore()
  const databaseKeyRef = `cred:v1:interaction-response-durability-${Date.now()}` as const
  let storage: SqliteStorage | undefined
  try {
    const fixture = boundaryFixture()
    storage = await openSqliteStorage({
      path,
      workspaceRoot: root,
      credentialStore: credentials,
      databaseKeyRef,
    })
    await storage.append(
      fixture.events.map((item) =>
        journalEvent(item, fixture.workspaceId, fixture.conversationId, fixture.runId),
      ),
    )
    const snapshot = createMaterializedStateSnapshot({
      scopeId: storage.snapshotScopeId(),
      generation: SNAPSHOT_SEQUENCE,
      eventId: fixture.events[SNAPSHOT_SEQUENCE - 1]?.eventId ?? createEventId('event-missing'),
      state: fixture.state,
    })
    await storage.writeStateSnapshot(snapshot)
    await storage.close()
    storage = await openSqliteStorage({
      path,
      workspaceRoot: root,
      credentialStore: credentials,
      databaseKeyRef,
    })
    const journal = await StorageJournal.fromStorage(storage, { now: () => NOW })
    const restored = journal.initialState()
    assert(restored)
    const restoredRun = restored.runs.find((run) => run.id === fixture.runId)
    const restoredInteraction = restoredRun?.interactions.find(
      (item) => item.request.id === fixture.interactionId,
    )
    assert(restoredInteraction)
    const liveRule = { ...fixture.rule, answer: { continue: false } }
    const liveState: BraidState = {
      ...restored,
      rules: restored.rules.map((rule) => (rule.id === fixture.rule.id ? liveRule : rule)),
    }
    const resumed: Array<{ readonly operationId: string; readonly answer?: unknown }> = []
    const coordinator = new InteractionAutomationCoordinator({
      state: () => liveState,
      events: () => journal.all(),
      apply: async ({ operationId }) => {
        const target = liveState.runs
          .find((run) => run.id === fixture.runId)
          ?.interactions.find((item) => item.request.id === fixture.interactionId)
        const durable = target
        resumed.push({
          operationId,
          answer: durable?.responseOperation?.automationRule?.answer,
        })
      },
    })
    await coordinator.reconcile()

    assert.deepEqual(
      {
        snapshotSequence: restored.sequence,
        postSnapshotTail: journal.all().length,
        responseOperationId: restoredInteraction.responseOperation?.operationId,
        responseAutomationRule: restoredInteraction.responseOperation?.automationRule,
        liveAnswer: liveState.rules.find((rule) => rule.id === fixture.rule.id)?.answer,
        resumed,
      },
      {
        snapshotSequence: SNAPSHOT_SEQUENCE,
        postSnapshotTail: 0,
        responseOperationId: fixture.operationId,
        responseAutomationRule: fixture.rule,
        liveAnswer: { continue: false },
        resumed: [{ operationId: fixture.operationId, answer: fixture.rule.answer }],
      },
    )
  } finally {
    await storage?.close()
    await rm(root, { force: true, recursive: true })
  }
})
