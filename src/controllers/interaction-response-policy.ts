import type { InteractionResponse } from '@tangle-network/agent-interface'
import {
  answerSpecContainsSecret,
  interactionAnswerTypes,
  permissionScopeOffered,
  type NonSecretInteractionData,
  type InteractionOutcome,
} from '../domain/interaction.js'
import type {
  InteractionAck,
  InteractionResponseResult,
  RespondInteractionInput,
} from '../ports/interactions.js'
import type {
  InteractionCapabilities,
  InteractionQueueState,
  InteractionRecord,
  InteractionStatus,
} from '../domain/interaction-state.js'
import { interactionKey } from '../domain/interaction-state.js'

export function permissionGrant(data: NonSecretInteractionData): string | undefined {
  const grant = data.grant
  if (!Array.isArray(grant)) return undefined
  return grant.length === 1 ? grant[0] : undefined
}

export function bindingMatches(
  record: InteractionRecord,
  input: Pick<
    RespondInteractionInput,
    | 'providerSessionId'
    | 'profileDigest'
    | 'connectionId'
    | 'workspaceId'
    | 'conversationId'
    | 'branchId'
    | 'model'
    | 'runner'
    | 'requestRevision'
  >,
): boolean {
  return (
    record.providerSessionId === input.providerSessionId &&
    record.profileDigest === input.profileDigest &&
    record.connectionId === input.connectionId &&
    record.workspaceId === input.workspaceId &&
    record.conversationId === input.conversationId &&
    record.branchId === input.branchId &&
    record.model === input.model &&
    record.requestRevision === input.requestRevision &&
    record.runner === input.runner
  )
}

export function responseResult(
  input: RespondInteractionInput,
  status: InteractionResponseResult['status'],
  replayed: boolean,
  reason?: string,
): InteractionResponseResult {
  return {
    status,
    key: interactionKey(input.runId, input.interactionId),
    operationId: input.operationId,
    replayed,
    ...(reason === undefined ? {} : { reason }),
  }
}

export function statusFromAck(
  ack: InteractionAck,
  responseOutcome: InteractionResponse['outcome'],
): Extract<
  InteractionStatus,
  | 'resolved'
  | 'declined'
  | 'cancelled'
  | 'expired'
  | 'unknown'
  | 'conflict'
  | 'identity_conflict'
  | 'unsupported'
  | 'unknown_interaction'
  | 'unknown_run'
  | 'transport_error'
> {
  switch (ack.status) {
    case 'accepted':
      return outcomeStatus(responseOutcome)
    case 'already_resolved':
      if (ack.resolvedOutcome !== undefined && ack.resolvedOutcome !== responseOutcome)
        return 'conflict'
      return outcomeStatus(responseOutcome)
    case 'declined':
      return 'declined'
    case 'cancelled':
      return 'cancelled'
    case 'expired':
      return 'expired'
    case 'conflict':
      return 'conflict'
    case 'identity_conflict':
      return 'identity_conflict'
    case 'unsupported':
      return 'unsupported'
    case 'unknown_interaction':
      return 'unknown_interaction'
    case 'unknown_run':
      return 'unknown_run'
    case 'transport_error':
      return 'transport_error'
    default: {
      const exhaustive: never = ack.status
      return exhaustive
    }
  }
}

function outcomeStatus(outcome: InteractionOutcome): 'resolved' | 'declined' | 'cancelled' {
  return outcome === 'declined' ? 'declined' : outcome === 'cancelled' ? 'cancelled' : 'resolved'
}

export function acceptedCapabilityError(
  state: InteractionQueueState,
  record: InteractionRecord,
  response: InteractionResponse,
  publicData: NonSecretInteractionData,
  capabilities?: InteractionCapabilities,
): string | undefined {
  if (capabilities && !capabilities.responseIdempotency) {
    return 'This provider cannot safely replay interaction responses'
  }
  if (response.outcome !== 'accepted') return undefined
  if (!['question', 'permission', 'plan'].includes(record.request.kind)) {
    return 'This interaction kind is not supported by Braid'
  }
  if (record.request.kind === 'permission') {
    const grant = permissionGrant(publicData)
    const scope =
      grant === 'deny'
        ? 'deny'
        : grant === 'allow_once'
          ? 'once'
          : grant === 'allow_session'
            ? 'session'
            : grant === 'allow_always'
              ? 'persistent'
              : undefined
    if (!scope) return 'A permission response must select one offered scope'
    if (!permissionScopeOffered(record.request, scope)) {
      return 'The selected permission scope was not offered by the request'
    }
  }
  if (!capabilities) return undefined
  if (!capabilities.kinds.includes(record.request.kind)) {
    return `This provider does not support ${record.request.kind} interactions`
  }
  const unsupportedType = interactionAnswerTypes(record.request.answerSpec).find(
    (type) => !capabilities.answerTypes.includes(type),
  )
  if (unsupportedType) return `This provider does not support ${unsupportedType} answers`
  if (answerSpecContainsSecret(record.request.answerSpec) && !capabilities.secretAnswers) {
    return 'This provider cannot receive secret answers'
  }
  if (capabilities.concurrentRequests === false) {
    const active = state.interactions
      .filter(
        (interaction) => interaction.status === 'pending' || interaction.status === 'responding',
      )
      .sort((left, right) => left.arrivalSequence - right.arrivalSequence)
    if (active[0]?.key !== record.key) {
      return 'This provider accepts one interaction at a time; respond to the first request'
    }
  }
  if (record.request.kind === 'permission') {
    const grant = permissionGrant(publicData)
    const scope =
      grant === 'deny'
        ? 'deny'
        : grant === 'allow_once'
          ? 'once'
          : grant === 'allow_session'
            ? 'session'
            : grant === 'allow_always'
              ? 'persistent'
              : undefined
    if (!scope || !capabilities.scopes.includes(scope)) {
      return 'This provider does not support the selected permission scope'
    }
  }
  return undefined
}

export function ackIdentityError(
  ack: InteractionAck,
  record: InteractionRecord,
  input: RespondInteractionInput,
  requestDigest: string,
  responseDigest: string,
): string | undefined {
  if (ack.runId !== record.runId || ack.interactionId !== record.interactionId) {
    return 'Provider acknowledgement run or interaction identity does not match'
  }
  if (ack.operationId !== input.operationId)
    return 'Provider acknowledgement operation does not match'
  if ((ack.requestRevision ?? undefined) !== (record.requestRevision ?? undefined)) {
    return 'Provider acknowledgement request revision does not match'
  }
  if ((ack.providerSessionId ?? undefined) !== (record.providerSessionId ?? undefined)) {
    return 'Provider acknowledgement session does not match'
  }
  if ((ack.requestDigest ?? undefined) !== requestDigest) {
    return 'Provider acknowledgement request does not match'
  }
  if ((ack.responseDigest ?? undefined) !== responseDigest) {
    return 'Provider acknowledgement response does not match'
  }
  if ((ack.profileDigest ?? undefined) !== (record.profileDigest ?? undefined)) {
    return 'Provider acknowledgement profile does not match'
  }
  if ((ack.connectionId ?? undefined) !== (record.connectionId ?? undefined)) {
    return 'Provider acknowledgement connection does not match'
  }
  if ((ack.workspaceId ?? undefined) !== (record.workspaceId ?? undefined)) {
    return 'Provider acknowledgement workspace does not match'
  }
  if ((ack.conversationId ?? undefined) !== (record.conversationId ?? undefined)) {
    return 'Provider acknowledgement conversation does not match'
  }
  if ((ack.branchId ?? undefined) !== (record.branchId ?? undefined)) {
    return 'Provider acknowledgement branch does not match'
  }
  if ((ack.model ?? undefined) !== (record.model ?? undefined)) {
    return 'Provider acknowledgement model does not match'
  }
  if ((ack.runner ?? undefined) !== (record.runner ?? undefined)) {
    return 'Provider acknowledgement runner does not match'
  }
  return undefined
}

export function ackOutcomeError(
  ack: InteractionAck,
  responseOutcome: InteractionResponse['outcome'],
): string | undefined {
  if (
    (ack.status === 'accepted' || ack.status === 'already_resolved') &&
    ack.resolvedOutcome !== undefined &&
    ack.resolvedOutcome !== responseOutcome
  ) {
    return 'Provider acknowledgement outcome does not match the submitted response'
  }
  if (
    ack.status === 'declined' &&
    ack.resolvedOutcome !== undefined &&
    ack.resolvedOutcome !== 'declined'
  ) {
    return 'Provider acknowledgement outcome does not match declined status'
  }
  if (
    ack.status === 'cancelled' &&
    ack.resolvedOutcome !== undefined &&
    ack.resolvedOutcome !== 'cancelled'
  ) {
    return 'Provider acknowledgement outcome does not match cancelled status'
  }
  return undefined
}
