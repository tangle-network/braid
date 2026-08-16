import { canonicalDigest } from '../domain/canonical.js'
import type { BraidState } from '../domain/state.js'
import type { ProviderRunSnapshot } from '../ports/execution.js'
import type { ReconnectInput, ReplayPort } from './application-ports.js'
import { AppError } from './errors.js'
import { safeSnapshotDetail, safeSnapshotText, safeSnapshotUsage } from './provider-snapshot.js'
import { retainedExecutionRecoveryContext } from './run-recovery-context.js'

interface RecoveryReconnectInput extends ReconnectInput {
  readonly priorFailureDetail?: string
}

export async function reconnectRun(
  context: ReplayPort,
  input: RecoveryReconnectInput,
): Promise<BraidState> {
  const run = context.findRun(input.runId)
  if (context.isTerminal(run.status) && run.status !== 'unknown')
    return structuredClone(context.currentState())
  if (
    !run.capabilities.streaming.replay ||
    !run.capabilities.events.cursor ||
    !context.execution.reconnect
  )
    throw new AppError(
      'CAPABILITY_UNAVAILABLE',
      'The selected execution path does not report replay with a stable cursor',
    )
  await context.commitAndWait({
    kind: 'run.reconnecting',
    runId: run.id,
    ...(run.lastCursor === undefined ? {} : { after: run.lastCursor }),
  })
  const abort = context.ledger.getAbort(run.id) ?? new AbortController()
  context.ledger.setAbort(run.id, abort)
  context.ledger.clearDetached(run.id)
  try {
    let sawTerminal = false
    for await (const envelope of context.execution.reconnect({
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
    })) {
      const result = await context.ingestRuntimeEvent(envelope)
      if (result.accepted && envelope.event.type === 'final') sawTerminal = true
    }
    if (!sawTerminal && !context.isTerminal(context.findRun(run.id).status))
      await reconcileRun(context, {
        runId: run.id,
        operationId: input.operationId,
        ...(input.priorFailureDetail === undefined
          ? {}
          : { priorFailureDetail: input.priorFailureDetail }),
      })
  } catch (error) {
    if (!context.isTerminal(context.findRun(run.id).status))
      await context.commitAndWait({
        kind: 'run.unknown',
        runId: run.id,
        detail: safeSnapshotDetail(
          error instanceof Error ? error.message : error,
          'RUNTIME_RECONCILIATION_ERROR',
        ),
      })
  }
  return structuredClone(context.currentState())
}

export async function reconcileRun(
  context: ReplayPort,
  input: RecoveryReconnectInput,
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
          : { error: safeSnapshotDetail(snapshot.error, 'RUNTIME_RECONCILIATION_ERROR') }),
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
