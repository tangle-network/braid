import type {
  InteractionAck,
  InteractionCapabilities,
  InteractionRuntimePort,
  ReconcileInteractionInput,
  ReconciledInteraction,
  RespondToInteractionPortInput,
} from '../../ports/interactions.js'

export class UnavailableInteractionRuntime implements InteractionRuntimePort {
  readonly capabilities: InteractionCapabilities = {
    kinds: [],
    answerTypes: [],
    scopes: ['deny'],
    secretAnswers: false,
    concurrentRequests: false,
    replay: false,
    responseIdempotency: false,
  }

  async respondToInteraction(input: RespondToInteractionPortInput): Promise<InteractionAck> {
    return {
      status: 'transport_error',
      ...identityFor(input),
      operationId: input.operationId,
      reason: 'The selected runtime does not expose interaction responses',
    }
  }

  async reconcileInteraction(input: ReconcileInteractionInput): Promise<ReconciledInteraction> {
    return {
      status: 'unknown',
      ...identityFor(input),
      ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
      reason: 'The selected runtime does not expose interaction reconciliation',
    }
  }
}

function identityFor(input: RespondToInteractionPortInput | ReconcileInteractionInput) {
  return {
    runId: input.runId,
    interactionId: input.interactionId,
    ...(input.profileDigest === undefined ? {} : { profileDigest: input.profileDigest }),
    ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    ...(input.branchId === undefined ? {} : { branchId: input.branchId }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.runner === undefined ? {} : { runner: input.runner }),
    ...(input.requestRevision === undefined ? {} : { requestRevision: input.requestRevision }),
    ...(input.providerSessionId === undefined
      ? {}
      : { providerSessionId: input.providerSessionId }),
    ...(input.requestDigest === undefined ? {} : { requestDigest: input.requestDigest }),
    ...(input.responseDigest === undefined ? {} : { responseDigest: input.responseDigest }),
  }
}
