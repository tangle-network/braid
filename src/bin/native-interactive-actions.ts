import type { AgentInteractiveTerminalSession } from '@tangle-network/agent-interface'
import {
  claimRetainedInteractiveControl,
  type RetainedInteractiveRunHandle,
} from '@tangle-network/agent-runtime/kernel'
import { createNativeTerminalTransport } from '../adapters/tui/native-terminal-transport.js'
import type { BraidApplication } from '../app/application.js'
import { runtimeWorkerReference } from '../app/supervisor-projection.js'
import { activeRunForBranch, type BraidRun, type BraidState } from '../domain/state.js'
import type { NativeInteractiveExecutionControl } from '../ports/native-interactive-execution.js'
import type {
  NativeTerminalHost,
  NativeTerminalSignalPort,
  NativeTerminalTransportResult,
} from '../ports/native-terminal-transport.js'
import type {
  NativeInteractiveAvailability,
  NativeInteractiveCommand,
  NativeInteractiveCommandResult,
  NativeInteractiveUiActions,
  NativeInteractiveWorkerCommand,
  NativeInteractiveWorkerResult,
} from '../views/shared/native-interactive-actions.js'

interface InteractiveApplicationHandle {
  readonly app: Pick<BraidApplication, 'detachRun' | 'reconnectRun' | 'send' | 'state'> &
    Partial<Pick<BraidApplication, 'intelligence'>>
  readonly nativeInteractive?: NativeInteractiveExecutionControl
}

export interface NativeInteractiveActionsOptions {
  readonly current: () => InteractiveApplicationHandle
  readonly terminal: NativeTerminalHost
  readonly signals: () => NativeTerminalSignalPort
  readonly suspend: () => void
  readonly resume: () => void
  readonly nextOperationId: () => string
  readonly holderId: string
}

/** Coordinates one terminal viewer. Runtime and the application retain all durable state. */
export function createNativeInteractiveUiActions(
  options: NativeInteractiveActionsOptions,
): NativeInteractiveUiActions {
  let busy = false
  const actions: NativeInteractiveUiActions = {
    availability: (action: NativeInteractiveCommand['action']) =>
      availability(options.current(), action, busy),
    run: async (command: NativeInteractiveCommand): Promise<NativeInteractiveCommandResult> => {
      if (busy) return { kind: 'unavailable', reason: 'A native terminal is already open' }
      const available = availability(options.current(), command.action, false)
      if (!available.available) {
        return { kind: 'unavailable', reason: available.reason ?? 'Native terminal unavailable' }
      }
      busy = true
      try {
        return await runCommand(options, command)
      } catch (error) {
        return { kind: 'error', message: errorMessage(error) }
      } finally {
        busy = false
      }
    },
    workerAvailability: (workerId?: string) =>
      workerAvailability(options.current(), workerId, busy),
    attachWorker: async (
      command: NativeInteractiveWorkerCommand,
    ): Promise<NativeInteractiveWorkerResult> => {
      if (busy) return { kind: 'unavailable', reason: 'A native terminal is already open' }
      const available = workerAvailability(options.current(), command.workerId, false)
      if (!available.available) {
        return { kind: 'unavailable', reason: available.reason ?? 'Worker terminal unavailable' }
      }
      busy = true
      try {
        return await attachWorker(options, command)
      } catch (error) {
        return { kind: 'error', message: errorMessage(error) }
      } finally {
        busy = false
      }
    },
  }
  return Object.freeze(actions)
}

function workerAvailability(
  current: InteractiveApplicationHandle,
  workerId: string | undefined,
  busy: boolean,
): NativeInteractiveAvailability {
  if (busy) return { available: false, reason: 'A native terminal is already open' }
  const running = current.app.state().workers.filter((worker) => worker.status === 'running')
  if (workerId !== undefined && !running.some((worker) => String(worker.id) === workerId)) {
    return { available: false, reason: 'The selected worker is not running' }
  }
  return running.length === 0
    ? { available: false, reason: 'There is no running supervised worker to attach' }
    : { available: true }
}

function availability(
  current: InteractiveApplicationHandle,
  action: NativeInteractiveCommand['action'],
  busy: boolean,
): NativeInteractiveAvailability {
  if (busy) return { available: false, reason: 'A native terminal is already open' }
  if (current.nativeInteractive === undefined) {
    return {
      available: false,
      reason: 'Select a retained Tangle Sandbox connection with native terminal support',
    }
  }
  const state = current.app.state()
  if (action === 'start') {
    return !selectedBranchHasActiveRun(state)
      ? { available: true }
      : { available: false, reason: 'Detach or finish the active run first' }
  }
  return latestAttachableRun(state.runs) === undefined
    ? { available: false, reason: 'No retained native session is available' }
    : { available: true }
}

function selectedBranchHasActiveRun(state: BraidState): boolean {
  if (typeof state.conversationId !== 'string' || typeof state.branchId !== 'string')
    return state.activeRunId !== null
  return activeRunForBranch(state, state.conversationId, state.branchId) !== undefined
}

async function runCommand(
  options: NativeInteractiveActionsOptions,
  command: NativeInteractiveCommand,
): Promise<NativeInteractiveCommandResult> {
  const current = options.current()
  const execution = current.nativeInteractive
  if (execution === undefined) {
    return { kind: 'unavailable', reason: 'Native terminal support is unavailable' }
  }
  if (command.action === 'start') {
    const prompt = command.initialPrompt?.trim()
    if (!prompt) return { kind: 'error', message: 'Usage: /interactive <prompt>' }
    const receipt = current.app.send({
      operationId: options.nextOperationId(),
      text: prompt,
      mode: 'interactive',
    })
    await receipt.admissionReady
    return present(options, current, execution, receipt.runId, receipt.completion)
  }

  const runId = command.runId ?? latestAttachableRun(current.app.state().runs)?.id
  if (runId === undefined) {
    return { kind: 'unavailable', reason: 'No retained native session is available' }
  }
  const run = current.app.state().runs.find((candidate) => candidate.id === runId)
  if (run === undefined || !isInteractiveRun(run)) {
    return { kind: 'error', message: `Run ${runId} is not a retained native session` }
  }
  const reconnect = current.app.reconnectRun({
    operationId: options.nextOperationId(),
    runId,
  })
  return present(options, current, execution, runId, reconnect)
}

async function present(
  options: NativeInteractiveActionsOptions,
  current: InteractiveApplicationHandle,
  execution: NativeInteractiveExecutionControl,
  runId: string,
  runCompletion: Promise<unknown>,
): Promise<NativeInteractiveCommandResult> {
  void runCompletion.catch(() => undefined)
  const handle = await execution.waitForHandle(runId)
  let result: NativeTerminalTransportResult
  try {
    result = await presentHandle(options, handle)
  } catch (error) {
    await detachAfterViewerFailure(current.app, runId, options.nextOperationId, error)
    throw error
  }

  const outcome = result.outcome
  if (outcome.kind === 'remote-exit') {
    execution.settle(runId, {
      kind: 'exited',
      ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
      ...(outcome.exitSignal === undefined ? {} : { exitSignal: outcome.exitSignal }),
    })
    await runCompletion
    const cleanup = cleanupMessage(result)
    return cleanup === undefined
      ? { kind: 'returned', runId, outcome: 'exited' }
      : { kind: 'error', message: cleanup }
  }

  await current.app.detachRun({ operationId: options.nextOperationId(), runId })
  await runCompletion.catch(() => undefined)
  if (outcome.kind === 'detached') {
    const cleanup = cleanupMessage(result)
    return cleanup === undefined
      ? { kind: 'returned', runId, outcome: 'detached' }
      : { kind: 'error', message: cleanup }
  }
  return {
    kind: 'error',
    message:
      outcome.kind === 'transport-error'
        ? `Native terminal ${outcome.phase} failed: ${outcome.message}`
        : 'Native terminal closed after an interrupt',
  }
}

async function attachWorker(
  options: NativeInteractiveActionsOptions,
  command: NativeInteractiveWorkerCommand,
): Promise<NativeInteractiveWorkerResult> {
  const current = options.current()
  if (current.app.intelligence === undefined) {
    return { kind: 'unavailable', reason: 'Runtime worker control is unavailable' }
  }
  const reference = runtimeWorkerReference(
    current.app.state(),
    command.supervisorId,
    command.workerId,
  )
  if (reference === undefined) {
    return {
      kind: 'unavailable',
      reason: 'The selected worker is not present under the selected supervisor',
    }
  }
  const attached = await current.app.intelligence.supervisor.attachWorker(
    reference.rootDir,
    reference.runtimeSupervisorId,
    reference.runtimeWorkerId,
  )
  if (attached.status === 'unavailable') {
    return {
      kind: 'unavailable',
      reason: attached.issue?.reason ?? workerUnavailableReason(attached.reason),
    }
  }
  const result = await presentHandle(options, attached.handle)
  const cleanup = cleanupMessage(result)
  if (cleanup !== undefined) return { kind: 'error', message: cleanup }
  if (result.outcome.kind === 'remote-exit') {
    return {
      kind: 'returned',
      operationId: command.operationId,
      workerId: command.workerId,
      outcome: 'exited',
    }
  }
  if (result.outcome.kind === 'detached') {
    return {
      kind: 'returned',
      operationId: command.operationId,
      workerId: command.workerId,
      outcome: 'detached',
    }
  }
  return {
    kind: 'error',
    message:
      result.outcome.kind === 'transport-error'
        ? `Native worker terminal ${result.outcome.phase} failed: ${result.outcome.message}`
        : 'Native worker terminal closed after an interrupt',
  }
}

async function presentHandle(
  options: NativeInteractiveActionsOptions,
  handle: RetainedInteractiveRunHandle,
): Promise<NativeTerminalTransportResult> {
  const control = await claimRetainedInteractiveControl({
    handle,
    holderId: options.holderId,
  })
  const terminalSession: AgentInteractiveTerminalSession = await handle.attach({
    control,
    cols: positiveDimension(options.terminal.columns),
    rows: positiveDimension(options.terminal.rows),
  })
  options.suspend()
  try {
    return await createNativeTerminalTransport({
      session: terminalSession,
      terminal: options.terminal,
      signals: options.signals(),
    }).run()
  } finally {
    options.resume()
  }
}

function workerUnavailableReason(reason: string): string {
  const descriptions: Readonly<Record<string, string>> = {
    'unknown-node': 'Runtime no longer reports the selected worker',
    'not-live': 'The selected worker is no longer running',
    'executor-exposes-no-interactive-session': 'The selected worker runs without a terminal',
    'provider-has-no-interactive-contract': 'The worker provider cannot attach a terminal',
    'interactive-session-not-started': 'The worker did not start an interactive terminal',
    'interactive-binding-not-found': 'The worker has no retained terminal binding',
    'interactive-binding-stale': 'The retained worker terminal is no longer available',
    'interactive-provider-not-registered': 'The worker provider is not selected in Braid',
    'interactive-provider-not-configured': "Select the worker's Tangle Sandbox connection first",
  }
  return descriptions[reason] ?? `Worker terminal unavailable: ${reason}`
}

async function detachAfterViewerFailure(
  app: InteractiveApplicationHandle['app'],
  runId: string,
  nextOperationId: () => string,
  original: unknown,
): Promise<void> {
  try {
    await app.detachRun({ operationId: nextOperationId(), runId })
  } catch (detachError) {
    throw new Error(
      `${errorMessage(original)}; the retained run could not be detached: ${errorMessage(detachError)}`,
      { cause: original },
    )
  }
}

function latestAttachableRun(runs: readonly BraidRun[]): BraidRun | undefined {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]
    if (run !== undefined && isInteractiveRun(run) && attachableStatus(run.status)) return run
  }
  return undefined
}

function isInteractiveRun(run: BraidRun): boolean {
  return run.retainedAdmission?.phase.startsWith('interactive_') === true
}

function attachableStatus(status: BraidRun['status']): boolean {
  return !['completed', 'failed', 'aborted', 'cancelled', 'blocked', 'expired'].includes(status)
}

function positiveDimension(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 1
}

function cleanupMessage(result: NativeTerminalTransportResult): string | undefined {
  if (result.cleanup.issues.length === 0) return undefined
  return result.cleanup.issues.map((issue) => `${issue.phase}: ${issue.message}`).join('; ')
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 512 ? `${message.slice(0, 509)}...` : message
}
