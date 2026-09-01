import { UNKNOWN_TURN_USAGE } from '../domain/run-usage.js'
import { isRuntimeEventEnvelope } from '../domain/runtime-events.js'
import { activeRunForBranch } from '../domain/state.js'
import type { ExecuteTurnInput } from '../ports/execution.js'
import type { ExecutionRunPort, SendAccess } from './application-ports.js'
import { safeRuntimeDiagnostic } from './provider-values.js'
import { eventIdFor, providerMeta } from './run-event-mapper.js'
import type { RunExecutionSnapshot } from './run-execution-snapshot.js'
import { reconnectRun } from './run-replay.js'

export async function executeRun(
  context: ExecutionRunPort,
  input: RunExecutionSnapshot,
  admission: import('../domain/receipts.js').RunAdmissionReceipt,
  abort: AbortController,
): Promise<void> {
  let terminalSeen = false
  let eventSequence = 0
  try {
    const currentRun = context.currentState().runs.find((run) => run.id === admission.runId)
    const runtimeInput: ExecuteTurnInput = {
      operationId: input.operationId,
      runId: admission.runId,
      turnId: admission.turnId,
      text: input.text,
      profile: input.profile,
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      interactions: admission.requested.interactions ?? {},
      ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
      ...(admission.requested.workspaceRequest === undefined
        ? {}
        : { workspaceRequest: admission.requested.workspaceRequest }),
      ...(admission.requested.workspaceRoot === undefined
        ? {}
        : { workspaceRoot: admission.requested.workspaceRoot }),
      signal: abort.signal,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(currentRun?.lastCursor === undefined ? {} : { after: currentRun.lastCursor }),
      ...(currentRun === undefined ? {} : { afterSequence: currentRun.lastProviderSequence }),
      ...(input.contextPlan === undefined
        ? input.portableContextPlan === undefined
          ? {}
          : { contextBoundary: input.portableContextPlan.digest }
        : { contextBoundary: input.contextPlan.digest }),
      ...(input.portableContextTransferRequest === undefined
        ? {}
        : { contextTransfer: input.portableContextTransferRequest }),
      onRetainedAdmission: async (retainedAdmission) => {
        const committed = context.commitAndWait({
          kind: 'run.retained.admitted',
          runId: admission.runId,
          admission: retainedAdmission,
        })
        if (committed !== undefined) await committed
      },
    }
    if (context.ledger.isDetached(admission.runId)) return
    for await (const runtimeEvent of context.execution.streamTurn(runtimeInput)) {
      if (context.ledger.isDetached(admission.runId)) break
      if (context.isTerminal(context.findRun(admission.runId).status)) break
      if (terminalSeen) break
      if (isRuntimeEventEnvelope(runtimeEvent)) {
        const result = await context.ingestRuntimeEvent(runtimeEvent)
        if (result.accepted && runtimeEvent.event.type === 'final') {
          terminalSeen = true
          await context.flush()
          break
        }
        continue
      }
      eventSequence += 1
      const receivedAt = context.clock.now()
      const eventId = eventIdFor(admission.runId, runtimeEvent, eventSequence)
      const meta = providerMeta(eventId, eventSequence, runtimeEvent, receivedAt)
      const result = await context.ingestRuntimeEvent({
        runId: admission.runId,
        eventId,
        sequence: eventSequence,
        receivedAt,
        ...(meta.occurredAt === undefined ? {} : { occurredAt: meta.occurredAt }),
        event: runtimeEvent,
      })
      if (result.accepted && runtimeEvent.type === 'final') {
        terminalSeen = true
        await context.flush()
        break
      }
    }
    if (context.ledger.isDetached(admission.runId)) return
    if (!terminalSeen) await finishWithoutTerminal(context, input, admission, abort)
  } catch (error) {
    if (context.ledger.isDetached(admission.runId)) return
    const message = safeRuntimeDiagnostic(error, 'RUNTIME_EXECUTION_ERROR')
    if (terminalSeen) throw error
    if (!terminalSeen) await finishAfterError(context, input, admission, abort, message)
  } finally {
    context.ledger.deleteAbort(admission.runId)
    context.ledger.clearExplicitlyCancelled(admission.runId)
    const finalRun = context.findRun(admission.runId)
    if (
      context.isTerminal(finalRun.status) &&
      (finalRun.status !== 'unknown' ||
        (finalRun.capabilities.controls.cancel && context.execution.cancelRun === undefined)) &&
      !context.currentState().missingHistory.some((range) => range.runId === finalRun.id)
    )
      await drainQueue(context)
  }
}

async function finishWithoutTerminal(
  context: ExecutionRunPort,
  input: import('./application-types.js').SendInput,
  admission: import('../domain/receipts.js').RunAdmissionReceipt,
  abort: AbortController,
): Promise<void> {
  if (context.isTerminal(context.findRun(admission.runId).status)) return
  if (
    !abort.signal.aborted &&
    admission.capabilities.streaming.replay &&
    admission.capabilities.events.cursor &&
    context.execution.reconnect
  ) {
    await reconnectRun(context, {
      operationId: `${input.operationId}:reconnect`,
      runId: admission.runId,
    })
    return
  }
  if (abort.signal.aborted || context.ledger.isExplicitlyCancelled(admission.runId)) {
    const pendingCancel = context.ledger.controlForRun(admission.runId, 'cancel')
    if (pendingCancel) {
      const acknowledgement = await pendingCancel.acknowledgement
      if (acknowledgement.outcome === 'accepted' || acknowledgement.outcome === 'already-applied')
        return
      if (!context.isTerminal(context.findRun(admission.runId).status)) {
        await commitRequiredRecovery(context, {
          kind: 'run.unknown',
          runId: admission.runId,
          detail: acknowledgement.detail ?? 'Cancellation outcome is unknown',
        })
      }
      return
    }
    const status = context.ledger.getCancelStatus(admission.runId) ?? 'cancelled'
    await commitRequiredRecovery(context, {
      kind: 'run.finished',
      runId: admission.runId,
      status:
        abort.signal.aborted && !context.ledger.isExplicitlyCancelled(admission.runId)
          ? 'aborted'
          : status,
      finalText: '',
      usage: UNKNOWN_TURN_USAGE,
      error:
        abort.signal.reason instanceof Error ? abort.signal.reason.message : 'Cancelled by user',
    })
  } else {
    await commitRequiredRecovery(context, {
      kind: 'run.unknown',
      runId: admission.runId,
      detail: 'The normalized event stream ended without a terminal event',
    })
  }
}

async function finishAfterError(
  context: ExecutionRunPort,
  input: import('./application-types.js').SendInput,
  admission: import('../domain/receipts.js').RunAdmissionReceipt,
  abort: AbortController,
  message: string,
): Promise<void> {
  if (context.isTerminal(context.findRun(admission.runId).status)) return
  if (
    !abort.signal.aborted &&
    admission.capabilities.streaming.replay &&
    admission.capabilities.events.cursor &&
    context.execution.reconnect
  ) {
    await reconnectRun(context, {
      operationId: `${input.operationId}:reconnect`,
      runId: admission.runId,
      priorFailureDetail: message,
    })
    return
  }
  if (abort.signal.aborted || context.ledger.isExplicitlyCancelled(admission.runId)) {
    const pendingCancel = context.ledger.controlForRun(admission.runId, 'cancel')
    if (pendingCancel) {
      const acknowledgement = await pendingCancel.acknowledgement
      if (acknowledgement.outcome === 'accepted' || acknowledgement.outcome === 'already-applied')
        return
      if (!context.isTerminal(context.findRun(admission.runId).status)) {
        await commitRequiredRecovery(context, {
          kind: 'run.unknown',
          runId: admission.runId,
          detail: acknowledgement.detail ?? 'Cancellation outcome is unknown',
        })
      }
      return
    }
    const status = context.ledger.getCancelStatus(admission.runId) ?? 'cancelled'
    await commitRequiredRecovery(context, {
      kind: 'run.finished',
      runId: admission.runId,
      status:
        abort.signal.aborted && !context.ledger.isExplicitlyCancelled(admission.runId)
          ? 'aborted'
          : status,
      finalText: '',
      usage: UNKNOWN_TURN_USAGE,
      error: message,
    })
  } else {
    await commitRequiredRecovery(context, {
      kind: 'run.finished',
      runId: admission.runId,
      status: 'failed',
      finalText: '',
      usage: UNKNOWN_TURN_USAGE,
      error: message,
    })
  }
}

async function commitRequiredRecovery(
  context: ExecutionRunPort,
  event: import('../domain/events.js').BraidEvent,
): Promise<void> {
  let durableEvent = event
  if (event.kind === 'run.finished' && event.finalText.length === 0) {
    const pending = finishPendingText(context, event.runId)
    if (pending.length > 0) durableEvent = { ...event, finalText: pending, finalTextMode: 'append' }
  } else if (event.kind === 'run.unknown') {
    const pending = finishPendingText(context, event.runId)
    if (pending.length > 0) durableEvent = { ...event, pendingText: pending }
  }
  const commit = context.commitAndWaitRecovery ?? context.commitAndWait
  const result = commit(durableEvent)
  if (result !== undefined) await result
  if (event.kind === 'run.finished' || event.kind === 'run.unknown')
    context.streamSanitizer.reset(event.runId)
}

function finishPendingText(context: ExecutionRunPort, runId: string): string {
  const pending = context.streamSanitizer.finish(runId, 'text')
  return pending
}

export async function drainQueue(context: ExecutionRunPort & SendAccess): Promise<void> {
  const state = context.currentState()
  const next = state.queuedInputs.find((candidate) => {
    const completed = state.runs.find((run) => run.id === candidate.runId)
    if (!completed) return false
    const conversationId = candidate.conversationId ?? completed.conversationId
    const branchId = candidate.branchId ?? completed.branchId
    return activeRunForBranch(state, conversationId, branchId) === undefined
  })
  if (!next) return
  if (state.missingHistory.some((range) => range.runId === next.runId)) return
  const completed = context.findRun(next.runId)
  if (
    (completed.status === 'unknown' &&
      (!completed.capabilities.controls.cancel || context.execution.cancelRun !== undefined)) ||
    !context.isTerminal(completed.status)
  )
    return
  if (!context.ledger.claimQueueDrain(next.operationId)) return
  try {
    const receipt = context.send({
      operationId: next.operationId,
      text: next.text,
      conversationId: next.conversationId ?? completed.conversationId,
      branchId: next.branchId ?? completed.branchId,
    })
    if (receipt.admissionReady !== undefined) await receipt.admissionReady
    const removed = context.commitAndWait({
      kind: 'run.queue.removed',
      runId: next.runId,
      operationId: next.operationId,
    })
    if (removed !== undefined) await removed
  } finally {
    context.ledger.releaseQueueDrain(next.operationId)
  }
}
