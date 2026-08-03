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

export function permissionGrant(data: NonSecretInteractionData): string | undefined {
  const grant = data.grant
  if (!Array.isArray(grant)) return undefined
  return grant.length === 1 ? grant[0] : undefined
}

export function bindingMatches(
  record: InteractionRecord,
  input: Pick<
    RespondInteractionInput,
    'providerSessionId' | 'profileDigest' | 'connectionId' | 'workspaceId' | 'runner'
  >,
): boolean {
  return (
    record.providerSessionId === input.providerSessionId &&
    record.profileDigest === input.profileDigest &&
    record.connectionId === input.connectionId &&
    record.workspaceId === input.workspaceId &&
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
    key: `${input.runId}:${input.interactionId}`,
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
  'resolved' | 'declined' | 'cancelled' | 'expired' | 'unknown' | 'conflict'
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
    case 'unknown_interaction':
    case 'unknown_run':
    case 'transport_error':
      return 'unknown'
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
  if (response.outcome !== 'accepted') return undefined
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
