import type { Clock } from '../ports/clock.js'
import type {
  InteractionResponseResult,
  InteractionRuntimePort,
  RespondInteractionInput,
} from '../ports/interactions.js'
import type { InteractionRecord } from '../domain/interaction-state.js'
import { answerSpecContainsSecret } from '../domain/interaction.js'
import { redactSensitiveText } from '../domain/bounds.js'
import type { InteractionPersistence } from './interaction-persistence.js'
import { bindingForRecord } from './interaction-controller-utils.js'
import { responseResult } from './interaction-response-policy.js'

type ReconciliationResult = Awaited<
  ReturnType<NonNullable<InteractionRuntimePort['reconcileInteraction']>>
>

export async function reconcilePendingResponse(options: {
  readonly persistence: InteractionPersistence
  readonly runtime: InteractionRuntimePort
  readonly clock: Clock
  readonly clearTimeout: (key: string) => void
  readonly record: InteractionRecord
  readonly input: RespondInteractionInput
  readonly pending: NonNullable<InteractionRecord['pendingResponse']>
}): Promise<InteractionResponseResult> {
  const { persistence, runtime, clock, clearTimeout, record, input, pending } = options
  if (!runtime.reconcileInteraction) {
    return responseResult(
      input,
      'transport_error',
      false,
      'The provider cannot reconcile a pending response',
    )
  }
  let result: ReconciliationResult
  try {
    result = await runtime.reconcileInteraction({
      ...bindingForRecord(record),
      operationId: pending.operationId,
      requestDigest: pending.requestDigest,
      responseDigest: pending.responseDigest,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
  } catch {
    return responseResult(input, 'transport_error', false, 'Provider reconciliation failed')
  }
  const identityError = reconciliationIdentityError(result, record, pending)
  if (identityError) {
    persistence.commit({
      kind: 'interaction.resolved',
      key: record.key,
      status: 'identity_conflict',
      reason: identityError,
    })
    return responseResult(input, 'identity_conflict', false, identityError)
  }
  if (result.status === 'pending') {
    return responseResult(input, 'transport_error', false, 'Provider response remains unknown')
  }
  if (result.status === 'resolved' && result.outcome === undefined) {
    const reason = 'Provider reconciliation omitted the durable response outcome'
    persistence.commit({
      kind: 'interaction.resolved',
      key: record.key,
      status: 'identity_conflict',
      reason,
    })
    return responseResult(input, 'identity_conflict', false, reason)
  }
  const status = reconciliationStatus(result)
  const safeReason = answerSpecContainsSecret(record.request.answerSpec)
    ? undefined
    : result.reason === undefined
      ? undefined
      : redactSensitiveText(result.reason)
  const resolvedOutcome = result.status === 'resolved' ? result.outcome : undefined
  const resolutionOutcome =
    result.status === 'cancelled' ? 'cancelled' : (resolvedOutcome ?? pending.outcome)
  const resolution =
    status === 'expired' || status.startsWith('unknown') || status === 'transport_error'
      ? undefined
      : {
          outcome: resolutionOutcome,
          operationId: pending.operationId,
          responseDigest: pending.responseDigest,
          containsSecret: record.request.answerSpec.fields.some((field) => field.type === 'secret'),
          resolvedAt: clock.now(),
        }
  persistence.commit({
    kind: 'interaction.resolved',
    key: record.key,
    status,
    ...(resolution === undefined ? {} : { resolution }),
    ...(safeReason === undefined ? {} : { reason: safeReason }),
  })
  clearTimeout(record.key)
  const responseStatus: InteractionResponseResult['status'] =
    status === 'resolved' ? 'accepted' : status === 'transport_error' ? 'transport_error' : status
  return responseResult(input, responseStatus, false, safeReason)
}

function reconciliationIdentityError(
  result: ReconciliationResult,
  record: InteractionRecord,
  pending: NonNullable<InteractionRecord['pendingResponse']>,
): string | undefined {
  if (result.runId !== record.runId) {
    return 'Provider reconciliation run does not match'
  }
  if (result.interactionId !== record.interactionId) {
    return 'Provider reconciliation interaction does not match'
  }
  if ((result.requestRevision ?? undefined) !== (record.requestRevision ?? undefined)) {
    return 'Provider reconciliation request revision does not match'
  }
  if (
    (result.requestRevision ?? undefined) !== (pending.requestRevision ?? record.requestRevision)
  ) {
    return 'Provider reconciliation request revision does not match'
  }
  if ((result.providerSessionId ?? undefined) !== (record.providerSessionId ?? undefined)) {
    return 'Provider reconciliation session does not match'
  }
  if ((result.profileDigest ?? undefined) !== (record.profileDigest ?? undefined)) {
    return 'Provider reconciliation profile does not match'
  }
  if ((result.connectionId ?? undefined) !== (record.connectionId ?? undefined)) {
    return 'Provider reconciliation connection does not match'
  }
  if ((result.workspaceId ?? undefined) !== (record.workspaceId ?? undefined)) {
    return 'Provider reconciliation workspace does not match'
  }
  if ((result.conversationId ?? undefined) !== (record.conversationId ?? undefined)) {
    return 'Provider reconciliation conversation does not match'
  }
  if ((result.branchId ?? undefined) !== (record.branchId ?? undefined)) {
    return 'Provider reconciliation branch does not match'
  }
  if ((result.model ?? undefined) !== (record.model ?? undefined)) {
    return 'Provider reconciliation model does not match'
  }
  if ((result.runner ?? undefined) !== (record.runner ?? undefined)) {
    return 'Provider reconciliation runner does not match'
  }
  if (result.operationId !== pending.operationId) {
    return 'Provider reconciliation operation does not match'
  }
  if (result.requestDigest !== pending.requestDigest) {
    return 'Provider reconciliation request does not match'
  }
  if (result.responseDigest !== pending.responseDigest) {
    return 'Provider reconciliation response does not match'
  }
  return undefined
}

function reconciliationStatus(result: ReconciliationResult) {
  if (result.status === 'resolved') {
    return result.outcome === 'declined'
      ? 'declined'
      : result.outcome === 'cancelled'
        ? 'cancelled'
        : 'resolved'
  }
  if (result.status === 'expired' || result.status === 'cancelled') return result.status
  if (result.status === 'unknown_interaction' || result.status === 'unknown_run') {
    return result.status
  }
  if (result.status === 'unknown') return 'unknown'
  if (result.status === 'missing') return 'unknown'
  return 'transport_error'
}
