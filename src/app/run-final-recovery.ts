import type { BraidEventEnvelope } from '../domain/events.js'
import { eventRunId } from '../domain/events.js'
import type { RunId } from '../domain/ids.js'
import type { BraidRuntimeEvent } from '../domain/runtime-events.js'
import { type BraidRun, isLiveRunStatus, type RunStatus } from '../domain/state.js'
import type { ReplayPort } from './application-ports.js'
import { statusFromCanonical, terminalStatus } from './run-event-mapper.js'
import { retainedExecutionRecoveryContext } from './run-recovery-context.js'

/** Bounds one restart read of a final result the provider has already settled. */
export const PENDING_FINAL_RECOVERY_TIMEOUT_MS = 60_000

/**
 * A provider can report a terminal status before the stream's final event.
 * Only that final carries the exact result: its error, reason, and usage.
 * Retained Tangle runs stream `status: failed` and then project the final from the result endpoint.
 * Reading stops at the first event that would contradict the terminal status.
 */
export function continuesTerminal(status: RunStatus, event: BraidRuntimeEvent): boolean {
  switch (event.type) {
    case 'final':
      return terminalStatus(event.status) === status
    case 'status':
      return statusFromCanonical(event.status) === status
    case 'interaction':
    case 'interaction.cancel':
      return false
    default:
      return true
  }
}

/**
 * Cheap state filter for a run that a stream status made terminal before its final event.
 * A committed final always leaves an error or a terminal reason on a failed or cancelled run.
 * Only an exactly bound run qualifies, so recovery replays that run and never starts a turn.
 */
function mayAwaitFinalResult(run: BraidRun): boolean {
  return (
    (run.status === 'failed' || run.status === 'cancelled') &&
    run.error === undefined &&
    run.terminalReason === undefined &&
    run.controlRef !== undefined &&
    run.capabilities.streaming.replay &&
    run.capabilities.events.cursor
  )
}

/**
 * The journal decides: the run's terminal status came from `run.status.changed`, and no
 * `run.finished` followed. Missing or compacted history is not evidence, so it recovers nothing.
 */
export function awaitsFinalResult(run: BraidRun, events: readonly BraidEventEnvelope[]): boolean {
  // The latest decisive event wins: a restart can reconcile a live run before it later fails.
  let terminalByStatus = false
  for (const { event } of events) {
    if (eventRunId(event) !== run.id) continue
    if (event.kind === 'run.finished') terminalByStatus = false
    else if (event.kind === 'run.reconciled' && !isLiveRunStatus(event.status))
      terminalByStatus = false
    else if (event.kind === 'run.status.changed') terminalByStatus = event.status === run.status
  }
  return terminalByStatus
}

/**
 * Read the final result of runs that Braid left terminal-by-status when it exited.
 * The replay ingests only events that continue the committed terminal status, so the status
 * never regresses; a stream gap, contradiction, failure, or deadline leaves the run as it is.
 */
export async function recoverPendingFinalResults(
  context: ReplayPort,
  loadEvents:
    | ((input: { readonly runId?: RunId }) => Promise<readonly BraidEventEnvelope[]>)
    | undefined,
  timeoutMs = PENDING_FINAL_RECOVERY_TIMEOUT_MS,
): Promise<void> {
  if (loadEvents === undefined || context.execution.reconnect === undefined) return
  const candidates = context.currentState().runs.filter(mayAwaitFinalResult)
  await Promise.all(
    candidates.map(async (candidate) => {
      if (!awaitsFinalResult(candidate, await loadEvents({ runId: candidate.id }))) return
      await recoverPendingFinal(context, candidate.id, timeoutMs)
    }),
  )
}

/**
 * Replay one exactly bound, terminal-by-status run to read its final result, once.
 * The whole read races the deadline, because a provider need not honor the abort signal:
 * the caller always proceeds at the deadline, and a read that settles later commits nothing.
 */
export async function recoverPendingFinal(
  context: ReplayPort,
  runId: string,
  timeoutMs = PENDING_FINAL_RECOVERY_TIMEOUT_MS,
): Promise<void> {
  const execution = context.execution
  if (execution.reconnect === undefined) return
  const reconnect = execution.reconnect.bind(execution)
  const run = context.findRun(runId)
  if (!mayAwaitFinalResult(run)) return
  const abort = new AbortController()
  const replay = (async () => {
    for await (const envelope of reconnect({
      runId,
      ...(run.lastCursor === undefined ? {} : { after: run.lastCursor }),
      afterSequence: run.lastProviderSequence,
      ...(run.providerSessionId === undefined ? {} : { providerSessionId: run.providerSessionId }),
      ...(run.controlRef === undefined ? {} : { controlRef: run.controlRef }),
      ...retainedExecutionRecoveryContext(run, context.currentState().workspace),
      signal: abort.signal,
      afterTerminalStatus: true,
    })) {
      // Checked before every ingest: nothing commits once the deadline has passed.
      if (abort.signal.aborted) return
      const current = context.findRun(runId)
      if (!continuesTerminal(current.status, envelope.event)) return
      // A gap would reopen the run for reconnection, so only the next event is ingested.
      if (envelope.sequence > current.lastProviderSequence + 1) return
      const result = await context.ingestRuntimeEvent(envelope)
      if (result.accepted && envelope.event.type === 'final') return
    }
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      abort.abort(new Error('Pending final result recovery deadline'))
      resolve()
    }, timeoutMs)
  })
  try {
    await Promise.race([replay, deadline])
  } catch {
    // The run keeps its committed terminal status; only its final detail stays unavailable.
  } finally {
    clearTimeout(timer)
    abort.abort()
    // An abandoned read may still settle; its outcome is deliberately ignored.
    replay.catch(() => undefined)
  }
}
