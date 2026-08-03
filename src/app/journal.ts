import {
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
  fsyncSync,
  closeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import type { BraidEvent, BraidEventEnvelope } from '../domain/events.js'
import { redactBraidEvent } from '../domain/redaction.js'
import type { BraidState } from '../domain/state.js'
import type { Clock } from '../ports/clock.js'

export interface JournalPort {
  envelope(state: BraidState, event: BraidEvent): BraidEventEnvelope
  append(envelope: BraidEventEnvelope): void
  all(): readonly BraidEventEnvelope[]
}

function cloneEnvelope(event: BraidEventEnvelope): BraidEventEnvelope {
  return {
    ...structuredClone(event),
    event: redactBraidEvent(event.event),
  }
}

export class MemoryJournal implements JournalPort {
  readonly #clock: Clock
  readonly #events: BraidEventEnvelope[]

  constructor(clock: Clock, events: readonly BraidEventEnvelope[] = []) {
    this.#clock = clock
    this.#events = events.map(cloneEnvelope)
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
    this.#events.push(cloneEnvelope(envelope))
  }

  all(): readonly BraidEventEnvelope[] {
    return this.#events.map((event) => structuredClone(event))
  }
}

/**
 * Small durable event port used until the SQLite storage package is connected.
 * It is deliberately append-only and fsyncs each envelope before returning.
 */
export class FileJournal implements JournalPort {
  readonly #clock: Clock
  readonly #path: string
  readonly #events: BraidEventEnvelope[]

  constructor(path: string, clock: Clock) {
    this.#clock = clock
    this.#path = path
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.#events = this.#read()
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
    const safe = cloneEnvelope(envelope)
    const file = openSync(
      this.#path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      writeSync(file, `${JSON.stringify(safe)}\n`)
      fsyncSync(file)
    } finally {
      closeSync(file)
    }
    this.#events.push(safe)
  }

  all(): readonly BraidEventEnvelope[] {
    return this.#events.map((event) => structuredClone(event))
  }

  #read(): BraidEventEnvelope[] {
    let text: string
    try {
      text = readFileSync(this.#path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    if (!text.trim()) return []
    return text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line, index) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          throw new Error(`Journal record ${index + 1} is not valid JSON`)
        }
        if (!parsed || typeof parsed !== 'object')
          throw new Error(`Journal record ${index + 1} is not an object`)
        return cloneEnvelope(parsed as BraidEventEnvelope)
      })
  }
}
