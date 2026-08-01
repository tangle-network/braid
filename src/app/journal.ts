import type { BraidEvent, BraidEventEnvelope } from '../domain/events.js'
import type { BraidState } from '../domain/state.js'
import type { Clock } from '../ports/clock.js'

export class MemoryJournal {
  readonly #clock: Clock
  readonly #events: BraidEventEnvelope[] = []

  constructor(clock: Clock) {
    this.#clock = clock
  }

  envelope(state: BraidState, event: BraidEvent): BraidEventEnvelope {
    return {
      sequence: state.sequence + 1,
      revision: state.revision + 1,
      occurredAt: this.#clock.now(),
      event,
    }
  }

  append(envelope: BraidEventEnvelope): void {
    this.#events.push(envelope)
  }

  all(): readonly BraidEventEnvelope[] {
    return this.#events.map((event) => structuredClone(event))
  }
}
