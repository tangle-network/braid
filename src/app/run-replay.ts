import { canonicalDigest } from '../domain/canonical.js'
import type { BraidState } from '../domain/state.js'
import type { ProviderRunSnapshot } from '../ports/execution.js'
import type { ReconcileInput, ReconnectInput, ReplayPort } from './application-ports.js'
import { AppError } from './errors.js'
import { safeSnapshotDetail, safeSnapshotText, safeSnapshotUsage } from './provider-snapshot.js'
import { runtimeFailureDiagnostic, safeRuntimeDiagnostic } from './provider-values.js'
import { retainedExecutionRecoveryContext } from './run-recovery-context.js'
import {
  type PumpOutcome,
  pumpWithIdleBound,
  STALLED,
  statusTimeoutMs,
  streamIdleMs,
  withinDeadline,
} from './run-stall.js'

interface RecoveryReconnectInput extends ReconnectInput {
  readonly priorFailureDetail?: string
  /** The live stream went silent: say so, and ask the provider before replaying. */
  readonly stallDetail?: string
}

interface RecoveryReconcileInput extends ReconcileInput {
  readonly priorFailureDetail?: string
}

export async function reconnectRun(
  context: ReplayPort,
  input: RecoveryReconnectInput,
): Promise<BraidState> {
  const run = context.findRun(input.runId)
  if (context.isTerminal(run.status) && run.status !== 'unknown') {
    return structuredClone(context.currentState())
  }
  if (
    !run.capabilities.streaming.replay ||
    !run.capabilities.events.cursor ||
    !context.execution.reconnect
  )
    throw new AppError(
      'CAPABILITY_UNAVAILABLE',
      'The selected execution path does not report replay with a stable cursor',
    )
  if (run.status !== 'reconnecting') {
    await context.commitAndWait({
      kind: 'run.reconnecting',
      runId: run.id,
      ...(run.lastCursor === undefined ? {} : { after: run.lastCursor }),
      ...(input.stallDetail === undefined ? {} : { detail: input.stallDetail }),
    })
  }
  let interactionReadyNotified = false
  const notifyInteractionReady = () => {
    if (
      !interactionReadyNotified &&
      context.findRun(run.id).interactions.some((interaction) => interaction.status === 'pending')
    ) {
      interactionReadyNotified = true
      input.onInteractionReady?.()
    }
  }
  notifyInteractionReady()
  const abort = context.ledger.getAbort(run.id) ?? new AbortController()
  context.ledger.setAbort(run.id, abort)
  context.ledger.clearDetached(run.id)
  try {
    // Each pass replays from the committed cursor. A pass that goes silent asks the provider
    // again, so a quiet long tool call keeps replaying while a lost provider ends as unknown.
    let probeFirst = input.stallDetail !== undefined
    let terminalProbes = 0
    for (;;) {
      if (probeFirst) {
        const verdict = await probeProvider(context, run.id, abort.signal)
        if (verdict.kind === 'lost') {
          await commitUnknownIfLive(context, run.id, `provider stream lost; ${verdict.detail}`)
          break
        }
        if (verdict.kind === 'terminal') {
          // A terminal provider whose replay also stalls yields its result from the status read.
          terminalProbes += 1
          if (terminalProbes > 1) {
            await reconcileRun(context, {
              runId: run.id,
              operationId: input.operationId,
              ...(input.priorFailureDetail === undefined
                ? {}
                : { priorFailureDetail: input.priorFailureDetail }),
            })
            break
          }
        }
      }
      const outcome = await replayFromCursor(context, run.id, abort, notifyInteractionReady)
      if (outcome === 'stalled') {
        if (abort.signal.aborted || context.ledger.isDetached(run.id)) break
        probeFirst = true
        continue
      }
      if (outcome === 'ended' && !context.isTerminal(context.findRun(run.id).status))
        await reconcileRun(context, {
          runId: run.id,
          operationId: input.operationId,
          ...(input.priorFailureDetail === undefined
            ? {}
            : { priorFailureDetail: input.priorFailureDetail }),
        })
      break
    }
  } catch (error) {
    if (!context.isTerminal(context.findRun(run.id).status))
      await context.commitAndWait({
        kind: 'run.unknown',
        runId: run.id,
        detail: safeRuntimeDiagnostic(error, 'RUNTIME_RECONCILIATION_ERROR'),
      })
  }
  return structuredClone(context.currentState())
}

async function replayFromCursor(
  context: ReplayPort,
  runId: string,
  abort: AbortController,
  notifyInteractionReady: () => void,
): Promise<PumpOutcome> {
  // The cursor is read at each pass: events committed by an earlier, stalled pass count.
  const run = context.findRun(runId)
  const reconnect = context.execution.reconnect?.bind(context.execution)
  if (reconnect === undefined) return 'ended'
  let sawTerminal = false
  const outcome = await pumpWithIdleBound(
    reconnect({
      runId: run.id,
      ...(run.lastCursor === undefined ? {} : { after: run.lastCursor }),
      afterSequence: run.lastProviderSequence,
      ...(run.providerSessionId === undefined ? {} : { providerSessionId: run.providerSessionId }),
      ...(run.controlRef === undefined ? {} : { controlRef: run.controlRef }),
      ...retainedExecutionRecoveryContext(run, context.currentState().workspace),
      onRetainedAdmission: async (admission) => {
        const committed = context.commitAndWait({
          kind: 'run.retained.admitted',
          runId: run.id,
          admission,
        })
        if (committed !== undefined) await committed
      },
      signal: abort.signal,
    }),
    streamIdleMs(context.execution),
    () => true,
    async (envelope) => {
      const result = await context.ingestRuntimeEvent(envelope)
      if (result.accepted) notifyInteractionReady()
      if (result.accepted && envelope.event.type === 'final') sawTerminal = true
      return 'continue' as const
    },
  )
  return sawTerminal ? 'stopped' : outcome
}

type ProviderVerdict =
  | { readonly kind: 'live' }
  | { readonly kind: 'terminal' }
  | { readonly kind: 'lost'; readonly detail: string }

/** Ask the provider about the exact run before replaying or giving up on it. */
async function probeProvider(
  context: ReplayPort,
  runId: string,
  signal: AbortSignal,
): Promise<ProviderVerdict> {
  const run = context.findRun(runId)
  if (!run.capabilities.controls.status || !context.execution.status)
    return { kind: 'lost', detail: 'the provider cannot report run status' }
  let snapshot: ProviderRunSnapshot | null | typeof STALLED
  try {
    snapshot = await withinDeadline(
      context.execution.status({
        runId: run.id,
        ...(run.providerSessionId === undefined
          ? {}
          : { providerSessionId: run.providerSessionId }),
        ...(run.controlRef === undefined ? {} : { controlRef: run.controlRef }),
        ...retainedExecutionRecoveryContext(run, context.currentState().workspace),
        signal,
      }),
      statusTimeoutMs(context.execution),
    )
  } catch (error) {
    // Provider text is untrusted; only a typed code may accompany Braid's own plain reason.
    const code = safeRuntimeDiagnostic(error, '')
    return {
      kind: 'lost',
      detail: code === '' ? 'status read failed' : `status read failed (${code})`,
    }
  }
  if (snapshot === STALLED) return { kind: 'lost', detail: 'the status read timed out' }
  if (snapshot === null) return { kind: 'lost', detail: 'the provider has no record of the run' }
  if (
    snapshot.runId !== run.id ||
    (run.providerSessionId !== undefined && snapshot.sessionId !== run.providerSessionId)
  )
    return { kind: 'lost', detail: 'the provider reported a different run' }
  if (snapshot.status === 'unknown')
    return {
      kind: 'lost',
      detail: safeSnapshotDetail(snapshot.detail, 'the provider state is unknown'),
    }
  return context.isTerminal(snapshot.status) ? { kind: 'terminal' } : { kind: 'live' }
}

async function commitUnknownIfLive(
  context: ReplayPort,
  runId: string,
  detail: string,
): Promise<void> {
  const status = context.findRun(runId).status
  if (!context.isTerminal(status) || status === 'unknown')
    await context.commitAndWait({ kind: 'run.unknown', runId, detail })
}

export async function reconcileRun(
  context: ReplayPort,
  input: RecoveryReconcileInput,
): Promise<BraidState> {
  const run = context.findRun(input.runId)
  if (!run.capabilities.controls.status || !context.execution.status) {
    if (!context.isTerminal(run.status))
      await context.commitAndWait({
        kind: 'run.unknown',
        runId: run.id,
        detail: input.priorFailureDetail ?? 'The execution path cannot reconcile provider state',
      })
    return structuredClone(context.currentState())
  }
  let snapshot: ProviderRunSnapshot | null
  try {
    snapshot = await context.execution.status({
      runId: run.id,
      ...(run.providerSessionId === undefined ? {} : { providerSessionId: run.providerSessionId }),
      ...(run.controlRef === undefined ? {} : { controlRef: run.controlRef }),
      ...retainedExecutionRecoveryContext(run, context.currentState().workspace),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
  } catch (error) {
    if (!context.isTerminal(run.status))
      await context.commitAndWait({
        kind: 'run.unknown',
        runId: run.id,
        detail: safeSnapshotDetail(
          error instanceof Error ? error.message : error,
          'RUNTIME_STATUS_ERROR',
        ),
      })
    return structuredClone(context.currentState())
  }
  if (!snapshot) {
    if (!context.isTerminal(run.status) || run.status === 'unknown')
      await context.commitAndWait({
        kind: 'run.unknown',
        runId: run.id,
        detail: input.priorFailureDetail ?? 'The provider returned no run record',
      })
    return structuredClone(context.currentState())
  }
  if (
    snapshot.runId !== run.id ||
    (run.providerSessionId !== undefined && snapshot.sessionId !== run.providerSessionId)
  ) {
    if (!context.isTerminal(run.status) || run.status === 'unknown')
      await context.commitAndWait({
        kind: 'run.unknown',
        runId: run.id,
        detail: 'Provider reconciliation returned no matching run identity',
      })
    return structuredClone(context.currentState())
  }
  if (context.isTerminal(run.status) && run.status !== 'unknown')
    return structuredClone(context.currentState())
  await context.commitAndWait({
    kind: 'run.reconnecting',
    runId: run.id,
    ...(run.lastCursor === undefined ? {} : { after: run.lastCursor }),
  })
  const reconciliationFrom = context.findRun(run.id).status
  if (snapshot.status === 'unknown') {
    if (!context.isTerminal(run.status) || run.status === 'unknown')
      await context.commitAndWait({
        kind: 'run.unknown',
        runId: run.id,
        detail: safeSnapshotDetail(snapshot.detail, 'RUNTIME_PROVIDER_STATE_UNKNOWN'),
      })
  } else if (context.isTerminal(snapshot.status)) {
    if (run.status === 'unknown') {
      await context.commitAndWait({
        kind: 'run.reconciled',
        runId: run.id,
        status: snapshot.status,
        from: reconciliationFrom,
        to: snapshot.status,
        evidence: canonicalDigest({
          runId: run.id,
          sessionId: snapshot.sessionId ?? null,
          cursor: snapshot.cursor ?? null,
          status: snapshot.status,
        }),
        ...(snapshot.detail === undefined
          ? {}
          : { detail: safeSnapshotDetail(snapshot.detail, 'RUNTIME_RECONCILIATION_STATUS') }),
      })
      await context.commitAndWait({
        kind: 'run.finished',
        runId: run.id,
        status: snapshot.status,
        finalText: safeSnapshotText(snapshot.finalText),
        usage: safeSnapshotUsage(snapshot.usage, {
          input: run.inputTokens,
          output: run.outputTokens,
        }),
        ...(snapshot.error === undefined
          ? {}
          : { error: runtimeFailureDiagnostic(snapshot.error, 'RUNTIME_RECONCILIATION_ERROR') }),
        ...(snapshot.detail === undefined
          ? {}
          : { reason: safeSnapshotDetail(snapshot.detail, 'RUNTIME_RECONCILIATION_STATUS') }),
      })
    } else {
      await context.commitAndWait({
        kind: 'run.finished',
        runId: run.id,
        status: snapshot.status,
        finalText: safeSnapshotText(snapshot.finalText),
        usage: safeSnapshotUsage(snapshot.usage, {
          input: run.inputTokens,
          output: run.outputTokens,
        }),
        ...(snapshot.error === undefined
          ? {}
          : { error: safeSnapshotDetail(snapshot.error, 'RUNTIME_RECONCILIATION_ERROR') }),
        ...(snapshot.detail === undefined
          ? {}
          : { reason: safeSnapshotDetail(snapshot.detail, 'RUNTIME_RECONCILIATION_STATUS') }),
      })
    }
  } else if (snapshot.status !== reconciliationFrom) {
    await context.commitAndWait({
      kind: 'run.reconciled',
      runId: run.id,
      status: snapshot.status,
      from: reconciliationFrom,
      to: snapshot.status,
      evidence: canonicalDigest({
        runId: run.id,
        sessionId: snapshot.sessionId ?? null,
        cursor: snapshot.cursor ?? null,
        status: snapshot.status,
      }),
      ...(snapshot.detail === undefined
        ? {}
        : { detail: safeSnapshotDetail(snapshot.detail, 'RUNTIME_RECONCILIATION_STATUS') }),
    })
  }
  return structuredClone(context.currentState())
}
