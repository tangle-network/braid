import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TuiMainScreen } from '@earendil-works/pi-tui'
import {
  type InteractionRequest,
  type InteractionResponse,
  permissionAnswerSpec,
} from '@tangle-network/agent-interface'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import {
  type ApplicationUiController,
  createApplicationUiController,
} from '../src/adapters/tui/application-ui-controller.js'
import type { BraidApplication } from '../src/app/application.js'
import {
  createBraidApplication,
  createDurableBraidApplication,
  DETERMINISTIC_PROFILE,
} from '../src/app/composition.js'
import {
  createInteractionRequest,
  rebindInteractionRequest,
} from '../src/app/interaction-request.js'
import { MemoryJournal } from '../src/app/journal.js'
import type { BraidRuntimeEvent, RuntimeEventEnvelope } from '../src/domain/runtime-events.js'
import { FixedClock } from '../src/ports/clock.js'
import { DEFAULT_RUN_CAPABILITIES, type ExecutionPort } from '../src/ports/execution.js'
import { SequenceIds } from '../src/ports/ids.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { interactionResponseRunCapabilities } from './support/run-capabilities.js'
import { RecordingTerminal } from './support/recording-terminal.js'
import type { VirtualTerminal } from './support/virtual-terminal.js'

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

/** Writes the final frame and recording when the capture script asks for evidence. */
async function writeCapture(terminal: RecordingTerminal, name: string, title: string) {
  const root = process.env.BRAID_INTERACTION_CAPTURE_ROOT
  if (!root) return
  await mkdir(root, { recursive: true })
  const frame = terminal.getViewport().join('\n')
  await writeFile(join(root, `${name}.txt`), `${frame.replace(/[ \t]+$/gmu, '')}\n`)
  await writeFile(join(root, `${name}.cast`), terminal.cast(title))
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
  readonly size?: readonly [columns: number, rows: number]
  readonly capture?: { readonly name: string; readonly title: string }
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
  const [columns, rows] = flow.size ?? [80, 24]
  const terminal = new RecordingTerminal(columns, rows)
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
    if (flow.capture !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 300))
      await writeCapture(terminal, flow.capture.name, flow.capture.title)
    }
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
  assert.doesNotMatch(result.screen, /storage error/u)
}

for (const [columns, rows] of SIZES) {
  test(`alt+2 declines an opencode permission and the run finishes at ${columns}x${rows}`, async () => {
    const result = await runKeyboardFlow({
      request: permissionForm(`interaction-alt-2-${columns}`),
      size: [columns, rows],
      capture: {
        name: `${columns}x${rows}-decline-alt-2`,
        title: 'Decline a permission with alt+2; the provider closes it and the run completes',
      },
      keys: async (terminal) => {
        await new Promise((resolve) => setTimeout(resolve, 300))
        terminal.sendInput(ALT_2)
      },
    })
    assertSettled(result, 'declined', [{ outcome: 'declined' }])
    assert.match(result.screen, /provider finished/u)
  })
}

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
      restarted.events().filter((entry) => entry.event.kind === 'run.interaction.cancelled').length,
      1,
    )
  } finally {
    releaseFirst?.()
    await send.completion.catch(() => undefined)
    await firstApp.close()
    await restarted.close()
  }
})

/** Closes a request it never made, which the reducer refuses, then sends nothing else. */
function refusedEventProvider(held: Promise<void>): ExecutionPort {
  return {
    capabilities: () => interactionResponseRunCapabilities(),
    async *streamTurn(): AsyncIterable<BraidRuntimeEvent> {
      yield { type: 'text_delta', text: 'Checking the workspace before running bash.' }
      yield { type: 'interaction.cancel', id: 'interaction-never-requested', reason: 'resolved' }
      // Nothing else repaints the frame: only the latch notification can show the failure.
      await held
    },
  }
}

test('a refused provider event never reaches the encrypted journal, so reopening needs no migration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-refused-event-'))
  const workspace = join(root, 'workspace')
  const path = join(root, 'braid.sqlite')
  const keyPath = join(root, 'database.key')
  const credentialStore = new MemoryCredentialStore()
  try {
    await mkdir(workspace)
    await writeFile(keyPath, randomBytes(32), { mode: 0o600 })
    const databaseKeySource = { type: 'file' as const, path: keyPath, workspaceRoot: workspace }
    const open = (execution: ExecutionPort) =>
      createDurableBraidApplication({
        path,
        storageRoot: root,
        workspaceRoot: workspace,
        databaseKeySource,
        credentialStore,
        profile: DETERMINISTIC_PROFILE,
        ids: new SequenceIds(),
        execution,
      })
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = await open(refusedEventProvider(held))
    try {
      first.app.initialize(workspace)
      await first.app.whenDurable()
      const send = first.app.send({ operationId: 'operation-refused-event', text: 'ask' })
      await waitUntil(() => first.app.storageFailure() !== undefined, 'the latched failure')
      assert.match(
        first.app.storageFailure() ?? '',
        /Interaction interaction-[0-9a-f]+ is unknown/u,
      )
      release()
      await Promise.race([
        send.completion.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ])
    } finally {
      release()
      await first.storage.close()
    }

    const reopened = await open({ async *streamTurn(): AsyncIterable<BraidRuntimeEvent> {} })
    try {
      await reopened.app.whenDurable()
      const kinds = (await reopened.storage.events()).map((entry) => entry.kind)
      assert.equal(reopened.app.storageFailure(), undefined)
      assert.ok(kinds.includes('run.text.delta'), kinds.join(', '))
      assert.equal(kinds.includes('run.interaction.cancelled'), false, kinds.join(', '))
    } finally {
      await reopened.storage.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const [columns, rows] of SIZES) {
  test(`a refused event renders the storage-failure frame at ${columns}x${rows}`, async () => {
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const app = createBraidApplication({
      fixture: 'deterministic',
      execution: refusedEventProvider(held),
    })
    app.initialize('/workspace')
    const terminal = new RecordingTerminal(columns, rows)
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
        () => terminal.getViewport().join('\n').includes('storage error'),
        'the storage-failure frame',
      )
      const frame = terminal.getViewport().join('\n')
      assert.match(app.storageFailure() ?? '', /Interaction interaction-[0-9a-f]+ is unknown/u)
      assert.match(frame, /storage error/u)
      await writeCapture(
        terminal,
        `${columns}x${rows}-storage-failure`,
        'A refused provider event latches Braid read-only and shows the storage failure',
      )
    } finally {
      release()
      view.stop()
      await done
      await app.close().catch(() => undefined)
    }
  })
}

/**
 * LIVE-07 multirun at 48da449: run A's opencode permission opened while branch B's prompt was being
 * typed in a second conversation, took the rest of that prompt, and expired. The next permission's
 * typed answer closed its form but never reached the provider, so run A waited it out too.
 */
async function backgroundPermissionFlow(
  open: (execution: ExecutionPort) => Promise<{ app: BraidApplication; workspace: string }>,
) {
  let app: BraidApplication | undefined
  const first = permissionForm('interaction-background-first')
  const second = permissionForm('interaction-background-second')
  let raiseFirst = () => {}
  const firstRaised = new Promise<void>((resolve) => {
    raiseFirst = resolve
  })
  // Braid rebinds each request to its own interaction id, so the requests are found by arrival order.
  const status = (index: number) => app?.state().runs[0]?.interactions[index]?.status
  const responses: InteractionResponse[] = []
  const bound = (request: InteractionRequest, runId: string) =>
    rebindInteractionRequest(request, { ...request.binding, runId, executionId: runId })
  const execution: ExecutionPort = {
    capabilities: () => interactionResponseRunCapabilities(),
    async *streamTurn(input): AsyncIterable<BraidRuntimeEvent> {
      await firstRaised
      yield { type: 'interaction', request: bound(first, input.runId) }
      await new Promise((resolve) => setTimeout(resolve, 300))
      yield { type: 'interaction.cancel', id: first.id, reason: 'timeout' }
      yield { type: 'interaction', request: bound(second, input.runId) }
      await waitUntil(
        () => !['pending', 'responding', undefined].includes(status(1)) || input.signal.aborted,
        'a recorded response to the second permission',
        5_000,
      )
      if (input.signal.aborted) return
      yield { type: 'interaction.cancel', id: second.id, reason: 'resolved' }
      yield finalEvent(input.runId)
    },
    respondInteraction: async (input) => {
      responses.push(input.command.response)
      return { operationId: input.command.operationId, outcome: 'accepted' as const }
    },
  }
  const opened = await open(execution)
  const created = opened.app
  app = created
  created.initialize(opened.workspace)
  await created.whenDurable()
  const terminal = new RecordingTerminal(120, 40)
  let operation = 0
  const view = new BraidTerminalApp({
    controller: createApplicationUiController(created),
    tui: new TuiMainScreen(terminal),
    theme: createBraidTheme(false),
    workspace: opened.workspace,
    nextOperationId: () => `operation-background-permission-${++operation}`,
  })
  const done = view.start()
  try {
    terminal.sendInput('branch A prompt')
    terminal.sendInput('\r')
    await waitUntil(() => created.state().runs.length === 1, 'run A', 10_000)
    terminal.sendInput('/new Second conversation')
    terminal.sendInput('\r')
    await waitUntil(() => created.state().conversations.length === 2, 'conversation B')
    const prompt = 'Use the current working directory. Write exactly MARKER_B to marker.txt.'
    terminal.sendInput(prompt.slice(0, 30))
    await terminal.waitForRender()
    raiseFirst()
    await waitUntil(() => status(0) === 'pending', 'the first permission')
    await waitUntil(
      () => terminal.getViewport().join('\n').includes(first.title),
      'the first permission form',
    )
    // The rest of branch B's prompt and its Enter land in the open form, as they did live.
    terminal.sendInput(prompt.slice(30))
    terminal.sendInput('\r')
    await waitUntil(() => status(1) === 'pending', 'the second permission')
    await waitUntil(
      () => terminal.getViewport().join('\n').includes(second.title),
      'the second permission form',
    )
    await terminal.waitForRender()
    terminal.sendInput('{"grant":["allow_once"]}')
    terminal.sendInput('\r')
    await waitUntil(() => responses.length === 1, 'the typed answer at the provider', 5_000)
    assert.deepEqual(
      responses.map(({ id: _id, ...response }) => response),
      [{ outcome: 'accepted', data: { grant: ['allow_once'] } }],
    )
    await waitUntil(
      () => TERMINAL_RUN_STATUSES.has(created.state().runs[0]?.status ?? ''),
      'a terminal run',
    )
    assert.equal(created.state().runs[0]?.status, 'completed')
    assert.equal(created.storageFailure(), undefined)
  } finally {
    raiseFirst()
    view.stop()
    await done
    await created.close()
  }
}

test('a background run permission answered through its typed form reaches the provider', async () => {
  await backgroundPermissionFlow(async (execution) => ({
    app: createBraidApplication({ fixture: 'deterministic', execution }),
    workspace: '/workspace',
  }))
})

test('a background run permission answer reaches the provider through the durable journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-background-permission-'))
  const workspace = join(root, 'workspace')
  const keyPath = join(root, 'database.key')
  try {
    await mkdir(workspace)
    await writeFile(keyPath, randomBytes(32), { mode: 0o600 })
    await backgroundPermissionFlow(async (execution) => ({
      app: (
        await createDurableBraidApplication({
          path: join(root, 'braid.sqlite'),
          storageRoot: root,
          workspaceRoot: workspace,
          databaseKeySource: { type: 'file' as const, path: keyPath, workspaceRoot: workspace },
          credentialStore: new MemoryCredentialStore(),
          profile: DETERMINISTIC_PROFILE,
          ids: new SequenceIds(),
          execution,
        })
      ).app,
      workspace,
    }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
