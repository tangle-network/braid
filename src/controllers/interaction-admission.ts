import { canonicalDigest } from '../domain/canonical.js'
import { answerSpecContainsSecret, parseInteractionRequest } from '../domain/interaction.js'
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
      readonly runner?: string
    }
  }) {
    this.#persistence = options.persistence
    this.#clock = options.clock
    this.#defaultContext = options.defaultContext
  }

  receive(input: ReceiveInteractionInput): AdmissionResult {
    const parsed = parseInteractionRequest(input.request)
    if (!parsed.ok) {
      throw new InteractionError('INVALID_INTERACTION', parsed.errors[0] ?? 'Invalid interaction')
    }
    const key = interactionKey(input.runId, parsed.request.id)
    const state = this.#persistence.state()
    const existing = state.interactions.find((item) => item.key === key)
    if (existing) {
      if (canonicalDigest(existing.request) !== canonicalDigest(parsed.safeRequest)) {
        throw new InteractionError(
          'INTERACTION_CONFLICT',
          'Interaction identity was reused with different content',
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
      ...this.#contextValue('runner', input.runner),
      request: parsed.safeRequest,
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
    name: 'profileDigest' | 'connectionId' | 'workspaceId' | 'runner',
    value: string | undefined,
  ): Partial<Pick<InteractionRecord, 'profileDigest' | 'connectionId' | 'workspaceId' | 'runner'>> {
    const selected = value ?? this.#defaultContext?.[name]
    return selected === undefined ? {} : { [name]: selected }
  }
}

export function pendingInteractions(state: InteractionQueueState): readonly InteractionRecord[] {
  return state.interactions.filter(
    (interaction) => interaction.status === 'pending' || interaction.status === 'responding',
  )
}
