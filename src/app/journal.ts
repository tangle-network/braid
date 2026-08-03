import type { BraidEvent, BraidEventEnvelope } from '../domain/events.js'
import type { BraidState } from '../domain/state.js'
import type { Clock } from '../ports/clock.js'
import type { EffectRecord, EffectStoragePort, JournalPort } from '../ports/effect-storage.js'

export class MemoryJournal implements JournalPort, EffectStoragePort {
  readonly #clock: Clock
  readonly #events: BraidEventEnvelope[] = []
  readonly #effects = new Map<string, EffectRecord[]>()

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

  async flush(): Promise<void> {
    // MemoryJournal commits synchronously in append.
  }

  current(operationId: string): EffectRecord | undefined {
    const records = this.#effects.get(operationId) ?? []
    const record = [...records].reverse().find((candidate) => candidate.status !== 'conflict')
    return record === undefined ? undefined : structuredClone(record)
  }

  latest(operationId: string, requestDigest: string): EffectRecord | undefined {
    const records = this.#effects.get(operationId) ?? []
    const record = [...records]
      .reverse()
      .find((candidate) => candidate.requestDigest === requestDigest)
    return record === undefined ? undefined : structuredClone(record)
  }

  reserveEffect(record: EffectRecord): {
    readonly record: EffectRecord
    readonly created: boolean
  } {
    const current = this.current(record.operationId)
    if (current !== undefined) {
      if (current.requestDigest === record.requestDigest) {
        return { record: current, created: false }
      }
      const conflict: EffectRecord = {
        ...record,
        status: 'conflict',
        detail: `Operation is already bound to request digest ${current.requestDigest}`,
        conflictWithDigest: current.requestDigest,
      }
      this.appendEffect(conflict)
      return { record: structuredClone(conflict), created: false }
    }
    this.appendEffect(record)
    return { record: structuredClone(record), created: true }
  }

  appendEffect(record: EffectRecord): void {
    const records = this.#effects.get(record.operationId) ?? []
    records.push(structuredClone(record))
    this.#effects.set(record.operationId, records)
  }

  history(operationId: string): readonly EffectRecord[] {
    return (this.#effects.get(operationId) ?? []).map((record) => structuredClone(record))
  }
}

export function createMemoryJournal(clock: Clock): MemoryJournal {
  return new MemoryJournal(clock)
}
