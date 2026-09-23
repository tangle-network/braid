import assert from 'node:assert/strict'
import test from 'node:test'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import type { StatusPort } from '../src/app/application-ports.js'
import type { RunAdmissionReceipt } from '../src/domain/receipts.js'
import { createBraidApplication } from '../src/app/composition.js'
import { createRunLedger } from '../src/app/run-ledger.js'
import { isTerminal, waitForIdle } from '../src/app/run-status.js'
import type { RuntimeEventEnvelope } from '../src/domain/runtime-events.js'
import { isLiveRunStatus } from '../src/domain/state.js'
import { DEFAULT_RUN_CAPABILITIES, type ExecutionPort } from '../src/ports/execution.js'
import { TuiMainScreen } from '../src/startup/terminal-runtime.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

const RETAINED_CAPABILITIES = {
  ...DEFAULT_RUN_CAPABILITIES,
  streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
  sessions: { continue: true, messages: true },
  controls: { cancel: true, steer: false, queue: false, status: true, recreate: true },
  events: { stableIdentity: true, sequence: true, cursor: true },
} as const

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for terminal state')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function observed(runId: string, sequence: number): RuntimeEventEnvelope {
  return {
    runId,
    eventId: `observed-${String(sequence)}`,
    sequence,
    cursor: `cursor-${String(sequence)}`,
    receivedAt: '2026-08-01T00:00:00.000Z',
    event: { type: 'text_delta', text: 'remote agent is working' } as RuntimeStreamEvent,
  }
}

/** A retained provider whose remote run never finishes and whose detach ends the local view. */
function retainedExecution(): ExecutionPort & { readonly statusCalls: () => number } {
  const detachWaiters = new Map<string, () => void>()
  let statusCalls = 0
  const untilDetached = (runId: string, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
      detachWaiters.set(runId, resolve)
      signal?.addEventListener('abort', () => resolve(), { once: true })
    })
  return {
    capabilities: () => RETAINED_CAPABILITIES,
    admit: () => ({ capabilities: RETAINED_CAPABILITIES, providerSessionId: 'session-retained' }),
    async *streamTurn(input): AsyncIterable<RuntimeEventEnvelope> {
      yield observed(input.runId, 1)
      await untilDetached(input.runId, input.signal)
    },
    reconnect: (input) => ({
      async *[Symbol.asyncIterator](): AsyncIterator<RuntimeEventEnvelope> {
        await untilDetached(input.runId, input.signal)
        yield* []
      },
    }),
    detachRun: async (input) => {
      detachWaiters.get(input.runId)?.()
      return { operationId: input.operationId, outcome: 'accepted' }
    },
    status: async (input) => {
      statusCalls += 1
      return { runId: input.runId, sessionId: 'session-retained', status: 'detached' }
    },
    statusCalls: () => statusCalls,
  }
}

async function detachedRetainedApp(): Promise<{
  readonly app: ReturnType<typeof createBraidApplication>
  readonly execution: ReturnType<typeof retainedExecution>
  readonly runId: string
}> {
  const execution = retainedExecution()
  const app = createBraidApplication({ fixture: 'deterministic', execution })
  app.initialize('/workspace')
  const send = app.send({ operationId: 'op-retained', text: 'keep working remotely' })
  await send.admissionReady
  await waitUntil(() => app.state().runs[0]?.status === 'streaming')
  // The live proof detaches the native terminal, attaches it again, and detaches it again.
  await (await app.detachRun({ operationId: 'op-detach-1', runId: send.runId })).completion
  const reconnect = app.reconnectRun({ operationId: 'op-attach', runId: send.runId })
  await waitUntil(() => app.state().runs[0]?.status === 'reconnecting')
  await (await app.detachRun({ operationId: 'op-detach-2', runId: send.runId })).completion
  await reconnect
  assert.equal(app.state().runs[0]?.status, 'detached')
  assert.equal(app.state().activeRunId, send.runId)
  return { app, execution, runId: send.runId }
}

test('waiting for idle returns for a detached retained run instead of spinning', async () => {
  const { app, runId } = await detachedRetainedApp()
  const state = app.state()
  const ledger = createRunLedger()
  ledger.setOperation({
    digest: 'send',
    runId,
    admission: { operationId: 'op-retained' } as unknown as RunAdmissionReceipt,
    completion: Promise.resolve(),
  })
  ledger.setControl('op-detach-2', {
    digest: 'detach',
    runId,
    control: 'detach',
    completion: Promise.resolve(state),
    acknowledgement: Promise.resolve({ operationId: 'op-detach-2', outcome: 'accepted' }),
  })
  let reads = 0
  const context = {
    // A settled wait loop never yields to timers, so a read budget is the only reliable guard.
    currentState: () => {
      reads += 1
      if (reads > 100) throw new Error('waitForIdle kept polling a detached run')
      return state
    },
    ledger,
    isTerminal,
    nextStateChange: () => new Promise<void>(() => undefined),
  } as unknown as StatusPort
  const idle = await waitForIdle(context)
  assert.equal(idle.runs[0]?.status, 'detached')
  assert.ok(reads <= 3, `waitForIdle read state ${String(reads)} times`)
  await app.close()
})

test('waiting for idle holds a live run whose local operation settled until it turns terminal', async () => {
  let statusCalls = 0
  const execution: ExecutionPort = {
    capabilities: () => RETAINED_CAPABILITIES,
    admit: () => ({ capabilities: RETAINED_CAPABILITIES, providerSessionId: 'session-retained' }),
    // The stream disconnects without a terminal event; the provider still reports the run live.
    async *streamTurn(input): AsyncIterable<RuntimeEventEnvelope> {
      yield observed(input.runId, 1)
    },
    reconnect: () => ({
      async *[Symbol.asyncIterator](): AsyncIterator<RuntimeEventEnvelope> {
        yield* []
      },
    }),
    status: async (input) => {
      statusCalls += 1
      return { runId: input.runId, sessionId: 'session-retained', status: 'running' }
    },
  }
  const app = createBraidApplication({ fixture: 'deterministic', execution })
  app.initialize('/workspace')
  const send = app.send({ operationId: 'op-provider-live', text: 'keep working remotely' })
  await send.completion
  const run = app.state().runs[0]
  assert.ok(statusCalls > 0)
  assert.ok(run !== undefined && isLiveRunStatus(run.status), `run status ${String(run?.status)}`)

  let idle = false
  const waiting = app.waitForIdle().then((state) => {
    idle = true
    return state
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(idle, false, 'waitForIdle returned while the provider still reports the run live')

  app.ingestRuntimeEvent({
    runId: send.runId,
    eventId: 'provider-final',
    sequence: 2,
    cursor: 'cursor-2',
    receivedAt: '2026-08-01T00:00:01.000Z',
    event: {
      type: 'final',
      status: 'completed',
      reason: 'complete',
      text: 'done remotely',
      task: { id: 'task-test', intent: 'test' },
      timestamp: '2026-08-01T00:00:01.000Z',
    } as RuntimeStreamEvent,
  })
  const settled = await waiting
  assert.equal(settled.runs[0]?.status, 'completed')
  await app.close()
})

test('Ctrl+C twice exits promptly after a retained run is detached, attached, and detached', async () => {
  const { app, execution } = await detachedRetainedApp()
  const terminal = new VirtualTerminal(80, 24)
  let operation = 0
  const view = new BraidTerminalApp({
    controller: createApplicationUiController(app),
    tui: new TuiMainScreen(terminal),
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => `op-detached-exit-${++operation}`,
  })
  const done = view.start()
  await terminal.waitForRender()
  const screen = terminal.getViewport().join('\n')
  assert.match(screen, /working/u)
  assert.match(screen, /input unavailable/u)
  terminal.sendInput('\u0003')
  await terminal.waitForRender()
  assert.match(terminal.getViewport().join('\n'), /Ctrl\+C again to quit/u)

  const started = performance.now()
  terminal.sendInput('\u0003')
  // Mirrors runInterface and runBraid: the view resolves, then the process waits for idle and close.
  await done
  await app.waitForIdle()
  await app.close()
  const exitMs = performance.now() - started
  assert.ok(exitMs < 2_000, `Braid exit took ${exitMs.toFixed(0)} ms`)
  assert.equal(app.state().runs[0]?.status, 'detached')
  assert.equal(execution.statusCalls(), 1)
})
