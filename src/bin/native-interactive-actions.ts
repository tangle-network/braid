import type { AgentInteractiveTerminalSession } from '@tangle-network/agent-interface'
import { claimRetainedInteractiveControl } from '@tangle-network/agent-runtime/kernel'
import { createNativeTerminalTransport } from '../adapters/tui/native-terminal-transport.js'
import type { BraidApplication } from '../app/application.js'
import type { BraidRun } from '../domain/state.js'
import type { NativeInteractiveExecutionControl } from '../ports/native-interactive-execution.js'
import type {
  NativeInteractiveAvailability,
  NativeInteractiveCommand,
  NativeInteractiveCommandResult,
  NativeInteractiveUiActions,
} from '../ports/native-interactive-ui.js'
import type {
  NativeTerminalHost,
  NativeTerminalSignalPort,
  NativeTerminalTransportResult,
} from '../ports/native-terminal-transport.js'

interface InteractiveApplicationHandle {
  readonly app: Pick<BraidApplication, 'detachRun' | 'reconnectRun' | 'send' | 'state'>
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
  }
  return Object.freeze(actions)
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
    return state.activeRunId === null
      ? { available: true }
      : { available: false, reason: 'Detach or finish the active run first' }
  }
  return latestAttachableRun(state.runs) === undefined
    ? { available: false, reason: 'No retained native session is available' }
    : { available: true }
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
  let terminalSession: AgentInteractiveTerminalSession
  try {
    const control = await claimRetainedInteractiveControl({
      handle,
      holderId: options.holderId,
    })
    terminalSession = await handle.attach({
      control,
      cols: positiveDimension(options.terminal.columns),
      rows: positiveDimension(options.terminal.rows),
    })
  } catch (error) {
    await detachAfterViewerFailure(current.app, runId, options.nextOperationId, error)
    throw error
  }

  options.suspend()
  let result: NativeTerminalTransportResult
  try {
    result = await createNativeTerminalTransport({
      session: terminalSession,
      terminal: options.terminal,
      signals: options.signals(),
    }).run()
  } finally {
    options.resume()
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
