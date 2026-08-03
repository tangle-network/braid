import type { InteractionResponse } from '@tangle-network/agent-interface'
import type {
  InteractionAck,
  InteractionCapabilities,
  InteractionRuntimePort,
  ReconciledInteraction,
  RespondToInteractionPortInput,
} from '../ports/interactions.js'

interface ProviderResolution {
  readonly key: string
  readonly outcome: InteractionResponse['outcome']
  readonly operationId: string
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
    this.#pending.add(`${runId}:${interactionId}`)
  }

  resolveExternally(
    runId: string,
    interactionId: string,
    outcome: InteractionResponse['outcome'] = 'accepted',
  ): void {
    const key = `${runId}:${interactionId}`
    this.#pending.delete(key)
    this.#resolutions.set(key, { key, operationId: 'external', outcome })
  }

  async respondToInteraction(input: RespondToInteractionPortInput): Promise<InteractionAck> {
    const key = `${input.runId}:${input.interactionId}`
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
    const resolution: ProviderResolution = {
      key,
      operationId: input.operationId,
      outcome: input.response.outcome,
    }
    this.#operations.set(input.operationId, resolution)
    this.#resolutions.set(key, resolution)
    this.#pending.delete(key)
    this.calls = [
      ...this.calls,
      { key, operationId: input.operationId, outcome: input.response.outcome },
    ]
    return this.#ack(input, this.#options.responseStatus ?? 'accepted')
  }

  async reconcileInteraction(input: {
    readonly runId: string
    readonly interactionId: string
    readonly providerSessionId?: string
  }): Promise<ReconciledInteraction> {
    const key = `${input.runId}:${input.interactionId}`
    if (this.#pending.has(key)) return { status: 'pending' }
    const resolution = this.#resolutions.get(key)
    if (resolution) return { status: 'resolved', outcome: resolution.outcome }
    return { status: 'missing' }
  }

  #ack(input: RespondToInteractionPortInput, status: InteractionAck['status']): InteractionAck {
    return {
      status,
      runId: input.runId,
      interactionId: input.interactionId,
      operationId: input.operationId,
      ...(this.#options.responseReason === undefined
        ? {}
        : { reason: this.#options.responseReason }),
    }
  }
}
