import { reduceInteractionEvent } from '../domain/interaction-reducer.js'
import {
  initialInteractionState,
  type InteractionEvent,
  type InteractionEventEnvelope,
  type InteractionQueueState,
} from '../domain/interaction-state.js'
import type { InteractionEvent } from '../domain/interaction-state.js'
import type { BraidEvent, BraidEventEnvelope } from '../domain/events.js'
import type { BraidState } from '../domain/state.js'
import type { Clock } from '../ports/clock.js'
import type { IdSource } from '../ports/ids.js'
import type { InteractionSubscriber } from './interaction-controller-types.js'
import { eventIdentity } from '../domain/events.js'
import type { ApplicationStateStore } from '../app/application-state.js'

function clone<T>(value: T): T {
  return structuredClone(value)
}

export class InteractionPersistence {
  readonly #clock: Clock
  readonly #ids: IdSource
  readonly #applicationState: ApplicationStateStore | undefined
  readonly #subscribers = new Set<InteractionSubscriber>()
  readonly #events: InteractionEventEnvelope[] = []
  #state: InteractionQueueState

  constructor(options: {
    readonly clock: Clock
    readonly ids: IdSource
    readonly initialState?: InteractionQueueState
    readonly initialEvents?: readonly InteractionEventEnvelope[]
    readonly applicationState?: ApplicationStateStore
  }) {
    this.#clock = options.clock
    this.#ids = options.ids
    this.#applicationState = options.applicationState
    this.#state = options.initialState ? clone(options.initialState) : initialInteractionState()
    if (this.#applicationState) return
    for (const envelope of options.initialEvents ?? []) {
      const identity = eventIdentity(envelope.event, envelope.eventId)
      if (identity && this.#state.appliedEventIds.includes(identity)) continue
      this.#state = reduceInteractionEvent(this.#state, envelope)
      this.#events.push(clone(envelope))
    }
  }

  state(): InteractionQueueState {
    if (this.#applicationState) return projectInteractionState(this.#applicationState.state())
    return clone(this.#state)
  }

  events(): readonly InteractionEventEnvelope[] {
    if (this.#applicationState) {
      return this.#applicationState
        .events()
        .filter(isInteractionEnvelope)
        .map((envelope) => ({ ...envelope, event: envelope.event }))
    }
    return clone(this.#events)
  }

  subscribe(subscriber: InteractionSubscriber): () => void {
    if (this.#applicationState) {
      return this.#applicationState.subscribe((state, envelope) => {
        if (isInteractionEvent(envelope.event)) {
          subscriber(projectInteractionState(state), { ...envelope, event: envelope.event })
        }
      })
    }
    this.#subscribers.add(subscriber)
    return () => this.#subscribers.delete(subscriber)
  }

  commit(event: InteractionEvent, eventId?: string): void {
    if (this.#applicationState) {
      this.#applicationState.commit(event, eventId)
      return
    }
    let eventId = this.#ids.next('event')
    while (
      this.#state.appliedEventIds.includes(eventIdentity(event, eventId) ?? eventId) ||
      this.#events.some(
        (item) => eventIdentity(item.event, item.eventId) === eventIdentity(event, eventId),
      )
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

function projectInteractionState(state: BraidState): InteractionQueueState {
  return {
    revision: state.revision,
    sequence: state.sequence,
    appliedEventIds: state.appliedEventIds,
    interactions: state.interactions,
    queue: state.interactions
      .filter((interaction) => interaction.status === 'pending')
      .sort((left, right) => left.arrivalSequence - right.arrivalSequence)
      .map((interaction) => interaction.key),
    rules: state.rules,
    audits: state.automationAudits,
    feedbackDecisions: state.feedbackDecisions,
  }
}

function isInteractionEnvelope(
  envelope: BraidEventEnvelope,
): envelope is BraidEventEnvelope & { readonly event: InteractionEvent } {
  return isInteractionEvent(envelope.event)
}

function isInteractionEvent(event: BraidEvent): event is InteractionEvent {
  return (
    event.kind.startsWith('interaction.') ||
    event.kind.startsWith('automation.') ||
    event.kind === 'feedback.decision.recorded'
  )
}
