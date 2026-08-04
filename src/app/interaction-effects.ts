import type { InteractionResponse } from '@tangle-network/agent-interface'
import type { ControlAcknowledgement, ExecutionPort } from '../ports/execution.js'
import type { SerializedEffectCoordinator } from './effect-coordinator.js'

export interface InteractionEffectRequest {
  readonly operationId: string
  readonly runId: string
  readonly interactionId: string
  readonly response: InteractionResponse
}

export async function executeInteractionEffect(input: {
  readonly effects: SerializedEffectCoordinator
  readonly execution: ExecutionPort
  readonly request: InteractionEffectRequest
  readonly owner: string
  readonly whenDurable: () => Promise<void>
}): Promise<ControlAcknowledgement> {
  const { request } = input
  const effect = input.effects.start(
    {
      operationId: request.operationId,
      effectKind: 'interaction.respond',
      request,
      serializationKey: `run:${request.runId}:interaction`,
      metadata: {
        runId: request.runId,
        interactionId: request.interactionId,
        owner: input.owner,
      },
    },
    {
      dispatch: async () => {
        return dispatchResponse(input.execution, request)
      },
      reconcile: async () => dispatchResponse(input.execution, request),
    },
  )
  const record = await effect.completion
  await input.whenDurable()
  if (record.status === 'acknowledged' || record.status === 'terminal') {
    return {
      operationId: request.operationId,
      outcome: record.status === 'terminal' ? 'already-applied' : 'accepted',
      ...(record.detail === undefined ? {} : { detail: record.detail }),
    }
  }
  if (record.status === 'failed') {
    return {
      operationId: request.operationId,
      outcome: 'rejected',
      detail: 'INTERACTION_RESPONSE_REJECTED',
    }
  }
  return {
    operationId: request.operationId,
    outcome: 'unknown',
    detail: 'INTERACTION_RESPONSE_UNKNOWN',
  }
}

async function dispatchResponse(
  execution: ExecutionPort,
  request: InteractionEffectRequest,
): Promise<{
  readonly status: 'acknowledged' | 'failed' | 'unknown'
  readonly detail: string
}> {
  if (!execution.respondInteraction)
    return { status: 'unknown', detail: 'INTERACTION_RESPONSE_UNAVAILABLE' }
  try {
    const result = await execution.respondInteraction(request)
    if (result.outcome === 'accepted' || result.outcome === 'already-applied') {
      return {
        status: 'acknowledged',
        detail: result.detail ?? 'INTERACTION_RESPONSE_ACCEPTED',
      }
    }
    if (result.outcome === 'rejected') {
      return {
        status: 'failed',
        detail: interactionDetail(result.detail, 'INTERACTION_RESPONSE_REJECTED'),
      }
    }
    return {
      status: 'unknown',
      detail: interactionDetail(result.detail, 'INTERACTION_RESPONSE_UNKNOWN'),
    }
  } catch {
    return { status: 'unknown', detail: 'INTERACTION_RESPONSE_UNKNOWN' }
  }
}

function interactionDetail(value: string | undefined, fallback: string): string {
  return value !== undefined && /^INTERACTION_[A-Z0-9_]{1,96}$/u.test(value) ? value : fallback
}
