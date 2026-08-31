import assert from 'node:assert/strict'
import test from 'node:test'
import { defineAgentProfile } from '@tangle-network/agent-interface'
import { defaultTangleSandboxCapabilities } from '@tangle-network/agent-provider-tangle'
import { retainedExecutionKey } from '../src/adapters/runtime/retained-execution-state.js'
import { createBraidApplication } from '../src/app/composition.js'
import { MemoryJournal } from '../src/app/journal.js'
import { runEffectRequest } from '../src/app/run-admission-request.js'
import { snapshotRunExecution } from '../src/app/run-execution-snapshot.js'
import { canonicalDigest } from '../src/domain/canonical.js'
import { createAdmissionReceipt } from '../src/domain/receipts.js'
import { requestedInteractionsForRun } from '../src/domain/run-interactions.js'
import type { BraidRuntimeEvent } from '../src/domain/runtime-events.js'
import { initialState } from '../src/domain/state.js'
import { FixedClock } from '../src/ports/clock.js'
import {
  DEFAULT_RUN_CAPABILITIES,
  type ExecuteTurnInput,
  type ExecutionPort,
  type RunCapabilities,
} from '../src/ports/execution.js'

const PROFILE = defineAgentProfile({
  name: 'Per-turn interaction test',
  harness: 'opencode',
  model: { default: 'fixture/interaction-test' },
})

function capabilitiesFor(kinds: readonly string[], responseIdempotency = true): RunCapabilities {
  const environment = defaultTangleSandboxCapabilities('opencode')
  assert.ok(environment.interactions)
  return {
    ...DEFAULT_RUN_CAPABILITIES,
    environment: {
      ...environment,
      interactions: {
        ...environment.interactions,
        kinds: [...kinds],
        responseIdempotency,
      },
    },
  }
}

async function dispatchedInput(
  mode: string | undefined,
  capabilities: RunCapabilities,
): Promise<ExecuteTurnInput> {
  let received: ExecuteTurnInput | undefined
  const execution: ExecutionPort = {
    admit: () => ({ capabilities }),
    async *streamTurn(input): AsyncIterable<BraidRuntimeEvent> {
      received = input
      yield {
        type: 'final',
        task: { id: input.runId, intent: 'interaction wiring test' },
        status: 'completed',
        reason: 'completed',
        text: 'done',
        metadata: { tokenUsage: { input: 1, output: 1 } },
        timestamp: '2026-08-15T00:00:00.000Z',
      }
    },
  }
  const clock = new FixedClock()
  const journal = new MemoryJournal(clock)
  const app = createBraidApplication({
    profile: PROFILE,
    execution,
    clock,
    journal,
    effectStorage: journal,
  })
  app.initialize('/workspace')
  if (mode !== undefined) {
    await app.conversations.branches.setRunOverrides({
      operationId: `operation-mode-${mode}`,
      mode,
    })
  }
  const receipt = app.send({ operationId: `operation-${mode ?? 'normal'}`, text: 'continue' })
  await receipt.completion
  assert.ok(received)
  return received
}

test('selected mode survives the snapshot, effect request, receipt, and retry identity', () => {
  const state = { ...initialState(PROFILE), workspace: '/workspace' }
  const snapshot = snapshotRunExecution(
    { operationId: 'operation-mode', text: 'review the plan' },
    state,
    PROFILE,
    undefined,
    'plan',
  )
  assert.equal(snapshot.mode, 'plan')
  assert.equal(runEffectRequest(snapshot).mode, 'plan')

  const receipt = createAdmissionReceipt({
    runId: 'run-mode',
    turnId: 'turn-mode',
    operationId: snapshot.operationId,
    conversationId: snapshot.conversationId,
    branchId: snapshot.branchId,
    admittedAt: '2026-08-15T00:00:00.000Z',
    profile: snapshot.profile,
    text: snapshot.text,
    mode: snapshot.mode,
    interactions: { plan: true },
    capabilities: DEFAULT_RUN_CAPABILITIES,
  })
  assert.equal(receipt.requested.mode, 'plan')
  assert.deepEqual(receipt.requested.interactions, { plan: true })

  const base: ExecuteTurnInput = {
    operationId: 'operation-retry',
    runId: 'run-retry',
    text: 'retry this',
    profile: PROFILE,
    signal: new AbortController().signal,
  }
  assert.notEqual(
    retainedExecutionKey({ ...base, mode: 'normal' }),
    retainedExecutionKey({ ...base, mode: 'plan' }),
  )
  assert.equal(
    receipt.requestDigest,
    canonicalDigest({
      runId: 'run-mode',
      turnId: 'turn-mode',
      operationId: snapshot.operationId,
      conversationId: snapshot.conversationId,
      branchId: snapshot.branchId,
      text: snapshot.text,
      profileDigest: receipt.profileDigest,
      connectionId: null,
      mode: 'plan',
      workspaceRequest: null,
      workspaceRoot: null,
      interactions: { plan: true },
      contextPlanDigest: null,
    }),
  )
})

test('normal mode requests advertised permission and question kinds, never plan', async () => {
  const advertised = capabilitiesFor(['permission', 'question', 'plan']).environment
  assert.ok(advertised)
  assert.deepEqual(
    requestedInteractionsForRun(undefined, {
      environment: advertised,
    }),
    { permission: true, question: true },
  )
  assert.deepEqual(
    (await dispatchedInput(undefined, capabilitiesFor(['permission', 'question', 'plan'])))
      .interactions,
    { permission: true, question: true },
  )
})

test('plan mode enables plan only when the admitted capability advertises it', async () => {
  const advertised = capabilitiesFor(['permission', 'plan']).environment
  assert.ok(advertised)
  assert.deepEqual(
    requestedInteractionsForRun('plan', {
      environment: advertised,
    }),
    { permission: true, plan: true },
  )
  assert.deepEqual(
    (await dispatchedInput('plan', capabilitiesFor(['permission', 'question']))).interactions,
    { permission: true, question: true },
  )
})

test('unsupported or non-idempotent response capability passes an explicit empty map', async () => {
  const unsupported = requestedInteractionsForRun(
    'plan',
    capabilitiesFor(['permission', 'question', 'plan'], false),
  )
  assert.deepEqual(unsupported, {})
  assert.equal(Object.isFrozen(unsupported), true)
  const received = await dispatchedInput('plan', { ...DEFAULT_RUN_CAPABILITIES })
  assert.deepEqual(received.interactions, {})
  assert.equal(Object.isFrozen(received.interactions), true)
})

test('the retained execution boundary receives the exact admitted map', async () => {
  const expected = { permission: true, question: true, plan: true }
  const received = await dispatchedInput(
    'plan',
    capabilitiesFor(['permission', 'question', 'plan']),
  )
  assert.deepEqual(received.interactions, expected)
  assert.equal(Object.isFrozen(received.interactions), true)
})
