import type { BraidEvent, BraidEventEnvelope } from '../domain/events.js'
import { providerMetaForEvent } from '../domain/events.js'
import { parseReplayCursor } from '../domain/ids.js'
import type { BraidState } from '../domain/state.js'
import type { Clock } from '../ports/clock.js'
import type { EffectRecord, EffectStoragePort, JournalPort } from '../ports/effect-storage.js'

/** Used only before a production SQLite store has been opened. */
export class FailClosedJournal implements JournalPort, EffectStoragePort {
  readonly #clock: Clock

  constructor(clock: Clock) {
    this.#clock = clock
  }

  envelope(state: BraidState, event: BraidEvent): BraidEventEnvelope {
    const provider = providerMetaForEvent(event)
    return {
      sequence: state.sequence + 1,
      revision: state.revision + 1,
      occurredAt: this.#clock.now(),
      ...(provider?.cursor === undefined ? {} : { cursor: parseReplayCursor(provider.cursor) }),
      event,
    }
  }

  append(): never {
    throw new Error('BRAID_STORAGE_REQUIRED: open the encrypted SQLite store before mutating state')
  }

  all(): readonly BraidEventEnvelope[] {
    return []
  }

  current(): EffectRecord | undefined {
    return undefined
  }

  latest(): EffectRecord | undefined {
    return undefined
  }

  reserveEffect(): never {
    throw new Error(
      'BRAID_STORAGE_REQUIRED: open the encrypted SQLite store before dispatching effects',
    )
  }

  appendEffect(): never {
    throw new Error(
      'BRAID_STORAGE_REQUIRED: open the encrypted SQLite store before dispatching effects',
    )
  }

  history(): readonly EffectRecord[] {
    return []
  }
}
