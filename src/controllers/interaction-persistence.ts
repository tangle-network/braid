import { reduceInteractionEvent } from '../domain/interaction-reducer.js'
import {
  initialInteractionState,
  type InteractionEvent,
  type InteractionEventEnvelope,
  type InteractionQueueState,
} from '../domain/interaction-state.js'
import type { Clock } from '../ports/clock.js'
import type { IdSource } from '../ports/ids.js'
import type { InteractionSubscriber } from './interaction-controller-types.js'

function clone<T>(value: T): T {
  return structuredClone(value)
}

export class InteractionPersistence {
  readonly #clock: Clock
  readonly #ids: IdSource
  readonly #subscribers = new Set<InteractionSubscriber>()
  readonly #events: InteractionEventEnvelope[] = []
  #state: InteractionQueueState

  constructor(options: {
    readonly clock: Clock
    readonly ids: IdSource
    readonly initialState?: InteractionQueueState
    readonly initialEvents?: readonly InteractionEventEnvelope[]
  }) {
    this.#clock = options.clock
    this.#ids = options.ids
    this.#state = options.initialState ? clone(options.initialState) : initialInteractionState()
    for (const envelope of options.initialEvents ?? []) {
      this.#state = reduceInteractionEvent(this.#state, envelope)
      this.#events.push(clone(envelope))
    }
  }

  state(): InteractionQueueState {
    return clone(this.#state)
  }

  events(): readonly InteractionEventEnvelope[] {
    return clone(this.#events)
  }

  subscribe(subscriber: InteractionSubscriber): () => void {
    this.#subscribers.add(subscriber)
    return () => this.#subscribers.delete(subscriber)
  }

  commit(event: InteractionEvent): void {
    let eventId = this.#ids.next('event')
    while (
      this.#state.appliedEventIds.includes(eventId) ||
      this.#events.some((item) => item.eventId === eventId)
    ) {
      eventId = this.#ids.next('event')
    }
    const envelope: InteractionEventEnvelope = {
      eventId,
      sequence: this.#state.sequence + 1,
      revision: this.#state.revision + 1,
      occurredAt: this.#clock.now(),
      event,
    }
    this.#state = reduceInteractionEvent(this.#state, envelope)
    this.#events.push(envelope)
    for (const subscriber of this.#subscribers) subscriber(this.state(), clone(envelope))
  }
}

export type InteractionCommit = (event: InteractionEvent) => void
