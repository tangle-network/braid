import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type InteractionRequest,
  type InteractionResponse,
  permissionAnswerSpec,
} from '@tangle-network/agent-interface'
import { AppError, BraidApplication } from '../src/app/application.js'
import { DETERMINISTIC_PROFILE } from '../src/app/composition.js'
import { createInteractionRequest, rebindInteractionRequest } from '../src/app/interaction-request.js'
import { MemoryJournal } from '../src/app/journal.js'
import type { BraidRuntimeEvent } from '../src/domain/runtime-events.js'
import { FixedClock } from '../src/ports/clock.js'
import { DEFAULT_RUN_CAPABILITIES, type ExecutionPort } from '../src/ports/execution.js'
import { SequenceIds } from '../src/ports/ids.js'
import { interactionResponseRunCapabilities } from './support/run-capabilities.js'

const NOW = '2026-08-01T00:00:00.000Z'

function permission(id: string, timeoutMs?: number): InteractionRequest {
  return createInteractionRequest({
    id,
    kind: 'permission',
    title: `Allow ${id}?`,
    answerSpec: permissionAnswerSpec({ allowFeedback: true, responseScopes: ['interaction'] }),
    responseScopes: ['interaction'],
    ...(timeoutMs === undefined ? {} : { timeoutMs, onTimeout: 'fail' as const }),
    binding: {
      runId: 'run-concurrent',
      provider: 'test-provider',
      environmentId: 'environment-test',
      sessionId: 'session-test',
      executionId: 'run-concurrent',
      interactionId: id,
    },
  })
}

/**
 * A provider that holds every request open at once, as a provider declaring
 * `concurrentRequests` may, and finishes the turn only after each one is
 * settled by a response or by the provider itself.
 */
function concurrentProvider(requests: readonly InteractionRequest[]) {
  const settled = new Set<string>()
  const answers = new Map<string, InteractionResponse>()
  let wake: (() => void) | undefined
  const settle = (id: string) => {
    settled.add(id)
    wake?.()
  }
  const execution: ExecutionPort = {
    capabilities: () => interactionResponseRunCapabilities(),
    async *streamTurn(input): AsyncIterable<BraidRuntimeEvent> {
      for (const request of requests) {
        yield {
          type: 'interaction',
          request: rebindInteractionRequest(request, {
            ...request.binding,
            runId: input.runId,
            executionId: input.runId,
            ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
          }),
        }
      }
      while (settled.size < requests.length && !input.signal.aborted) {
        await new Promise<void>((resolve) => {
          wake = resolve
          input.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      if (input.signal.aborted) return
      yield {
        type: 'final',
        status: 'completed',
        reason: 'terminal frame from the harness',
        text: 'turn-one-ok',
        metadata: { tokenUsage: { input: 1, output: 1 } },
        task: { id: input.runId, intent: 'concurrent interactions' },
        timestamp: NOW,
      }
    },
    respondInteraction: async (input) => {
      answers.set(input.command.response.id, structuredClone(input.command.response))
      settle(input.command.response.id)
      return { operationId: input.command.operationId, outcome: 'accepted' as const }
    },
  }
  return { execution, answers, settle }
}

function open(execution: ExecutionPort, journal: MemoryJournal): BraidApplication {
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(NOW),
    ids: new SequenceIds(),
    journal,
  })
  app.initialize('/workspace')
  return app
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for run state')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function startBoth(requests: readonly InteractionRequest[]) {
  const provider = concurrentProvider(requests)
  const journal = new MemoryJournal(new FixedClock(NOW))
  const app = open(provider.execution, journal)
  const receipt = app.send({ operationId: 'operation-send-concurrent', text: 'two tools' })
  await until(
    () => app.state().runs[0]?.interactions.filter((entry) => entry.status === 'pending').length === 2,
  )
  const runId = app.state().runs[0]?.id
  assert(runId)
  const respond = (id: string, outcome: InteractionResponse['outcome']) =>
    app.respondInteraction({
      operationId: `operation-respond-${id}`,
      runId,
      interactionId: id,
      response: { id, outcome } as InteractionResponse,
    })
  return { app, journal, provider, receipt, respond, runId }
}

const status = (app: BraidApplication, id: string) =>
  app.state().runs[0]?.interactions.find((entry) => entry.request.id === id)?.status

test('two open permission requests, one declined and one accepted, end completed', async () => {
  const { app, journal, provider, receipt, respond } = await startBoth([
    permission('perm-a'),
    permission('perm-b'),
  ])
  await respond('perm-a', 'declined')
  assert.equal(app.state().runs[0]?.status, 'streaming')
  await respond('perm-b', 'accepted')
  await receipt.completion
  assert.equal(app.state().runs[0]?.status, 'completed')
  assert.equal(status(app, 'perm-a'), 'declined')
  assert.equal(status(app, 'perm-b'), 'accepted')
  assert.equal(provider.answers.size, 2)

  // Restart: the journal alone reproduces the settled interactions and the terminal status.
  const restarted = open(
    { capabilities: () => DEFAULT_RUN_CAPABILITIES, async *streamTurn() {} },
    journal,
  )
  assert.equal(restarted.state().runs[0]?.status, 'completed')
  assert.equal(status(restarted, 'perm-a'), 'declined')
  assert.equal(status(restarted, 'perm-b'), 'accepted')
})

test('a cancelled request beside an accepted one ends completed', async () => {
  const { app, receipt, respond } = await startBoth([permission('perm-a'), permission('perm-b')])
  await respond('perm-b', 'accepted')
  await respond('perm-a', 'cancelled')
  await receipt.completion
  assert.equal(app.state().runs[0]?.status, 'completed')
  assert.equal(status(app, 'perm-a'), 'cancelled')
  assert.equal(status(app, 'perm-b'), 'accepted')
})

test('a timed-out request is refused before dispatch and does not fail the run', async () => {
  const { app, provider, receipt, respond } = await startBoth([
    permission('perm-a', 1),
    permission('perm-b'),
  ])
  await assert.rejects(
    respond('perm-a', 'accepted'),
    (error: unknown) => error instanceof AppError && error.code === 'INTERACTION_EXPIRED',
  )
  assert.equal(provider.answers.has('perm-a'), false)
  provider.settle('perm-a')
  await respond('perm-b', 'accepted')
  await receipt.completion
  assert.equal(app.state().runs[0]?.status, 'completed')
  assert.equal(status(app, 'perm-b'), 'accepted')
})

test('both requests accepted in either order end completed', async () => {
  for (const order of [
    ['perm-a', 'perm-b'],
    ['perm-b', 'perm-a'],
  ] as const) {
    const { app, receipt, respond } = await startBoth([permission('perm-a'), permission('perm-b')])
    for (const id of order) await respond(id, 'accepted')
    await receipt.completion
    assert.equal(app.state().runs[0]?.status, 'completed')
  }
})
