import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  AgentInteractiveSessionControlClaimRequest,
  AgentInteractiveSessionRef,
  AgentInteractiveTerminalSession,
  TerminalDetachAck,
} from '@tangle-network/agent-interface'
import {
  agentExecutionPreparationReceiptSchema,
  canonicalCandidateDigest,
} from '@tangle-network/agent-interface'
import type { RetainedInteractiveRunHandle } from '@tangle-network/agent-runtime/kernel'
import type { BraidApplication } from '../src/app/application.js'
import { createNativeInteractiveUiActions } from '../src/bin/native-interactive-actions.js'
import type { NativeTerminalHost, NativeTerminalSignalPort } from '../src/index.js'
import type { NativeInteractiveExecutionControl } from '../src/ports/native-interactive-execution.js'

class ExitTerminalSession implements AgentInteractiveTerminalSession {
  readonly ref = {
    terminalSessionId: 'terminal-native-actions',
    parentExecutionId: 'execution-native-actions',
    name: 'native actions',
    shell: '/bin/sh',
    cwd: '/workspace',
    cols: 100,
    rows: 30,
    createdAt: '2026-08-16T00:00:00.000Z',
    lastActivityAt: '2026-08-16T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    isRunning: true,
    attachCount: 1,
  }
  readonly cursors = { earliest: 0, latest: 1 }
  readonly control = {
    refDigest: `sha256:${'1'.repeat(64)}` as const,
    generation: 1,
    leaseId: 'lease-native-actions',
    holderId: 'braid-native-actions',
    expiresAt: '2099-01-01T00:00:00.000Z',
  }

  input(): Promise<void> {
    return Promise.resolve()
  }

  resize(): Promise<void> {
    return Promise.resolve()
  }

  detach(): Promise<TerminalDetachAck> {
    return Promise.resolve({
      status: 'detached',
      terminalSessionId: this.ref.terminalSessionId,
    })
  }

  close(): Promise<TerminalDetachAck> {
    return Promise.resolve({ status: 'closed', terminalSessionId: this.ref.terminalSessionId })
  }

  async *events(): AsyncIterable<{ readonly type: 'exit'; readonly exitCode: number }> {
    yield { type: 'exit', exitCode: 0 }
  }
}

class TestTerminal implements NativeTerminalHost {
  readonly columns = 100
  readonly rows = 30
  starts = 0
  stops = 0

  start(): void {
    this.starts += 1
  }

  stop(): void {
    this.stops += 1
  }

  write(): void {}
}

const signals: NativeTerminalSignalPort = {
  takeOver: () => () => {},
}

const preparationMaterial = {
  kind: 'agent-execution-preparation' as const,
  schemaVersion: 1 as const,
  preparationId: 'preparation-native-actions',
  requestDigest: `sha256:${'1'.repeat(64)}` as const,
  authoredProfileDigest: `sha256:${'2'.repeat(64)}` as const,
  effectiveProfileDigest: `sha256:${'2'.repeat(64)}` as const,
  backend: 'test-backend',
  harness: 'pi' as const,
  harnessVersion: 'test-harness-1',
  resolvedModel: { requested: 'test/model', resolved: 'test/model' },
  workspace: {
    leaseId: 'workspace-lease-native-actions',
    provider: 'test-provider',
    identityDigest: `sha256:${'3'.repeat(64)}` as const,
    isolation: 'per-run' as const,
    sourceSnapshotDigest: `sha256:${'4'.repeat(64)}` as const,
    sourceSnapshotPolicy: {
      kind: 'provider-declared' as const,
      name: 'test-snapshot',
      version: 1,
      digest: `sha256:${'5'.repeat(64)}` as const,
    },
    preparedWorkspaceDigest: `sha256:${'6'.repeat(64)}` as const,
    profileActivationDigest: `sha256:${'7'.repeat(64)}` as const,
  },
  axisResults: [],
  executionPlanDigest: `sha256:${'8'.repeat(64)}` as const,
  materializer: { name: 'test-materializer', version: '1' },
  expiresAtMs: 4_102_444_800_000,
}

const interactiveRef: AgentInteractiveSessionRef = {
  run: {
    provider: 'test-provider',
    environmentId: 'environment-native-actions',
    sessionId: 'session-native-actions',
    executionId: 'execution-native-actions',
    runId: 'provider-run-native-actions',
    requestDigest: preparationMaterial.requestDigest,
  },
  preparationReceipt: agentExecutionPreparationReceiptSchema.parse({
    ...preparationMaterial,
    digest: canonicalCandidateDigest(preparationMaterial),
  }),
  incarnationId: 'incarnation-native-actions',
  startedAt: '2026-08-16T00:00:00.000Z',
}

function retainedHandle(
  terminalSession: AgentInteractiveTerminalSession,
  attached: AgentInteractiveSessionControlClaimRequest[],
): RetainedInteractiveRunHandle {
  const ref = interactiveRef
  return {
    ref,
    capabilities: {} as RetainedInteractiveRunHandle['capabilities'],
    claimControl: async (request) => ({
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      ref,
      status: 'accepted',
      control: {
        refDigest: canonicalCandidateDigest(ref),
        generation: 1,
        leaseId: 'lease-native-actions',
        holderId: request.holderId,
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    }),
    status: async () => ({ state: 'running', ref }),
    attach: async (request) => {
      attached.push({
        operationId: 'attach-observation',
        requestDigest: `sha256:${'2'.repeat(64)}`,
        ref,
        holderId: request.control.holderId,
        expectedGeneration: request.control.generation,
      })
      return terminalSession
    },
    sendPrompt: async () => {
      throw new Error('not used')
    },
    stop: async () => {
      throw new Error('not used')
    },
  }
}

test('starts one Runtime-owned native run and returns to Braid after remote exit', async () => {
  const terminal = new TestTerminal()
  const attached: AgentInteractiveSessionControlClaimRequest[] = []
  const handle = retainedHandle(new ExitTerminalSession(), attached)
  const sends: Array<{ readonly text: string; readonly mode?: string }> = []
  const settlements: unknown[] = []
  let settleCompletion: () => void = () => {}
  const completion = new Promise<void>((resolve) => {
    settleCompletion = resolve
  })
  const app = {
    state: () => ({ activeRunId: null, runs: [] }),
    send: (input: { readonly text: string; readonly mode?: string }) => {
      sends.push(input)
      return { runId: 'run-native-actions', completion }
    },
    reconnectRun: async () => ({}),
    detachRun: async () => {
      throw new Error('remote exit must not detach')
    },
  } as unknown as Pick<BraidApplication, 'detachRun' | 'reconnectRun' | 'send' | 'state'>
  const execution: NativeInteractiveExecutionControl = {
    waitForHandle: async () => handle,
    settle: (_runId, outcome) => {
      settlements.push(outcome)
      settleCompletion()
    },
  }
  let suspends = 0
  let resumes = 0
  let operation = 0
  const actions = createNativeInteractiveUiActions({
    current: () => ({ app, nativeInteractive: execution }),
    terminal,
    signals: () => signals,
    suspend: () => {
      suspends += 1
    },
    resume: () => {
      resumes += 1
    },
    nextOperationId: () => `operation-${++operation}`,
    holderId: 'braid-native-actions',
  })

  const result = await actions.run({ action: 'start', initialPrompt: 'inspect the failing tests' })

  assert.deepEqual(result, { kind: 'returned', runId: 'run-native-actions', outcome: 'exited' })
  assert.deepEqual(sends, [
    { operationId: 'operation-1', text: 'inspect the failing tests', mode: 'interactive' },
  ])
  assert.deepEqual(settlements, [{ kind: 'exited', exitCode: 0 }])
  assert.equal(attached[0]?.holderId, 'braid-native-actions')
  assert.equal(attached[0]?.expectedGeneration, 1)
  assert.equal(terminal.starts, 1)
  assert.equal(terminal.stops, 1)
  assert.equal(suspends, 1)
  assert.equal(resumes, 1)
})

test('requires a prompt and explains unavailable native providers', async () => {
  const app = {
    state: () => ({ activeRunId: null, runs: [] }),
  } as unknown as Pick<BraidApplication, 'detachRun' | 'reconnectRun' | 'send' | 'state'>
  const actions = createNativeInteractiveUiActions({
    current: () => ({ app }),
    terminal: new TestTerminal(),
    signals: () => signals,
    suspend: () => {},
    resume: () => {},
    nextOperationId: () => 'operation-unused',
    holderId: 'braid-native-actions',
  })

  assert.deepEqual(actions.availability('start'), {
    available: false,
    reason: 'Select a retained Tangle Sandbox connection with native terminal support',
  })

  const supported = createNativeInteractiveUiActions({
    current: () => ({
      app,
      nativeInteractive: {
        waitForHandle: async () => {
          throw new Error('must not wait without a prompt')
        },
        settle: () => {},
      },
    }),
    terminal: new TestTerminal(),
    signals: () => signals,
    suspend: () => {},
    resume: () => {},
    nextOperationId: () => 'operation-unused',
    holderId: 'braid-native-actions',
  })
  assert.deepEqual(await supported.run({ action: 'start' }), {
    kind: 'error',
    message: 'Usage: /interactive <prompt>',
  })
})

test('native terminal start only blocks an active run on the selected branch', () => {
  const app = {
    state: () => ({
      activeRunId: 'run-other-branch',
      conversationId: 'conversation-selected',
      branchId: 'branch-selected',
      runs: [
        {
          id: 'run-other-branch',
          conversationId: 'conversation-other',
          branchId: 'branch-other',
          status: 'running',
        },
      ],
    }),
  } as unknown as Pick<BraidApplication, 'detachRun' | 'reconnectRun' | 'send' | 'state'>
  const actions = createNativeInteractiveUiActions({
    current: () => ({
      app,
      nativeInteractive: {
        waitForHandle: async () => {
          throw new Error('not used')
        },
        settle: () => {},
      },
    }),
    terminal: new TestTerminal(),
    signals: () => signals,
    suspend: () => {},
    resume: () => {},
    nextOperationId: () => 'operation-unused',
    holderId: 'braid-native-actions',
  })

  assert.deepEqual(actions.availability('start'), { available: true })
})
