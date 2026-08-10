import type { EffectStatus } from '../ports/effect-storage.js'
import type {
  CancelRunResult,
  ControlAcknowledgement,
  ExecutionPort,
  ProviderRunSnapshot,
} from '../ports/execution.js'
import type { ControlDispatchOptions, ControlEffectRequest } from './application-ports.js'
import type { SerializedEffectCoordinator } from './effect-coordinator.js'
import { safeDiagnostic } from './provider-values.js'

export async function executeControlEffect(input: {
  readonly effects: SerializedEffectCoordinator
  readonly execution: ExecutionPort
  readonly request: ControlEffectRequest
  readonly owner: string
  readonly timeoutMs: number
  readonly whenDurable: () => Promise<void>
  readonly canSettleLate?: () => boolean
  readonly onLateSettlement?: ControlDispatchOptions['onLateSettlement']
}): Promise<ControlAcknowledgement> {
  const { request } = input
  let providerResult: Promise<ControlAcknowledgement> | undefined
  let foregroundTimedOut = false
  const effect = input.effects.start(
    {
      operationId: request.operationId,
      effectKind: `run.control.${request.control}`,
      request: {
        ...request,
        providerSessionId: request.providerSessionId ?? null,
        reason: request.reason ?? null,
        text: request.text ?? null,
        cursor: request.cursor ?? null,
      },
      serializationKey: `run:${request.runId}:control`,
      metadata: {
        runId: request.runId,
        control: request.control,
        owner: input.owner,
        leaseExpiresAt: new Date(Date.now() + input.timeoutMs).toISOString(),
      },
    },
    {
      dispatch: async () => {
        const controller = new AbortController()
        providerResult = dispatchControl(input.execution, request, controller.signal)
        const result = await controlDeadline(providerResult, controller, input.timeoutMs)
        foregroundTimedOut = result.timedOut
        return effectResult(result.acknowledgement)
      },
      reconcile: async () => reconcileControl(input.execution, request),
    },
  )
  const record = await effect.completion
  await input.whenDurable()
  if (foregroundTimedOut && providerResult !== undefined && input.onLateSettlement !== undefined) {
    const lateResult = providerResult
    void lateResult
      .then(async (acknowledgement) => {
        if (input.canSettleLate?.() === false) return
        const settled = input.effects.settle(
          effect.operationId,
          effect.requestDigest,
          effectResult(acknowledgement),
        )
        if (settled !== undefined) await input.whenDurable()
        if (input.canSettleLate?.() === false) return
        await input.onLateSettlement?.(acknowledgement)
      })
      .catch(() => undefined)
  }
  return acknowledgementFromEffect(request.operationId, record.status, record.detail)
}

async function dispatchControl(
  execution: ExecutionPort,
  request: ControlEffectRequest,
  signal: AbortSignal,
): Promise<ControlAcknowledgement> {
  try {
    if (request.control === 'cancel') {
      if (!execution.cancelRun)
        return unknown(request.operationId, 'CONTROL_CANCELLATION_UNCONFIRMED')
      return normalize(
        request.operationId,
        await execution.cancelRun({
          runId: request.runId,
          operationId: request.operationId,
          signal,
          ...(request.reason === undefined ? {} : { reason: request.reason }),
        }),
      )
    }
    if (request.control === 'steer') {
      if (!execution.steerRun) return unknown(request.operationId, 'CONTROL_STEERING_UNCONFIRMED')
      return execution.steerRun({
        runId: request.runId,
        operationId: request.operationId,
        text: request.text ?? '',
        signal,
      })
    }
    if (!execution.detachRun) return unknown(request.operationId, 'CONTROL_DETACH_UNCONFIRMED')
    return execution.detachRun({
      runId: request.runId,
      operationId: request.operationId,
      signal,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    })
  } catch {
    return unknown(request.operationId, 'CONTROL_DISPATCH_UNKNOWN')
  }
}

async function reconcileControl(
  execution: ExecutionPort,
  request: ControlEffectRequest,
): Promise<{ readonly status: 'terminal'; readonly detail: string } | undefined> {
  if (request.control === 'steer' || !execution.status) return undefined
  let snapshot: ProviderRunSnapshot | null
  try {
    snapshot = await execution.status({ runId: request.runId })
  } catch {
    return undefined
  }
  if (
    !snapshot ||
    snapshot.runId !== request.runId ||
    (request.providerSessionId !== undefined && snapshot.sessionId !== request.providerSessionId)
  )
    return undefined
  if (request.control === 'cancel' && !['aborted', 'cancelled'].includes(snapshot.status))
    return undefined
  if (request.control === 'detach' && snapshot.status !== 'detached') return undefined
  if (!providerTerminal(snapshot.status)) return undefined
  return { status: 'terminal', detail: 'CONTROL_RECONCILED_TERMINAL' }
}

function effectResult(value: ControlAcknowledgement) {
  if (value.outcome === 'accepted')
    return {
      status: 'acknowledged' as const,
      detail: safeDiagnostic(value.detail, 'CONTROL_ACKNOWLEDGED'),
    }
  if (value.outcome === 'already-applied')
    return { status: 'terminal' as const, detail: 'CONTROL_ALREADY_APPLIED' }
  if (value.outcome === 'rejected') return { status: 'failed' as const, detail: 'CONTROL_REJECTED' }
  return { status: 'unknown' as const, detail: 'CONTROL_OUTCOME_UNKNOWN' }
}

function acknowledgementFromEffect(
  operationId: string,
  status: EffectStatus,
  detail: string | undefined,
): ControlAcknowledgement {
  if (status === 'acknowledged')
    return { operationId, outcome: 'accepted', ...(detail ? { detail } : {}) }
  if (status === 'terminal')
    return { operationId, outcome: 'already-applied', ...(detail ? { detail } : {}) }
  if (status === 'failed') return { operationId, outcome: 'rejected', detail: 'CONTROL_REJECTED' }
  return { operationId, outcome: 'unknown', detail: 'CONTROL_OUTCOME_UNKNOWN' }
}

function normalize(
  operationId: string,
  value: ControlAcknowledgement | CancelRunResult,
): ControlAcknowledgement {
  if ('outcome' in value)
    return {
      operationId,
      outcome: value.outcome,
      ...(value.detail === undefined
        ? {}
        : { detail: safeDiagnostic(value.detail, 'CONTROL_DETAIL') }),
    }
  return value.status === 'cancelled'
    ? { operationId, outcome: 'accepted' }
    : {
        operationId,
        outcome: 'unknown',
        detail: safeDiagnostic(value.reason, 'CONTROL_OUTCOME_UNKNOWN'),
      }
}

function unknown(operationId: string, detail: string): ControlAcknowledgement {
  return { operationId, outcome: 'unknown', detail }
}

async function controlDeadline(
  action: Promise<ControlAcknowledgement>,
  controller: AbortController,
  timeoutMs: number,
): Promise<{ readonly acknowledgement: ControlAcknowledgement; readonly timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const timeout = new Promise<ControlAcknowledgement>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('Control acknowledgement deadline elapsed'))
      resolve({
        operationId: 'unknown',
        outcome: 'unknown',
        detail: 'CONTROL_ACKNOWLEDGEMENT_TIMEOUT',
      })
    }, timeoutMs)
  })
  const acknowledgement = await Promise.race([action, timeout])
  if (timer !== undefined) clearTimeout(timer)
  return { acknowledgement, timedOut }
}

function providerTerminal(status: ProviderRunSnapshot['status']): boolean {
  return ['completed', 'failed', 'aborted', 'cancelled', 'blocked', 'expired'].includes(status)
}
