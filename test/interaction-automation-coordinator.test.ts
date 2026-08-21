import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  InteractionRequest,
  InteractionRequestMaterial,
} from '@tangle-network/agent-interface'
import { ruleUseReservationId } from '../src/app/automation-rule-persistence.js'
import { automationOperationRecord } from '../src/app/automation-rule-store.js'
import {
  automationPolicyDigest,
  InteractionAutomationCoordinator,
  type InteractionAutomationTarget,
  interactionAutomationOperationId,
} from '../src/app/interaction-automation-coordinator.js'
import {
  createInteractionRequest,
  interactionResponseBinding,
} from '../src/app/interaction-request.js'
import { canonicalDigest } from '../src/domain/canonical.js'
import type { BraidEventEnvelope } from '../src/domain/events.js'
import { createOperationId } from '../src/domain/ids.js'
import type { BraidState } from '../src/domain/state.js'

const NOW = '2026-08-09T00:00:00.000Z'

function request(id: string, runId: string, title = 'Continue?'): InteractionRequest {
  const material: InteractionRequestMaterial = {
    id,
    kind: 'question',
    title,
    answerSpec: {
      fields: [{ type: 'boolean', name: 'continue', label: 'Continue', required: true }],
    },
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

function target(
  id: string,
  runId = 'run-test',
  status: InteractionAutomationTarget['status'] = 'pending',
): InteractionAutomationTarget {
  const interactionRequest = request(id, runId)
  return {
    request: interactionRequest,
    responseBinding: interactionResponseBinding(interactionRequest),
    runId,
    source: { occurredAt: NOW },
    status,
  }
}

function requestedResponse(
  item: InteractionAutomationTarget,
  operationId: string,
): BraidEventEnvelope {
  return {
    sequence: 1,
    revision: 1,
    occurredAt: NOW,
    event: {
      kind: 'run.interaction.response.requested',
      runId: item.runId,
      interactionId: item.request.id,
      operationId,
      outcome: 'accepted',
      containsSecret: false,
    },
  }
}

function stateFor(...targets: readonly InteractionAutomationTarget[]): BraidState {
  const runIds = [...new Set(targets.map((item) => item.runId))]
  return {
    runs: runIds.map((runId) => ({
      id: runId,
      interactions: targets.filter((item) => item.runId === runId),
    })),
  } as unknown as BraidState
}

function stateWithRules(
  rules: BraidState['rules'],
  ...targets: readonly InteractionAutomationTarget[]
): BraidState {
  return { ...stateFor(...targets), rules }
}

function reservedRuleUse(
  operationId: string,
  rule: BraidState['rules'][number],
): BraidEventEnvelope {
  const reservedRule = { ...rule, uses: rule.uses + 1 }
  return {
    sequence: 1,
    revision: 1,
    occurredAt: NOW,
    event: {
      kind: 'rule.upserted',
      rule: reservedRule,
      operation: automationOperationRecord(
        ruleUseReservationId(operationId, rule.id),
        canonicalDigest({
          kind: 'automation.rule.use',
          operationId,
          ruleId: rule.id,
          uses: reservedRule.uses,
        }),
        NOW,
      ),
    },
  }
}

test('derives one stable operation ID from the run and request digest', () => {
  const first = request('interaction-id', 'run-one')
  const same = request('interaction-id', 'run-one')
  const differentRun = request('interaction-id', 'run-two')
  const differentRequest = request('interaction-id', 'run-one', 'Stop?')

  assert.equal(
    interactionAutomationOperationId('run-one', first),
    interactionAutomationOperationId('run-one', same),
  )
  assert.notEqual(
    interactionAutomationOperationId('run-one', first),
    interactionAutomationOperationId('run-two', differentRun),
  )
  assert.notEqual(
    interactionAutomationOperationId('run-one', first),
    interactionAutomationOperationId('run-one', differentRequest),
  )
  assert.match(
    interactionAutomationOperationId('run-one', first),
    /^operation-automation-interaction-/u,
  )
  assert.equal(automationPolicyDigest([]), automationPolicyDigest([]))
})

test('policy changes create a new attempt while use reservations keep the same attempt', () => {
  const interactionRequest = request('interaction-policy', 'run-policy')
  const rule = {
    id: 'rule-policy',
    enabled: true,
    matcher: { interactionKind: 'question' },
    answer: { continue: true },
    responseScope: 'once',
    createdAt: NOW,
    maximumUses: 1,
    uses: 0,
  } as BraidState['rules'][number]

  const withoutRule = interactionAutomationOperationId('run-policy', interactionRequest, [])
  const withRule = interactionAutomationOperationId('run-policy', interactionRequest, [rule])
  const reserved = interactionAutomationOperationId('run-policy', interactionRequest, [
    { ...rule, uses: 1 },
  ])

  assert.notEqual(withoutRule, withRule)
  assert.equal(withRule, reserved)
})

test('duplicate scheduling shares one in-flight application', async () => {
  const item = target('interaction-duplicate')
  let release: (() => void) | undefined
  const calls: string[] = []
  const coordinator = new InteractionAutomationCoordinator({
    state: () => stateFor(item),
    events: () => [],
    apply: async ({ interactionId }) => {
      calls.push(interactionId)
      await new Promise<void>((resolve) => {
        release = resolve
      })
    },
  })

  const first = coordinator.schedule(item)
  const duplicate = coordinator.schedule(item)
  assert.strictEqual(duplicate, first)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, ['interaction-duplicate'])
  release?.()
  await first
  assert.deepEqual(calls, ['interaction-duplicate'])
})

test('a queued attempt reschedules itself when the rule policy changes', async () => {
  const item = target('interaction-policy-change')
  const originalRule = {
    id: 'rule-original-policy',
    enabled: true,
    matcher: { interactionKind: 'question' },
    answer: { continue: true },
    responseScope: 'once',
    createdAt: NOW,
    uses: 0,
  } as BraidState['rules'][number]
  const changedRule = { ...originalRule, answer: { continue: false } }
  let rules: BraidState['rules'] = [originalRule]
  const calls: string[] = []
  const coordinator = new InteractionAutomationCoordinator({
    state: () => stateWithRules(rules, item),
    events: () => [],
    apply: async ({ operationId }) => {
      calls.push(operationId)
    },
  })

  const scheduled = coordinator.schedule(item)
  rules = [changedRule]
  await scheduled
  await coordinator.whenIdle()

  assert.deepEqual(calls, [interactionAutomationOperationId(item.runId, item.request, rules)])
})

test('a failed application reports the error and does not poison later work', async () => {
  const failed = target('interaction-failed')
  const succeeds = target('interaction-succeeds')
  const calls: string[] = []
  const errors: InteractionAutomationTarget[] = []
  const coordinator = new InteractionAutomationCoordinator({
    state: () => stateFor(failed, succeeds),
    events: () => [],
    apply: async ({ interactionId }) => {
      calls.push(interactionId)
      if (interactionId === failed.request.id) throw new Error('provider unavailable')
    },
    onError: (error, item) => {
      assert(error instanceof Error)
      errors.push(item)
    },
  })

  await Promise.all([coordinator.schedule(failed), coordinator.schedule(succeeds)])
  assert.deepEqual(calls, ['interaction-failed', 'interaction-succeeds'])
  assert.deepEqual(
    errors.map((item) => item.request.id),
    ['interaction-failed'],
  )
})

test('reconcile schedules every pending interaction after restart', async () => {
  const pendingA = target('interaction-pending-a')
  const pendingB = target('interaction-pending-b')
  const calls: string[] = []
  const coordinator = new InteractionAutomationCoordinator({
    state: () =>
      stateFor(
        pendingA,
        pendingB,
        target('interaction-resolved', 'run-test', 'resolved'),
        target('interaction-cancelled', 'run-test', 'cancelled'),
        target('interaction-declined', 'run-test', 'declined'),
        target('interaction-unknown', 'run-test', 'unknown'),
      ),
    events: () => [],
    apply: async ({ interactionId }) => {
      calls.push(interactionId)
    },
  })

  await coordinator.reconcile()
  assert.deepEqual(calls, ['interaction-pending-a', 'interaction-pending-b'])
})

test('reconcile resumes a reserved automatic response after the policy changes', async () => {
  const item = target('interaction-own-response')
  const reservedRule = {
    id: 'rule-reserved-response',
    enabled: true,
    matcher: { interactionKind: 'question' },
    answer: { continue: true },
    responseScope: 'once',
    createdAt: NOW,
    maximumUses: 2,
    uses: 0,
  } as BraidState['rules'][number]
  const changedRule = { ...reservedRule, answer: { continue: false } }
  const operationId = interactionAutomationOperationId(item.runId, item.request, [reservedRule])
  const responding = target(item.request.id, item.runId, 'responding')
  const reservation = reservedRuleUse(operationId, reservedRule)
  const calls: string[] = []
  const coordinator = new InteractionAutomationCoordinator({
    state: () => stateWithRules([changedRule], responding),
    events: () => [reservation, requestedResponse(responding, operationId)],
    apply: async (input) => {
      calls.push(input.operationId)
      assert.equal(input.runId, responding.runId)
      assert.equal(input.interactionId, responding.request.id)
    },
  })

  await coordinator.reconcile()
  assert.deepEqual(calls, [operationId])
})

test('reconcile resumes an automatic response from saved interaction state without old events', async () => {
  const item = target('interaction-saved-response')
  const reservedRule = {
    id: 'rule-saved-response',
    enabled: true,
    matcher: { interactionKind: 'question' },
    answer: { continue: true },
    responseScope: 'once',
    createdAt: NOW,
    maximumUses: 2,
    uses: 1,
  } as BraidState['rules'][number]
  const changedRule = { ...reservedRule, answer: { continue: false } }
  const operationId = interactionAutomationOperationId(item.runId, item.request, [
    { ...reservedRule, uses: 0 },
  ])
  const responding: InteractionAutomationTarget = {
    ...target(item.request.id, item.runId, 'responding'),
    responseOperation: {
      operationId: createOperationId(operationId),
      outcome: 'accepted',
      containsSecret: false,
      automationRule: reservedRule,
    },
  }
  const calls: string[] = []
  const coordinator = new InteractionAutomationCoordinator({
    state: () => stateWithRules([changedRule], responding),
    events: () => [],
    apply: async (input) => {
      calls.push(input.operationId)
    },
  })

  await coordinator.reconcile()
  assert.deepEqual(calls, [operationId])
})

test('reconcile skips a responding interaction owned by a manual response', async () => {
  const item = target('interaction-manual-response')
  const responding = target(item.request.id, item.runId, 'responding')
  let calls = 0
  const coordinator = new InteractionAutomationCoordinator({
    state: () => stateFor(responding),
    events: () => [requestedResponse(responding, 'operation-manual-response')],
    apply: async () => {
      calls += 1
    },
  })

  await coordinator.reconcile()
  assert.equal(calls, 0)
})
