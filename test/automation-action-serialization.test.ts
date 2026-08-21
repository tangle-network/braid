import assert from 'node:assert/strict'
import test from 'node:test'
import type { InteractionRequestMaterial } from '@tangle-network/agent-interface'
import { KeyedActionQueue } from '../src/app/action-serialization.js'
import { createAutomationActions } from '../src/app/automation-actions.js'
import type { StoredAutomationRule } from '../src/app/automation-matching.js'
import { DETERMINISTIC_PROFILE } from '../src/app/composition.js'
import {
  createInteractionRequest,
  interactionResponseBinding,
} from '../src/app/interaction-request.js'
import type { BraidEvent, BraidEventEnvelope } from '../src/domain/events.js'
import type { BraidInteraction } from '../src/domain/runtime-projection.js'
import { type BraidState, initialState } from '../src/domain/state.js'

const NOW = '2026-08-09T00:00:00.000Z'

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: () => resolvePromise?.() }
}

function pendingInteraction(id: string): BraidInteraction {
  const material: InteractionRequestMaterial = {
    id,
    kind: 'question',
    title: 'Continue?',
    answerSpec: {
      fields: [{ type: 'boolean', name: 'continue', label: 'Continue', required: true }],
    },
    responseScopes: ['interaction'],
    binding: {
      runId: 'run-action-race',
      provider: 'test-provider',
      environmentId: 'environment-test',
      sessionId: 'session-test',
      executionId: 'run-action-race',
      interactionId: id,
    },
  }
  const request = createInteractionRequest(material)
  return {
    request,
    responseBinding: interactionResponseBinding(request),
    runId: request.binding.runId,
    source: { occurredAt: NOW },
    status: 'pending',
  }
}

function rule(id: string, answer: boolean): StoredAutomationRule {
  return {
    id: id as StoredAutomationRule['id'],
    enabled: true,
    matcher: { interactionKind: 'question' },
    answer: { continue: answer },
    responseScope: 'once',
    createdAt: NOW,
    maximumUses: 3,
    uses: 0,
  }
}

function stateWithInteraction(
  storedRule: StoredAutomationRule,
  interaction: BraidInteraction,
): BraidState {
  return {
    ...initialState(DETERMINISTIC_PROFILE),
    rules: [storedRule],
    runs: [
      {
        id: interaction.runId,
        receipt: { requested: {} },
        interactions: [interaction],
      },
    ],
  } as unknown as BraidState
}

function applyEvent(state: BraidState, envelope: BraidEventEnvelope): BraidState {
  const event = envelope.event
  const advanced = {
    ...state,
    sequence: envelope.sequence,
    revision: envelope.revision,
  }
  if (event.kind === 'rule.upserted') {
    return {
      ...advanced,
      rules: [...state.rules.filter((candidate) => candidate.id !== event.rule.id), event.rule],
    }
  }
  if (event.kind === 'rule.deleted') {
    return {
      ...advanced,
      rules: state.rules.filter((candidate) => candidate.id !== event.ruleId),
    }
  }
  return advanced
}

test('keyed actions expose pending work until shutdown can safely continue', async () => {
  const queue = new KeyedActionQueue()
  const entered = deferred()
  const release = deferred()
  let idle = false
  const action = queue.run('interaction-response', async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const waiting = queue.whenIdle().then(() => {
    idle = true
  })
  await Promise.resolve()
  assert.equal(idle, false)

  release.resolve()
  await Promise.all([action, waiting])
  assert.equal(idle, true)
})

test('a rule update completes before a queued automatic application reads the rule', async () => {
  const interaction = pendingInteraction('interaction-action-race')
  let current = stateWithInteraction(rule('rule-action-race', true), interaction)
  const events: BraidEventEnvelope[] = []
  const updateEntered = deferred()
  const releaseUpdate = deferred()
  const responses: Array<Record<string, unknown> | undefined> = []

  const commitAndWait = async (event: BraidEvent): Promise<void> => {
    if (event.kind === 'rule.upserted' && event.operation?.id === 'operation-update-action-race') {
      updateEntered.resolve()
      await releaseUpdate.promise
    }
    const envelope: BraidEventEnvelope = {
      sequence: current.sequence + 1,
      revision: current.revision + 1,
      occurredAt: NOW,
      event,
    }
    events.push(envelope)
    current = applyEvent(current, envelope)
  }
  const actions = createAutomationActions({
    state: () => current,
    events: () => events,
    commitAndWait,
    now: () => NOW,
    canRespond: () => true,
    respond: async (input) => {
      responses.push(input.response.data)
      return {
        operationId: input.operationId,
        runId: input.runId,
        interactionId: input.interactionId,
        replayed: false,
        acknowledgement: { operationId: input.operationId, outcome: 'accepted' },
        completion: Promise.resolve(current),
      }
    },
  })

  const updating = actions.update({
    operationId: 'operation-update-action-race',
    ruleId: 'rule-action-race',
    runId: interaction.runId,
    interactionId: interaction.request.id,
    answer: { continue: false },
  })
  await updateEntered.promise
  const applying = actions.apply({
    operationId: 'operation-apply-action-race',
    runId: interaction.runId,
    interactionId: interaction.request.id,
  })
  await Promise.resolve()
  assert.equal(responses.length, 0)

  releaseUpdate.resolve()
  await Promise.all([updating, applying])

  assert.deepEqual(responses, [{ continue: false }])
  assert.deepEqual(current.rules[0]?.answer, { continue: false })
  assert.equal(current.rules[0]?.uses, 1)
})

test('disabling and deleting rules both request pending interaction reconciliation', async () => {
  let current = {
    ...initialState(DETERMINISTIC_PROFILE),
    rules: [rule('rule-disable', true), rule('rule-delete', false)],
  } as BraidState
  const events: BraidEventEnvelope[] = []
  let reconciliations = 0
  const actions = createAutomationActions({
    state: () => current,
    events: () => events,
    now: () => NOW,
    canRespond: () => true,
    commitAndWait: (event) => {
      const envelope: BraidEventEnvelope = {
        sequence: current.sequence + 1,
        revision: current.revision + 1,
        occurredAt: NOW,
        event,
      }
      events.push(envelope)
      current = applyEvent(current, envelope)
    },
    respond: async () => {
      throw new Error('No interaction response expected')
    },
    reconcilePending: async () => {
      reconciliations += 1
    },
  })

  await actions.disable({ operationId: 'operation-disable-rule', ruleId: 'rule-disable' })
  await actions.delete({ operationId: 'operation-delete-rule', ruleId: 'rule-delete' })

  assert.equal(reconciliations, 2)
  assert.equal(current.rules.find((candidate) => candidate.id === 'rule-disable')?.enabled, false)
  assert.equal(
    current.rules.some((candidate) => candidate.id === 'rule-delete'),
    false,
  )
})
