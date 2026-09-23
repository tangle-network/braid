import { canonicalDigest } from '../domain/canonical.js'
import {
  answerSpecContainsSecret,
  interactionRequestDigest,
  parseInteractionRequest,
} from '../domain/interaction.js'
import {
  interactionKey,
  type InteractionRecord,
  type InteractionQueueState,
} from '../domain/interaction-state.js'
import type { Clock } from '../ports/clock.js'
import type { InteractionReceiveResult, ReceiveInteractionInput } from '../ports/interactions.js'
import { InteractionError } from './interaction-error.js'
import { addMilliseconds } from './interaction-controller-utils.js'
import type { InteractionPersistence } from './interaction-persistence.js'
import { assertReceiveInputBounded } from './interaction-input-bounds.js'

export interface AdmissionResult extends InteractionReceiveResult {
  readonly record?: InteractionRecord
}

export class InteractionAdmission {
  readonly #persistence: InteractionPersistence
  readonly #clock: Clock
  readonly #defaultContext:
    | {
        readonly profileDigest?: string
        readonly connectionId?: string
        readonly workspaceId?: string
        readonly conversationId?: string
        readonly branchId?: string
        readonly model?: string
        readonly runner?: string
      }
    | undefined

  constructor(options: {
    readonly persistence: InteractionPersistence
    readonly clock: Clock
    readonly defaultContext?: {
      readonly profileDigest?: string
      readonly connectionId?: string
      readonly workspaceId?: string
      readonly conversationId?: string
      readonly branchId?: string
      readonly model?: string
      readonly runner?: string
    }
  }) {
    this.#persistence = options.persistence
    this.#clock = options.clock
    this.#defaultContext = options.defaultContext
  }

  receive(input: ReceiveInteractionInput): AdmissionResult {
    try {
      assertReceiveInputBounded(input)
    } catch (error) {
      throw new InteractionError(
        'INVALID_INTERACTION',
        error instanceof Error ? error.message : 'Interaction identity is invalid',
      )
    }
    const parsed = parseInteractionRequest(input.request)
    if (!parsed.ok) {
      throw new InteractionError('INVALID_INTERACTION', parsed.errors[0] ?? 'Invalid interaction')
    }
    const key = interactionKey(input.runId, parsed.request.id)
    const state = this.#persistence.state()
    const existing = state.interactions.find((item) => item.key === key)
    if (existing) {
      const requestDigest = interactionRequestDigest(parsed.safeRequest)
      if (
        (existing.requestDigest ?? canonicalDigest(existing.request)) !== requestDigest ||
        existing.providerSessionId !== input.providerSessionId ||
        existing.profileDigest !== (input.profileDigest ?? this.#defaultContext?.profileDigest) ||
        existing.connectionId !== (input.connectionId ?? this.#defaultContext?.connectionId) ||
        existing.workspaceId !== (input.workspaceId ?? this.#defaultContext?.workspaceId) ||
        existing.conversationId !==
          (input.conversationId ?? this.#defaultContext?.conversationId) ||
        existing.branchId !== (input.branchId ?? this.#defaultContext?.branchId) ||
        existing.model !== (input.model ?? this.#defaultContext?.model) ||
        existing.runner !== (input.runner ?? this.#defaultContext?.runner)
      ) {
        throw new InteractionError(
          'IDENTITY_CONFLICT',
          'Interaction identity was reused with different binding or content',
        )
      }
      return {
        key,
        replayed: true,
        queuePosition: this.queuePosition(key, state),
        containsSecret: answerSpecContainsSecret(existing.request.answerSpec),
      }
    }

    const createdAt = this.#clock.now()
    const deadlineAt =
      parsed.request.timeoutMs === undefined
        ? undefined
        : addMilliseconds(createdAt, parsed.request.timeoutMs)
    const record: InteractionRecord = {
      key,
      runId: input.runId,
      interactionId: parsed.request.id,
      ...(input.providerSessionId === undefined
        ? {}
        : { providerSessionId: input.providerSessionId }),
      ...this.#contextValue('profileDigest', input.profileDigest),
      ...this.#contextValue('connectionId', input.connectionId),
      ...this.#contextValue('workspaceId', input.workspaceId),
      ...this.#contextValue('conversationId', input.conversationId),
      ...this.#contextValue('branchId', input.branchId),
      ...this.#contextValue('model', input.model),
      ...this.#contextValue('runner', input.runner),
      request: parsed.safeRequest,
      requestDigest: interactionRequestDigest(parsed.safeRequest),
      requestRevision: state.revision + 1,
      status: 'pending',
      arrivalSequence: state.sequence + 1,
      createdAt,
      updatedAt: createdAt,
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
    }
    this.#persistence.commit({ kind: 'interaction.requested', interaction: record })
    return {
      key,
      replayed: false,
      queuePosition: this.queuePosition(key),
      containsSecret: parsed.containsSecret,
      record,
    }
  }

  queuePosition(key: string, state = this.#persistence.state()): number {
    const index = state.queue.indexOf(key)
    return index < 0 ? -1 : index + 1
  }

  #contextValue(
    name:
      | 'profileDigest'
      | 'connectionId'
      | 'workspaceId'
      | 'conversationId'
      | 'branchId'
      | 'model'
      | 'runner',
    value: string | undefined,
  ): Partial<
    Pick<
      InteractionRecord,
      | 'profileDigest'
      | 'connectionId'
      | 'workspaceId'
      | 'conversationId'
      | 'branchId'
      | 'model'
      | 'runner'
    >
  > {
    const selected = value ?? this.#defaultContext?.[name]
    return selected === undefined ? {} : { [name]: selected }
  }
}

export function pendingInteractions(state: InteractionQueueState): readonly InteractionRecord[] {
  return state.interactions.filter(
    (interaction) => interaction.status === 'pending' || interaction.status === 'responding',
  )
}
