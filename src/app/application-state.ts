import type { BraidEvent, BraidEventEnvelope } from '../domain/events.js'
import { reduceEvent, replayEvents } from '../domain/reducer.js'
import type { BraidState } from '../domain/state.js'
import type { Clock } from '../ports/clock.js'
import { MemoryJournal } from './journal.js'

export type AppSubscriber = (state: BraidState, envelope: BraidEventEnvelope) => void

/** The only mutable owner of the application event journal and state. */
export class ApplicationStateStore {
  readonly #journal: MemoryJournal
  readonly #subscribers = new Set<AppSubscriber>()
  #state: BraidState

  constructor(options: {
    readonly initialState: BraidState
    readonly clock: Clock
    readonly initialEvents?: readonly BraidEventEnvelope[]
    readonly journalKey?: Uint8Array
  }) {
    const initialEvents = options.initialEvents ?? []
    this.#journal = new MemoryJournal(options.clock, options.journalKey, initialEvents)
    this.#state = replayEvents(options.initialState, initialEvents)
  }

  state(): BraidState {
    return structuredClone(this.#state)
  }

  events(): readonly BraidEventEnvelope[] {
    return this.#journal.all()
  }

  subscribe(subscriber: AppSubscriber): () => void {
    this.#subscribers.add(subscriber)
    return () => this.#subscribers.delete(subscriber)
  }

  commit(event: BraidEvent, eventId?: string): void {
    const envelope = this.#journal.envelope(this.#state, event, eventId)
    const nextState = reduceEvent(this.#state, envelope)
    this.#journal.append(envelope)
    this.#state = nextState
    for (const subscriber of this.#subscribers) {
      subscriber(this.state(), structuredClone(envelope))
    }
  }
}
