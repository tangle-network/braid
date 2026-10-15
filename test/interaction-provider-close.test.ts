import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { TuiMainScreen } from '@earendil-works/pi-tui'
import {
  type InteractionRequest,
  type InteractionResponse,
  permissionAnswerSpec,
} from '@tangle-network/agent-interface'
import {
  type ApplicationUiController,
  createApplicationUiController,
} from '../src/adapters/tui/application-ui-controller.js'
import type { BraidApplication } from '../src/app/application.js'
import { createBraidApplication, DETERMINISTIC_PROFILE } from '../src/app/composition.js'
import {
  createInteractionRequest,
  rebindInteractionRequest,
} from '../src/app/interaction-request.js'
import { MemoryJournal } from '../src/app/journal.js'
import { replayEvents } from '../src/domain/reducer.js'
import type { BraidRuntimeEvent, RuntimeEventEnvelope } from '../src/domain/runtime-events.js'
import { initialState } from '../src/domain/state.js'
import { FixedClock } from '../src/ports/clock.js'
import { DEFAULT_RUN_CAPABILITIES, type ExecutionPort } from '../src/ports/execution.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { interactionResponseRunCapabilities } from './support/run-capabilities.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

const NOW = '2026-10-15T00:00:00.000Z'
const ALT_2 = '\u001b2'
const DOWN = '\u001b[B'
const ESCAPE = '\u001b'
const SIZES = [
  [40, 12],
  [80, 24],
  [120, 40],
  [200, 60],
] as const
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'aborted', 'expired'])

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function binding(id: string) {
  return {
    runId: 'run-provider-close',
    provider: 'opencode',
    environmentId: 'environment-provider-close',
    sessionId: 'session-provider-close',
    executionId: 'run-provider-close',
    interactionId: id,
  }
}

/** The sidecar's opencode permission: a grant select plus optional feedback. */
function permissionForm(id: string, timeoutMs?: number): InteractionRequest {
  return createInteractionRequest({
    id,
    kind: 'permission',
    title: 'Permission: bash',
    answerSpec: permissionAnswerSpec({ responseScopes: ['interaction'] }),
    responseScopes: ['interaction'],
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    binding: binding(id),
  })
}

/** CLI Bridge's Pi permission: the grant select alone. */
function permissionSelect(id: string): InteractionRequest {
  return createInteractionRequest({
    id,
    kind: 'permission',
    title: 'Permission: bash',
    answerSpec: permissionAnswerSpec({ allowFeedback: false, responseScopes: ['interaction'] }),
    responseScopes: ['interaction'],
    binding: binding(id),
  })
}

function booleanQuestion(id: string): InteractionRequest {
  return createInteractionRequest({
    id,
    kind: 'question',
    title: 'Run the migration?',
    answerSpec: {
      fields: [{ type: 'boolean', name: 'continue', label: 'Continue', required: true }],
    },
    responseScopes: ['interaction'],
    binding: binding(id),
  })
}

function finalEvent(runId: string): BraidRuntimeEvent {
  return {
    type: 'final',
    task: { id: runId, intent: 'provider close' },
    status: 'completed',
    reason: 'completed',
    text: 'provider finished after the close',
    metadata: { tokenUsage: { input: 1, output: 1 } },
    timestamp: NOW,
  }
}

interface ClosingProviderOptions {
  readonly acknowledgement: 'accepted' | 'hang'
  /** Close the still-pending request instead of waiting for a recorded response. */
  readonly expireAfterMs?: number
}

/**
 * Behaves like the sidecar: after any delivered response it closes the request with
 * `interaction.cancel reason:"resolved"`, and only then finishes the run.
 */
function closingProvider(
  request: InteractionRequest,
  app: () => BraidApplication | undefined,
  options: ClosingProviderOptions,
) {
  const responses: InteractionResponse[] = []
  const recorded = () => {
    const status = app()?.state().runs.at(-1)?.interactions[0]?.status
    return status !== undefined && status !== 'pending' && status !== 'responding'
  }
  const execution: ExecutionPort = {
    capabilities: () => interactionResponseRunCapabilities(),
    async *streamTurn(input): AsyncIterable<BraidRuntimeEvent> {
      yield {
        type: 'interaction',
        request: rebindInteractionRequest(request, {
          ...request.binding,
          runId: input.runId,
          executionId: input.runId,
        }),
      }
      if (options.expireAfterMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.expireAfterMs))
        yield { type: 'interaction.cancel', id: request.id, reason: 'timeout' }
      } else {
        await waitUntil(() => recorded() || input.signal.aborted, 'a recorded response')
        if (input.signal.aborted) return
        yield { type: 'interaction.cancel', id: request.id, reason: 'resolved' }
      }
      yield finalEvent(input.runId)
    },
    respondInteraction: async (input) => {
      responses.push(input.command.response)
      if (options.acknowledgement === 'hang') {
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) resolve()
          else input.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        return {
          operationId: input.command.operationId,
          outcome: 'unknown' as const,
          detail: 'INTERACTION_RESPONSE_TIMEOUT',
        }
      }
      return { operationId: input.command.operationId, outcome: 'accepted' as const }
    },
  }
  return { execution, responses }
}

interface KeyboardFlow {
  readonly request: InteractionRequest
  readonly acknowledgement?: ClosingProviderOptions['acknowledgement']
  readonly expireAfterMs?: number
  readonly keys: (terminal: VirtualTerminal, controller: ApplicationUiController) => Promise<void>
}

async function runKeyboardFlow(flow: KeyboardFlow) {
  let app: BraidApplication | undefined
  const provider = closingProvider(flow.request, () => app, {
    acknowledgement: flow.acknowledgement ?? 'accepted',
    ...(flow.expireAfterMs === undefined ? {} : { expireAfterMs: flow.expireAfterMs }),
  })
  const created = createBraidApplication({
    fixture: 'deterministic',
    execution: provider.execution,
    interactionResponseTimeoutMs: 50,
  })
  app = created
  created.initialize('/workspace')
  const terminal = new VirtualTerminal(80, 24)
  const controller = createApplicationUiController(created)
  let operation = 0
  const view = new BraidTerminalApp({
    controller,
    tui: new TuiMainScreen(terminal),
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => `operation-provider-close-${++operation}`,
  })
  const done = view.start()
  try {
    terminal.sendInput('ask before running')
    terminal.sendInput('\r')
    await waitUntil(
      () => terminal.getViewport().join('\n').includes(flow.request.title),
      'the interaction panel',
    )
    await flow.keys(terminal, controller)
    await waitUntil(
      () => TERMINAL_RUN_STATUSES.has(created.state().runs[0]?.status ?? ''),
      'a terminal run',
    )
    await created.whenDurable()
    await terminal.waitForRender()
    const state = created.state()
    return {
      state,
      responses: provider.responses,
      storageFailure: created.storageFailure(),
      closes: created.events().filter((entry) => entry.event.kind === 'run.interaction.cancelled')
        .length,
      screen: terminal.getViewport().join('\n'),
    }
  } finally {
    view.stop()
    await done
    await created.close()
  }
}

function assertSettled(
  result: Awaited<ReturnType<typeof runKeyboardFlow>>,
  status: string,
  responses: readonly Omit<InteractionResponse, 'id'>[],
) {
  assert.equal(result.storageFailure, undefined)
  assert.equal(result.state.runs[0]?.status, 'completed')
  assert.equal(result.state.runs[0]?.interactions[0]?.status, status)
  assert.deepEqual(
    result.responses.map(({ id: _id, ...response }) => response),
    responses,
  )
  assert.equal(result.closes, 1)
  assert.doesNotMatch(result.screen, /storage failure/u)
}

test('alt+2 declines an opencode permission and the run finishes after the provider close', async () => {
  const result = await runKeyboardFlow({
    request: permissionForm('interaction-alt-2'),
    keys: async (terminal) => terminal.sendInput(ALT_2),
  })
  assertSettled(result, 'declined', [{ outcome: 'declined' }])
  assert.match(result.screen, /provider finished after the close/u)
})

test('n declines a yes-or-no question and the run finishes after the provider close', async () => {
  const result = await runKeyboardFlow({
    request: booleanQuestion('interaction-n'),
    keys: async (terminal) => terminal.sendInput('n'),
  })
  assertSettled(result, 'declined', [{ outcome: 'declined' }])
})

test('/reject declines the pending permission and the run finishes after the provider close', async () => {
  const result = await runKeyboardFlow({
    request: permissionForm('interaction-reject-command'),
    keys: async (_terminal, controller) => {
      const dispatched = await controller.dispatch({
        type: 'run-command',
        command: 'reject',
        operationId: 'operation-reject-command',
        args: [],
      })
      assert.equal(dispatched.kind, 'accepted')
    },
  })
  assertSettled(result, 'declined', [{ outcome: 'declined' }])
})

test('a form deny answer resolves the permission and the run finishes after the provider close', async () => {
  const result = await runKeyboardFlow({
    request: permissionForm('interaction-form-deny'),
    keys: async (terminal) => {
      terminal.sendInput('{"grant":["deny"]}')
      terminal.sendInput('\r')
    },
  })
  assertSettled(result, 'resolved', [{ outcome: 'accepted', data: { grant: ['deny'] } }])
})

test('choosing Deny in a permission select sends a deny grant, never allow_once', async () => {
  const result = await runKeyboardFlow({
    request: permissionSelect('interaction-select-deny'),
    keys: async (terminal) => {
      terminal.sendInput(DOWN)
      await terminal.waitForRender()
      terminal.sendInput('\r')
    },
  })
  assertSettled(result, 'resolved', [{ outcome: 'accepted', data: { grant: ['deny'] } }])
})

test('Escape cancels the permission and the run finishes after the provider close', async () => {
  const result = await runKeyboardFlow({
    request: permissionForm('interaction-escape'),
    keys: async (terminal) => terminal.sendInput(ESCAPE),
  })
  assertSettled(result, 'cancelled', [{ outcome: 'cancelled' }])
})

test('an acknowledgement timeout stays unknown through the provider close and the run finishes', async () => {
  const result = await runKeyboardFlow({
    request: permissionForm('interaction-ack-timeout'),
    acknowledgement: 'hang',
    keys: async (terminal) => terminal.sendInput(ALT_2),
  })
  assertSettled(result, 'unknown', [{ outcome: 'declined' }])
  assert.equal(
    result.state.runs[0]?.interactions[0]?.responseOperation?.requestedOutcome,
    'declined',
  )
})

test('a request that times out at the provider is cancelled and the run finishes', async () => {
  const result = await runKeyboardFlow({
    request: permissionForm('interaction-request-timeout', 60_000),
    expireAfterMs: 50,
    keys: async () => {},
  })
  assertSettled(result, 'cancelled', [])
})

test('restart and reconnect replay a provider close after a decline without a storage failure', async () => {
  const capabilities = {
    ...interactionResponseRunCapabilities(),
    streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
    sessions: { continue: true, messages: true },
    controls: { ...DEFAULT_RUN_CAPABILITIES.controls, status: true, recreate: true },
    events: { stableIdentity: true, sequence: true, cursor: true },
  }
  const request = permissionForm('interaction-restart-close')
  const envelopes = (runId: string): readonly RuntimeEventEnvelope[] => [
    {
      runId,
      eventId: 'provider-interaction',
      sequence: 1,
      cursor: 'cursor-1',
      receivedAt: NOW,
      event: {
        type: 'interaction',
        request: rebindInteractionRequest(request, {
          ...request.binding,
          runId,
          executionId: runId,
        }),
      },
    },
    {
      runId,
      eventId: 'provider-close',
      sequence: 2,
      cursor: 'cursor-2',
      receivedAt: NOW,
      event: { type: 'interaction.cancel', id: request.id, reason: 'resolved' },
    },
  ]
  const journal = new MemoryJournal(new FixedClock(NOW))
  let first: BraidApplication | undefined
  let closeDelivered = false
  let releaseFirst: (() => void) | undefined
  const firstApp = createBraidApplication({
    fixture: 'deterministic',
    journal,
    execution: {
      capabilities: () => capabilities,
      async *streamTurn(input): AsyncIterable<RuntimeEventEnvelope> {
        const [interaction, close] = envelopes(input.runId)
        if (interaction === undefined || close === undefined) return
        yield interaction
        await waitUntil(
          () => first?.state().runs[0]?.interactions[0]?.status === 'declined',
          'the recorded decline',
        )
        yield close
        closeDelivered = true
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
          if (input.signal.aborted) resolve()
          else input.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
      respondInteraction: async (input) => ({
        operationId: input.command.operationId,
        outcome: 'accepted' as const,
      }),
    },
  })
  first = firstApp
  firstApp.initialize('/workspace')
  const send = firstApp.send({ operationId: 'operation-send-restart-close', text: 'ask' })
  await waitUntil(
    () => firstApp.state().runs[0]?.interactions[0]?.status === 'pending',
    'the pending permission',
  )
  const pending = firstApp.state().runs[0]?.interactions[0]
  assert(pending)
  const declined = await firstApp.respondInteraction({
    operationId: 'operation-restart-decline',
    runId: send.runId,
    interactionId: pending.request.id,
    response: { id: pending.request.id, outcome: 'declined' },
  })
  await declined.completion
  await waitUntil(() => closeDelivered, 'the provider close')
  await firstApp.whenDurable()
  assert.equal(firstApp.storageFailure(), undefined)
  assert.equal(firstApp.state().runs[0]?.lastProviderSequence, 2)

  const restartedJournal = new MemoryJournal(new FixedClock(NOW))
  for (const entry of journal.all()) restartedJournal.append(entry)
  let reconnects = 0
  const restarted = createBraidApplication({
    fixture: 'deterministic',
    journal: restartedJournal,
    execution: {
      capabilities: () => capabilities,
      async *streamTurn(): AsyncIterable<BraidRuntimeEvent> {},
      async status(input) {
        return {
          runId: input.runId,
          status: 'unknown',
          detail: 'The retained execution has not produced an attributable status yet',
        }
      },
      reconnect: (input) => ({
        async *[Symbol.asyncIterator](): AsyncIterator<RuntimeEventEnvelope> {
          reconnects += 1
          yield* envelopes(input.runId)
          yield {
            runId: input.runId,
            eventId: 'provider-final',
            sequence: 3,
            cursor: 'cursor-3',
            receivedAt: NOW,
            event: finalEvent(input.runId),
          }
        },
      }),
    },
  })
  try {
    restarted.initialize('/workspace')
    await restarted.whenDurable()
    assert.equal(restarted.state().runs[0]?.interactions[0]?.status, 'declined')
    const recovered = await restarted.reconnectRun({
      operationId: 'operation-restart-reconnect',
      runId: send.runId,
    })
    assert.equal(reconnects, 1)
    assert.equal(restarted.storageFailure(), undefined)
    assert.equal(recovered.runs[0]?.status, 'completed')
    assert.equal(recovered.runs[0]?.interactions[0]?.status, 'declined')
    assert.equal(
      restarted.events().filter((entry) => entry.event.kind === 'run.interaction.cancelled')
        .length,
      1,
    )
  } finally {
    releaseFirst?.()
    await send.completion.catch(() => undefined)
    await firstApp.close()
    await restarted.close()
  }
})

for (const [columns, rows] of SIZES) {
  test(`a refused event renders the storage-failure frame at ${columns}x${rows}`, async () => {
    const request = permissionForm(`interaction-invariant-${columns}`)
    const conflicting = createInteractionRequest({
      id: request.id,
      kind: 'permission',
      title: 'Permission: a different command',
      answerSpec: permissionAnswerSpec({ responseScopes: ['interaction'] }),
      responseScopes: ['interaction'],
      binding: request.binding,
    })
    const journal = new MemoryJournal(new FixedClock(NOW))
    const event = (runId: string, eventId: string, sequence: number, value: InteractionRequest) =>
      ({
        runId,
        eventId,
        sequence,
        receivedAt: NOW,
        event: {
          type: 'interaction',
          request: rebindInteractionRequest(value, {
            ...value.binding,
            runId,
            executionId: runId,
          }),
        },
      }) satisfies RuntimeEventEnvelope
    const app = createBraidApplication({
      fixture: 'deterministic',
      journal,
      execution: {
        capabilities: () => interactionResponseRunCapabilities(),
        async *streamTurn(input): AsyncIterable<RuntimeEventEnvelope> {
          yield event(input.runId, 'provider-request', 1, request)
          yield event(input.runId, 'provider-conflicting-request', 2, conflicting)
        },
      },
    })
    app.initialize('/workspace')
    const terminal = new VirtualTerminal(columns, rows)
    const view = new BraidTerminalApp({
      controller: createApplicationUiController(app),
      tui: new TuiMainScreen(terminal),
      theme: createBraidTheme(false),
      workspace: '/workspace',
      nextOperationId: () => `operation-storage-failure-${columns}`,
    })
    const done = view.start()
    try {
      terminal.sendInput('ask twice')
      terminal.sendInput('\r')
      await waitUntil(() => app.storageFailure() !== undefined, 'the latched failure')
      await waitUntil(
        () => terminal.getViewport().join('\n').includes('storage failure'),
        'the storage-failure frame',
      )
      const frame = terminal.getViewport().join('\n')
      assert.match(app.storageFailure() ?? '', /was requested with different data/u)
      // The reducer refuses the event before the journal append, so no stored journal holds it.
      assert.equal(
        journal.all().filter((entry) => entry.event.kind === 'run.interaction').length,
        1,
      )
      // Replaying the stored journal reproduces the last committed state; nothing needs migration.
      const replayed = replayEvents(initialState(DETERMINISTIC_PROFILE), journal.all())
      assert.deepEqual(replayed.runs, app.state().runs)
      assert.equal(replayed.runs[0]?.interactions[0]?.request.title, 'Permission: bash')
      const captureRoot = process.env.BRAID_INTERACTION_CAPTURE_ROOT
      if (captureRoot) {
        await mkdir(captureRoot, { recursive: true })
        await writeFile(
          join(captureRoot, `${columns}x${rows}-storage-failure.txt`),
          `${frame.replace(/[ \t]+$/gmu, '')}\n`,
        )
      }
    } finally {
      view.stop()
      await done
      await app.close().catch(() => undefined)
    }
  })
}
