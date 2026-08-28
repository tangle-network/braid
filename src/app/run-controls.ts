import { canonicalDigest } from '../domain/canonical.js'
import type { BraidEvent } from '../domain/events.js'
import { usageSnapshotForRun } from '../domain/run-usage.js'
import type { ControlAcknowledgement } from '../ports/execution.js'
import type { ControlEffectRequest, ControlPort, QueuePort } from './application-ports.js'
import type { ControlOperationRecord, ControlReceipt, QueueReceipt } from './application-types.js'
import { AppError } from './errors.js'
import { retainedExecutionRecoveryContext } from './run-recovery-context.js'
import { isTerminal } from './run-status.js'

export function queueRunInput(
  context: QueuePort,
  input: { readonly operationId: string; readonly text: string; readonly runId?: string },
): QueueReceipt {
  if (!input.operationId) throw new AppError('OPERATION_ID_REQUIRED', 'queue requires operationId')
  if (!input.text.trim()) throw new AppError('EMPTY_MESSAGE', 'Queued input must not be empty')
  const runId = input.runId ?? context.currentState().activeRunId
  if (!runId) throw new AppError('NO_ACTIVE_RUN', 'Queue input requires an active run')
  const run = context.findRun(runId)
  const existing = context
    .currentState()
    .queuedInputs.find((queued) => queued.operationId === input.operationId)
  if (existing) {
    if (existing.text !== input.text || existing.runId !== runId)
      throw new AppError('OPERATION_CONFLICT', `Operation ${input.operationId} has different input`)
    return {
      operationId: input.operationId,
      runId,
      position: existing.position,
      revision: context.currentState().revision,
    }
  }
  if (!run.capabilities.controls.queue)
    throw new AppError('CAPABILITY_UNAVAILABLE', 'Queued input is not supported by this run')
  if (context.currentState().queuedInputs.length >= 4096)
    throw new AppError('QUEUE_FULL', 'The durable input queue is full')
  const position = context.currentState().queuedInputs.length + 1
  const durable = context.commitAndWait({
    kind: 'run.queue.added',
    runId,
    operationId: input.operationId,
    text: input.text,
    position,
  })
  return {
    operationId: input.operationId,
    runId,
    position,
    revision: context.currentState().revision,
    ...(durable === undefined ? {} : { completion: Promise.resolve(durable) }),
  }
}

export async function steerRun(
  context: ControlPort,
  input: { readonly operationId: string; readonly runId?: string; readonly text: string },
): Promise<ControlReceipt> {
  const run = context.findRun(input.runId ?? context.currentState().activeRunId ?? '')
  if (!run.capabilities.controls.steer || !context.execution.steerRun)
    throw new AppError('CAPABILITY_UNAVAILABLE', 'Live steering is not supported by this run')
  const request: ControlEffectRequest = {
    operationId: input.operationId,
    runId: run.id,
    control: 'steer',
    text: input.text,
    ...(run.providerSessionId === undefined ? {} : { providerSessionId: run.providerSessionId }),
    ...(run.controlRef === undefined ? {} : { controlRef: run.controlRef }),
  }
  return control(context, request, 'steer')
}

export async function cancelRun(
  context: ControlPort,
  input: {
    readonly operationId: string
    readonly runId?: string
    readonly reason?: string
    readonly terminalStatus?: 'cancelled' | 'aborted'
    readonly legacy?: boolean
  },
): Promise<ControlReceipt> {
  const run = context.findRun(input.runId ?? context.currentState().activeRunId ?? '')
  if (context.ledger.getControl(input.operationId) === undefined && isTerminal(run.status))
    throw new AppError('UNKNOWN_RUN', `Run ${run.id} is not active`)
  if (!run.capabilities.controls.cancel && !input.legacy)
    throw new AppError('CAPABILITY_UNAVAILABLE', 'This run does not advertise cancellation support')
  const request: ControlEffectRequest = {
    operationId: input.operationId,
    runId: run.id,
    control: 'cancel',
    ...(run.providerSessionId === undefined ? {} : { providerSessionId: run.providerSessionId }),
    ...(run.controlRef === undefined ? {} : { controlRef: run.controlRef }),
    recovery: retainedExecutionRecoveryContext(run, context.currentState().workspace),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  }
  const receipt = await control(context, request, 'cancel', input.terminalStatus ?? 'cancelled')
  return receipt
}

export async function detachRun(
  context: ControlPort,
  input: { readonly operationId: string; readonly runId?: string },
): Promise<ControlReceipt> {
  const run = context.findRun(input.runId ?? context.currentState().activeRunId ?? '')
  if (
    !run.capabilities.streaming.detach ||
    !run.capabilities.controls.recreate ||
    !context.execution.detachRun
  )
    throw new AppError('CAPABILITY_UNAVAILABLE', 'This run cannot be detached')
  const request: ControlEffectRequest = {
    operationId: input.operationId,
    runId: run.id,
    control: 'detach',
    ...(run.providerSessionId === undefined ? {} : { providerSessionId: run.providerSessionId }),
    ...(run.controlRef === undefined ? {} : { controlRef: run.controlRef }),
    ...(run.lastCursor === undefined ? {} : { cursor: run.lastCursor }),
    recovery: retainedExecutionRecoveryContext(run, context.currentState().workspace),
  }
  return control(context, request, 'detach')
}

async function control(
  context: ControlPort,
  request: ControlEffectRequest,
  controlKind: 'cancel' | 'steer' | 'detach',
  cancelStatus?: 'cancelled' | 'aborted',
): Promise<ControlReceipt> {
  const run = context.findRun(request.runId)
  const digest = canonicalDigest({
    control: controlKind,
    runId: request.runId,
    providerSessionId: request.providerSessionId ?? null,
    reason: request.reason ?? null,
    text: request.text ?? null,
    cursor: request.cursor ?? null,
  })
  const previous = context.ledger.getControl(request.operationId)
  if (previous) {
    if (previous.digest !== digest)
      throw new AppError(
        'OPERATION_CONFLICT',
        `Operation ${request.operationId} has different input`,
      )
    const acknowledgement = await previous.acknowledgement
    if (acknowledgement.outcome === 'unknown') {
      if (!context.currentEffect(request.operationId))
        return {
          operationId: request.operationId,
          runId: request.runId,
          control: controlKind,
          replayed: true,
          acknowledgement,
          status: context.findRun(request.runId).status,
          completion: previous.completion,
        }
      const reconciled = await context.executeControl(request)
      const durable = context.commitAndWait({
        kind: 'run.control.acknowledged',
        runId: request.runId,
        operationId: request.operationId,
        control: controlKind,
        outcome: reconciled.outcome,
        ...(reconciled.detail === undefined ? {} : { detail: reconciled.detail }),
      })
      if (durable !== undefined) await durable
      context.ledger.setControl(request.operationId, {
        ...previous,
        acknowledgement: Promise.resolve(reconciled),
        completion: Promise.resolve(context.currentState()),
      })
      return {
        operationId: request.operationId,
        runId: request.runId,
        control: controlKind,
        replayed: true,
        acknowledgement: reconciled,
        status: context.findRun(request.runId).status,
        completion: Promise.resolve(context.currentState()),
      }
    }
    return {
      operationId: request.operationId,
      runId: request.runId,
      control: controlKind,
      replayed: true,
      acknowledgement,
      status: context.findRun(request.runId).status,
      completion: previous.completion,
    }
  }

  if (controlKind === 'cancel') {
    const existing = context.ledger.controlForRun(request.runId, 'cancel')
    if (existing !== undefined)
      return existingControlReceipt(context, request.operationId, controlKind, existing)
  }

  let resolveAcknowledgement!: (value: ControlAcknowledgement) => void
  const acknowledgement = new Promise<ControlAcknowledgement>((resolve) => {
    resolveAcknowledgement = resolve
  })
  let resolveCompletion!: (value: import('../domain/state.js').BraidState) => void
  let rejectCompletion!: (error: unknown) => void
  const completion = new Promise<import('../domain/state.js').BraidState>((resolve, reject) => {
    resolveCompletion = resolve
    rejectCompletion = reject
  })
  let resolveLateSettlementReady!: () => void
  const lateSettlementReady = new Promise<void>((resolve) => {
    resolveLateSettlementReady = resolve
  })
  context.ledger.setControl(request.operationId, {
    digest,
    runId: request.runId,
    control: controlKind,
    acknowledgement,
    completion,
    lateSettlementReady,
    ...(request.providerSessionId === undefined
      ? {}
      : { providerSessionId: request.providerSessionId }),
    ...(request.reason === undefined ? {} : { reason: request.reason }),
    ...(request.text === undefined ? {} : { text: request.text }),
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
  })

  let preflightAcknowledgement: ControlAcknowledgement | undefined
  try {
    const requested: BraidEvent = {
      kind: 'run.control.requested',
      runId: request.runId,
      operationId: request.operationId,
      control: controlKind,
      digest,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      ...(request.text === undefined ? {} : { text: request.text }),
    }
    if (controlKind === 'cancel') {
      const legacyRequested: BraidEvent = {
        kind: 'run.cancel.requested',
        runId: request.runId,
        operationId: request.operationId,
        ...(request.reason === undefined ? {} : { reason: request.reason }),
      }
      await commitControlRequestBatch(context, [requested, legacyRequested])
      const afterRequest = context.findRun(request.runId)
      if (context.isTerminal(afterRequest.status)) {
        preflightAcknowledgement = {
          operationId: request.operationId,
          outcome: 'rejected',
          detail: `Cancellation rejected because run ${request.runId} reached terminal status ${afterRequest.status} before the request was applied`,
        }
        await persistControlAcknowledgement(context, request, controlKind, preflightAcknowledgement)
      } else {
        context.ledger.markExplicitlyCancelled(request.runId)
        context.ledger.markCancellationPending(request.runId)
        context.ledger.setCancelStatus(request.runId, cancelStatus ?? 'cancelled')
      }
    } else {
      const durable = context.commitAndWait(requested)
      if (durable !== undefined) await durable
      if (controlKind === 'detach') context.ledger.markDetached(request.runId)
    }
  } catch (error) {
    context.ledger.deleteControl(request.operationId)
    rejectCompletion(error)
    resolveLateSettlementReady()
    throw error
  }

  if (preflightAcknowledgement !== undefined) {
    resolveAcknowledgement(preflightAcknowledgement)
    resolveCompletion(structuredClone(context.currentState()))
    resolveLateSettlementReady()
    const ack = await acknowledgement
    return {
      operationId: request.operationId,
      runId: request.runId,
      control: controlKind,
      replayed: false,
      acknowledgement: ack,
      status: context.findRun(request.runId).status,
      completion,
    }
  }

  if (controlKind === 'cancel' && !context.execution.cancelRun)
    context.ledger.getAbort(request.runId)?.abort(new Error(request.reason ?? 'Cancelled'))
  void (async () => {
    let ack: ControlAcknowledgement
    try {
      ack = await context.executeControl(request, {
        onLateSettlement: (late) =>
          settleLateControl(context, request, late, cancelStatus ?? 'cancelled'),
      })
    } catch {
      ack = { operationId: request.operationId, outcome: 'unknown', detail: 'CONTROL_UNKNOWN' }
    }
    resolveAcknowledgement(ack)
    const acknowledged = context.commitAndWait({
      kind: 'run.control.acknowledged',
      runId: request.runId,
      operationId: request.operationId,
      control: controlKind,
      outcome: ack.outcome,
      ...(ack.detail === undefined ? {} : { detail: ack.detail }),
    })
    if (acknowledged !== undefined) await acknowledged
    if (ack.outcome === 'accepted' || ack.outcome === 'already-applied') {
      if (controlKind === 'cancel') {
        await applyAcceptedCancellation(context, request, run, cancelStatus ?? 'cancelled', ack)
      } else if (controlKind === 'detach') {
        context.ledger.getAbort(request.runId)?.abort(new Error('Detached by user'))
        const detached = context.commitAndWait({
          kind: 'run.detached',
          runId: request.runId,
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          ...(ack.detail === undefined ? {} : { detail: ack.detail }),
        })
        if (detached !== undefined) await detached
      }
      resolveCompletion(structuredClone(context.currentState()))
      return
    }
    context.ledger.clearExplicitlyCancelled(request.runId)
    if (controlKind !== 'cancel' || ack.outcome === 'rejected') {
      context.ledger.clearCancellationPending(request.runId)
      context.ledger.clearCancelStatus(request.runId)
    }
    context.ledger.clearDetached(request.runId)
    if (ack.outcome === 'unknown' && !context.isTerminal(context.findRun(request.runId).status)) {
      const unknown = context.commitAndWait(
        unknownEventWithPendingText(
          context,
          request.runId,
          controlKind === 'cancel'
            ? unknownCancellationDetail(ack.detail)
            : (ack.detail ?? 'Control outcome is unknown'),
        ),
      )
      if (unknown !== undefined) await unknown
      context.streamSanitizer.reset(request.runId)
    }
    resolveCompletion(structuredClone(context.currentState()))
  })()
    .catch((error: unknown) => rejectCompletion(error))
    .finally(() => resolveLateSettlementReady())
  const ack = await acknowledgement
  return {
    operationId: request.operationId,
    runId: request.runId,
    control: controlKind,
    replayed: false,
    acknowledgement: ack,
    status: context.findRun(request.runId).status,
    completion,
  }
}

async function settleLateControl(
  context: ControlPort,
  request: ControlEffectRequest,
  acknowledgement: ControlAcknowledgement,
  cancelStatus: 'cancelled' | 'aborted',
): Promise<void> {
  const existing = context.ledger.getControl(request.operationId)
  if (existing === undefined) return
  if (existing.lateSettlement !== undefined) {
    await existing.lateSettlement
    return
  }
  const task = (async () => {
    await existing.lateSettlementReady
    const current = context.ledger.getControl(request.operationId)
    if (current === undefined) return
    const previous = await current.acknowledgement
    if (previous.outcome !== 'unknown') return

    await persistControlAcknowledgement(context, request, request.control, acknowledgement)
    const next = {
      ...current,
      acknowledgement: Promise.resolve(acknowledgement),
      completion: Promise.resolve(structuredClone(context.currentState())),
    }
    context.ledger.setControl(request.operationId, next)

    if (request.control === 'cancel') {
      if (acknowledgement.outcome === 'accepted' || acknowledgement.outcome === 'already-applied') {
        await applyAcceptedCancellation(
          context,
          request,
          context.findRun(request.runId),
          cancelStatus,
          acknowledgement,
        )
      } else {
        context.ledger.clearCancellationPending(request.runId)
        context.ledger.clearCancelStatus(request.runId)
        if (!context.isTerminal(context.findRun(request.runId).status)) {
          const unknown = context.commitAndWait(
            unknownEventWithPendingText(
              context,
              request.runId,
              unknownCancellationDetail(acknowledgement.detail),
            ),
          )
          if (unknown !== undefined) await unknown
          context.streamSanitizer.reset(request.runId)
        }
      }
    }
    const settled = context.ledger.getControl(request.operationId)
    if (settled !== undefined) {
      context.ledger.setControl(request.operationId, {
        ...settled,
        acknowledgement: Promise.resolve(acknowledgement),
        completion: Promise.resolve(structuredClone(context.currentState())),
      })
    }
  })()
  context.ledger.setControl(request.operationId, { ...existing, lateSettlement: task })
  await task
}

async function applyAcceptedCancellation(
  context: ControlPort,
  request: ControlEffectRequest,
  originalRun: import('../domain/state.js').BraidRun,
  status: 'cancelled' | 'aborted',
  acknowledgement: ControlAcknowledgement,
): Promise<void> {
  context.ledger.getAbort(request.runId)?.abort(new Error(request.reason ?? 'Cancelled'))
  const run = context.findRun(request.runId)
  const terminalReason = confirmedCancellationDetail(acknowledgement.detail)
  if (
    context.ledger.isCancellationPending(request.runId) &&
    (run.status === 'unknown' || run.status === 'failed')
  ) {
    const reconciled = context.commitAndWait({
      kind: 'run.reconciled',
      runId: request.runId,
      operationId: request.operationId,
      status,
      from: run.status,
      to: status,
      correction: 'cancellation-confirmed',
      evidence: canonicalDigest({
        kind: 'provider-cancellation-confirmed',
        operationId: request.operationId,
        runId: request.runId,
        outcome: acknowledgement.outcome,
        detail: acknowledgement.detail ?? null,
      }),
      detail: terminalReason,
    })
    if (reconciled !== undefined) await reconciled
  } else if (!context.isTerminal(run.status)) {
    const pendingText = context.streamSanitizer.finish(request.runId, 'text')
    const finished = context.commitAndWait({
      kind: 'run.finished',
      runId: request.runId,
      status,
      finalText: pendingText,
      ...(pendingText.length === 0 ? {} : { finalTextMode: 'append' as const }),
      usage: usageSnapshotForRun(originalRun),
      reason: terminalReason,
    })
    if (finished !== undefined) await finished
    context.streamSanitizer.reset(request.runId)
  }
  context.ledger.clearExplicitlyCancelled(request.runId)
  context.ledger.clearCancellationPending(request.runId)
  context.ledger.clearCancelStatus(request.runId)
}

function unknownEventWithPendingText(
  context: ControlPort,
  runId: string,
  detail: string,
): BraidEvent {
  const pendingText = context.streamSanitizer.finish(runId, 'text')
  return {
    kind: 'run.unknown',
    runId,
    detail,
    ...(pendingText.length === 0 ? {} : { pendingText }),
  }
}

function confirmedCancellationDetail(detail: string | undefined): string {
  return detail === undefined ||
    detail === 'CONTROL_ACKNOWLEDGED' ||
    detail === 'Provider cancellation acknowledged'
    ? 'Cancellation acknowledged by the provider'
    : detail
}

function unknownCancellationDetail(detail: string | undefined): string {
  return detail === undefined || detail.startsWith('CONTROL_')
    ? 'Cancellation outcome could not be confirmed by the provider'
    : detail
}

async function commitControlRequestBatch(
  context: ControlPort,
  events: readonly BraidEvent[],
): Promise<void> {
  if (context.commitBatchAndWait !== undefined) {
    await context.commitBatchAndWait(events)
    return
  }
  for (const event of events) {
    const durable = context.commitAndWait(event)
    if (durable !== undefined) await durable
  }
}

async function persistControlAcknowledgement(
  context: ControlPort,
  request: ControlEffectRequest,
  control: 'cancel' | 'steer' | 'detach',
  acknowledgement: ControlAcknowledgement,
): Promise<void> {
  const durable = context.commitAndWait({
    kind: 'run.control.acknowledged',
    runId: request.runId,
    operationId: request.operationId,
    control,
    outcome: acknowledgement.outcome,
    ...(acknowledgement.detail === undefined ? {} : { detail: acknowledgement.detail }),
  })
  if (durable !== undefined) await durable
}

async function existingControlReceipt(
  context: ControlPort,
  operationId: string,
  control: 'cancel' | 'steer' | 'detach',
  record: ControlOperationRecord,
): Promise<ControlReceipt> {
  const acknowledgement = await record.acknowledgement
  return {
    operationId,
    runId: record.runId,
    control,
    replayed: true,
    acknowledgement,
    status: context.findRun(record.runId).status,
    completion: record.completion,
  }
}
