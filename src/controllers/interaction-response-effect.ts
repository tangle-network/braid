import { redactSensitiveText } from '../domain/bounds.js'
import {
  answerSpecContainsSecret,
  interactionRequestDigest,
  interactionResponseFingerprint,
  type validateInteractionData,
} from '../domain/interaction.js'
import type { InteractionRecord } from '../domain/interaction-state.js'
import type { Clock } from '../ports/clock.js'
import type {
  InteractionAck,
  InteractionResponseResult,
  InteractionRuntimePort,
  RespondInteractionInput,
} from '../ports/interactions.js'
import type { IdSource } from '../ports/ids.js'
import {
  ackIdentityError,
  ackOutcomeError,
  responseResult,
  statusFromAck,
} from './interaction-response-policy.js'
import { bindingForRecord } from './interaction-controller-utils.js'
import { recordInteractionFeedback } from './interaction-feedback.js'
import { eraseEphemeralResponse, ephemeralResponse } from './interaction-ephemeral-response.js'
import type { InteractionPersistence } from './interaction-persistence.js'

export async function performInteractionResponse(options: {
  readonly persistence: InteractionPersistence
  readonly runtime: InteractionRuntimePort
  readonly clock: Clock
  readonly ids: IdSource
  readonly feedbackCaptureEnabled: boolean
  readonly automationRuleFor: (key: string) => string | undefined
  readonly clearTimeout: (key: string) => void
  readonly secretKey: string | Uint8Array
  readonly record: InteractionRecord
  readonly input: RespondInteractionInput
  readonly validation: Extract<ReturnType<typeof validateInteractionData>, { readonly ok: true }>
  readonly automated: boolean
}): Promise<InteractionResponseResult> {
  const {
    persistence,
    runtime,
    clock,
    ids,
    feedbackCaptureEnabled,
    automationRuleFor,
    clearTimeout,
    secretKey,
    record,
    input,
    validation,
    automated,
  } = options
  const requestDigest = record.requestDigest ?? interactionRequestDigest(record.request)
  const responseDigest = interactionResponseFingerprint(record.request, input.response, secretKey)
  const persistedPublicData = validation.containsSecret ? {} : validation.publicData
  const secretResponse = answerSpecContainsSecret(record.request.answerSpec)
  persistence.commit({
    kind: 'interaction.response.requested',
    key: record.key,
    runId: record.runId,
    interactionId: record.interactionId,
    operationId: input.operationId,
    outcome: input.response.outcome,
    ...(record.requestRevision === undefined ? {} : { requestRevision: record.requestRevision }),
    requestDigest,
    responseDigest,
    ...(record.providerSessionId === undefined
      ? {}
      : { providerSessionId: record.providerSessionId }),
    ...(record.profileDigest === undefined ? {} : { profileDigest: record.profileDigest }),
    ...(record.connectionId === undefined ? {} : { connectionId: record.connectionId }),
    ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
    ...(record.conversationId === undefined ? {} : { conversationId: record.conversationId }),
    ...(record.branchId === undefined ? {} : { branchId: record.branchId }),
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(record.runner === undefined ? {} : { runner: record.runner }),
    ...(Object.keys(persistedPublicData).length === 0 ? {} : { publicData: persistedPublicData }),
    ...(validation.dataDigest === undefined ? {} : { dataDigest: validation.dataDigest }),
    containsSecret: validation.containsSecret,
  })

  let ack: InteractionAck
  const providerResponse = ephemeralResponse(input.response)
  try {
    ack = await runtime.respondToInteraction({
      ...bindingForRecord(record),
      response: providerResponse,
      operationId: input.operationId,
      requestDigest,
      responseDigest,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
  } catch {
    ack = {
      status: 'transport_error',
      ...bindingForRecord(record),
      operationId: input.operationId,
      requestDigest,
      responseDigest,
      reason: 'The provider did not acknowledge the interaction response',
    }
  } finally {
    eraseEphemeralResponse(providerResponse)
  }

  const identityError = ackIdentityError(ack, record, input, requestDigest, responseDigest)
  if (identityError) {
    clearTimeout(record.key)
    persistence.commit({
      kind: 'interaction.resolved',
      key: record.key,
      status: 'identity_conflict',
      reason: identityError,
    })
    return responseResult(input, 'identity_conflict', false, identityError)
  }
  const outcomeError = ackOutcomeError(ack, input.response.outcome)
  if (outcomeError) {
    clearTimeout(record.key)
    persistence.commit({
      kind: 'interaction.resolved',
      key: record.key,
      status: 'conflict',
      reason: outcomeError,
    })
    return responseResult(input, 'conflict', false, outcomeError)
  }
  if (ack.status === 'already_resolved' && ack.resolvedOutcome === undefined) {
    const reason = 'Provider reconciliation omitted the durable response outcome'
    clearTimeout(record.key)
    persistence.commit({
      kind: 'interaction.resolved',
      key: record.key,
      status: 'identity_conflict',
      reason,
    })
    return responseResult(input, 'identity_conflict', false, reason)
  }

  const outcomeStatus = statusFromAck(ack, input.response.outcome)
  if (
    outcomeStatus === 'conflict' ||
    outcomeStatus === 'identity_conflict' ||
    outcomeStatus === 'unsupported' ||
    outcomeStatus === 'unknown' ||
    outcomeStatus === 'unknown_interaction' ||
    outcomeStatus === 'unknown_run' ||
    outcomeStatus === 'transport_error'
  ) {
    const reason = secretResponse
      ? 'The provider did not expose a safe response outcome'
      : redactSensitiveText(ack.reason ?? 'The provider response outcome is unknown')
    clearTimeout(record.key)
    persistence.commit({
      kind: 'interaction.resolved',
      key: record.key,
      status: outcomeStatus,
      reason,
    })
    return responseResult(input, outcomeStatus, false, reason)
  }

  const resolutionOutcome =
    ack.status === 'declined'
      ? 'declined'
      : ack.status === 'cancelled'
        ? 'cancelled'
        : (ack.resolvedOutcome ?? input.response.outcome)
  const resolution =
    outcomeStatus === 'expired'
      ? undefined
      : {
          outcome: resolutionOutcome,
          operationId: input.operationId,
          responseDigest,
          ...(Object.keys(persistedPublicData).length === 0
            ? {}
            : { publicData: persistedPublicData }),
          ...(validation.dataDigest === undefined ? {} : { dataDigest: validation.dataDigest }),
          containsSecret: validation.containsSecret,
          resolvedAt: clock.now(),
        }
  persistence.commit({
    kind: 'interaction.resolved',
    key: record.key,
    status: outcomeStatus,
    ...(resolution === undefined ? {} : { resolution }),
  })
  clearTimeout(record.key)
  if (
    outcomeStatus === 'resolved' ||
    outcomeStatus === 'declined' ||
    outcomeStatus === 'cancelled'
  ) {
    recordInteractionFeedback({
      persistence,
      clock,
      ids,
      enabled: feedbackCaptureEnabled,
      record,
      outcome: resolutionOutcome,
      automated,
      ...(validation.dataDigest === undefined ? {} : { dataDigest: validation.dataDigest }),
      publicData: validation.publicData,
    })
  }
  const ruleId = automated ? automationRuleFor(record.key) : undefined
  if (ruleId && outcomeStatus === 'resolved') {
    persistence.commit({
      kind: 'automation.rule.applied',
      ruleId,
      audit: {
        id: ids.next('audit'),
        interactionKey: record.key,
        ruleId,
        kind: record.request.kind,
        outcome: 'applied',
        createdAt: clock.now(),
      },
    })
  } else if (ruleId) {
    persistence.commit({
      kind: 'automation.audit.recorded',
      audit: {
        id: ids.next('audit'),
        interactionKey: record.key,
        ruleId,
        kind: record.request.kind,
        outcome: 'skipped',
        reason: `Provider outcome was ${ack.status}`,
        createdAt: clock.now(),
      },
    })
  }
  return finalResponseResult(input, ack.status)
}

function finalResponseResult(
  input: RespondInteractionInput,
  status: InteractionAck['status'],
): InteractionResponseResult {
  if (status === 'unknown_interaction') return responseResult(input, 'unknown_interaction', false)
  if (status === 'unknown_run') return responseResult(input, 'unknown_run', false)
  if (status === 'declined') return responseResult(input, 'declined', false)
  if (status === 'cancelled') return responseResult(input, 'cancelled', false)
  if (status === 'expired') return responseResult(input, 'expired', false)
  if (status === 'already_resolved') return responseResult(input, 'already_resolved', false)
  return responseResult(
    input,
    input.response.outcome === 'declined'
      ? 'declined'
      : input.response.outcome === 'cancelled'
        ? 'cancelled'
        : 'accepted',
    false,
  )
}
