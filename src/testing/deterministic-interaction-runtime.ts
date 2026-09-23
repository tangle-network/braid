import type { InteractionResponse } from '@tangle-network/agent-interface'
import type {
  InteractionAck,
  InteractionCapabilities,
  InteractionRuntimePort,
  ReconcileInteractionInput,
  ReconciledInteraction,
  RespondToInteractionPortInput,
} from '../ports/interactions.js'
import { interactionKey } from '../domain/interaction-state.js'

interface ProviderResolution {
  readonly key: string
  readonly outcome: InteractionResponse['outcome']
  readonly operationId: string
  readonly providerSessionId?: string
  readonly requestDigest?: string
  readonly responseDigest?: string
}

export interface DeterministicInteractionRuntimeOptions {
  readonly responseStatus?: InteractionAck['status']
  readonly responseReason?: string
  readonly capabilities?: InteractionCapabilities
}

/**
 * A provider-shaped test port. It records identities and outcomes only; it
 * intentionally never retains the response data, including secret fields.
 */
export class DeterministicInteractionRuntime implements InteractionRuntimePort {
  readonly capabilities: InteractionCapabilities
  readonly #defaultCapabilities: InteractionCapabilities = {
    kinds: ['question', 'permission', 'plan'],
    answerTypes: ['text', 'number', 'boolean', 'select', 'secret'] as const,
    scopes: ['once', 'session', 'persistent', 'deny'] as const,
    secretAnswers: true,
    concurrentRequests: true,
    replay: true,
    responseIdempotency: true,
  }
  calls: {
    readonly key: string
    readonly operationId: string
    readonly outcome: InteractionResponse['outcome']
  }[] = []
  readonly #pending = new Set<string>()
  readonly #resolutions = new Map<string, ProviderResolution>()
  readonly #operations = new Map<string, ProviderResolution>()
  readonly #options: DeterministicInteractionRuntimeOptions

  constructor(options: DeterministicInteractionRuntimeOptions = {}) {
    this.#options = options
    this.capabilities = options.capabilities ?? this.#defaultCapabilities
  }

  registerPending(runId: string, interactionId: string): void {
    this.#pending.add(interactionKey(runId, interactionId))
  }

  resolveExternally(
    runId: string,
    interactionId: string,
    outcome: InteractionResponse['outcome'] = 'accepted',
  ): void {
    const key = interactionKey(runId, interactionId)
    this.#pending.delete(key)
    this.#resolutions.set(key, { key, operationId: 'external', outcome })
  }

  async respondToInteraction(input: RespondToInteractionPortInput): Promise<InteractionAck> {
    const key = interactionKey(input.runId, input.interactionId)
    const previousOperation = this.#operations.get(input.operationId)
    if (previousOperation) {
      return {
        ...this.#ack(input, 'already_resolved'),
        resolvedOutcome: previousOperation.outcome,
      }
    }
    if (!this.#pending.has(key) && !this.#resolutions.has(key)) {
      return this.#ack(input, 'unknown_interaction')
    }
    const prior = this.#resolutions.get(key)
    if (prior) {
      return {
        ...this.#ack(
          input,
          prior.outcome === input.response.outcome ? 'already_resolved' : 'conflict',
        ),
        ...(prior.outcome === input.response.outcome ? { resolvedOutcome: prior.outcome } : {}),
      }
    }
    const status = this.#options.responseStatus ?? 'accepted'
    if (status !== 'accepted') return this.#ack(input, status)
    const resolution: ProviderResolution = {
      key,
      operationId: input.operationId,
      outcome: input.response.outcome,
      ...(input.providerSessionId === undefined
        ? {}
        : { providerSessionId: input.providerSessionId }),
      ...(input.requestDigest === undefined ? {} : { requestDigest: input.requestDigest }),
      ...(input.responseDigest === undefined ? {} : { responseDigest: input.responseDigest }),
    }
    this.#operations.set(input.operationId, resolution)
    this.#resolutions.set(key, resolution)
    this.#pending.delete(key)
    this.calls = [
      ...this.calls,
      { key, operationId: input.operationId, outcome: input.response.outcome },
    ]
    return this.#ack(input, status)
  }

  async reconcileInteraction(input: ReconcileInteractionInput): Promise<ReconciledInteraction> {
    const key = interactionKey(input.runId, input.interactionId)
    if (this.#pending.has(key)) {
      return {
        status: 'pending',
        ...identityFor(input),
        ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
      }
    }
    const resolution = this.#resolutions.get(key)
    if (resolution) {
      return {
        status: 'resolved',
        ...identityFor(input),
        ...(resolution.providerSessionId === undefined
          ? {}
          : { providerSessionId: resolution.providerSessionId }),
        operationId: resolution.operationId,
        ...(resolution.requestDigest === undefined
          ? {}
          : { requestDigest: resolution.requestDigest }),
        ...(resolution.responseDigest === undefined
          ? {}
          : { responseDigest: resolution.responseDigest }),
        outcome: resolution.outcome,
      }
    }
    return {
      status: 'missing',
      ...identityFor(input),
      ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    }
  }

  #ack(input: RespondToInteractionPortInput, status: InteractionAck['status']): InteractionAck {
    return {
      status,
      ...identityFor(input),
      operationId: input.operationId,
      ...(this.#options.responseReason === undefined
        ? {}
        : { reason: this.#options.responseReason }),
    }
  }
}

type BindingInput = Pick<
  RespondToInteractionPortInput | ReconcileInteractionInput,
  | 'runId'
  | 'interactionId'
  | 'providerSessionId'
  | 'profileDigest'
  | 'connectionId'
  | 'workspaceId'
  | 'conversationId'
  | 'branchId'
  | 'model'
  | 'runner'
  | 'requestRevision'
  | 'requestDigest'
  | 'responseDigest'
>

function identityFor(input: BindingInput) {
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
