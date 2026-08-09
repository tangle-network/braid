import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  InteractionRequest,
  InteractionRequestMaterial,
} from '@tangle-network/agent-interface'
import {
  InteractionAutomationCoordinator,
  type InteractionAutomationTarget,
  interactionAutomationOperationId,
} from '../src/app/interaction-automation-coordinator.js'
import {
  createInteractionRequest,
  interactionResponseBinding,
} from '../src/app/interaction-request.js'
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
  response?: InteractionAutomationTarget['response'],
): InteractionAutomationTarget {
  const interactionRequest = request(id, runId)
  return {
    request: interactionRequest,
    responseBinding: interactionResponseBinding(interactionRequest),
    runId,
    source: { occurredAt: NOW },
    status,
    ...(response === undefined ? {} : { response }),
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
})

test('duplicate scheduling shares one in-flight application', async () => {
  const item = target('interaction-duplicate')
  let release: (() => void) | undefined
  const calls: string[] = []
  const coordinator = new InteractionAutomationCoordinator({
    state: () => stateFor(item),
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

test('a failed application reports the error and does not poison later work', async () => {
  const failed = target('interaction-failed')
  const succeeds = target('interaction-succeeds')
  const calls: string[] = []
  const errors: InteractionAutomationTarget[] = []
  const coordinator = new InteractionAutomationCoordinator({
    state: () => stateFor(failed, succeeds),
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
    apply: async ({ interactionId }) => {
      calls.push(interactionId)
    },
  })

  await coordinator.reconcile()
  assert.deepEqual(calls, ['interaction-pending-a', 'interaction-pending-b'])
})

test('reconcile resumes a response requested by this coordinator', async () => {
  const item = target('interaction-own-response')
  const operationId = interactionAutomationOperationId(item.runId, item.request)
  const responding = target(item.request.id, item.runId, 'responding', {
    requested: { operationId },
  })
  const calls: string[] = []
  const coordinator = new InteractionAutomationCoordinator({
    state: () => stateFor(responding),
    apply: async (input) => {
      calls.push(input.operationId)
      assert.equal(input.runId, responding.runId)
      assert.equal(input.interactionId, responding.request.id)
    },
  })

  await coordinator.reconcile()
  assert.deepEqual(calls, [operationId])
})

test('reconcile skips a responding interaction owned by a manual response', async () => {
  const item = target('interaction-manual-response')
  const responding = target(item.request.id, item.runId, 'responding', {
    requested: { operationId: 'operation-manual-response' },
  })
  let calls = 0
  const coordinator = new InteractionAutomationCoordinator({
    state: () => stateFor(responding),
    apply: async () => {
      calls += 1
    },
  })

  await coordinator.reconcile()
  assert.equal(calls, 0)
})
