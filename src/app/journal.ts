import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { eventIdentity, type BraidEvent, type BraidEventEnvelope } from '../domain/events.js'
import type { BraidState } from '../domain/state.js'
import type { Clock } from '../ports/clock.js'

const ALGORITHM = 'aes-256-gcm'

export class EncryptedJournal {
  readonly #clock: Clock
  readonly #key: Buffer
  readonly #records: string[] = []
  readonly #eventIds = new Set<string>()

  constructor(
    clock: Clock,
    key: Uint8Array | undefined = undefined,
    initial: readonly BraidEventEnvelope[] = [],
  ) {
    const encryptionKey = key === undefined ? randomBytes(32) : Buffer.from(key)
    if (encryptionKey.byteLength !== 32) throw new Error('Journal encryption key must be 32 bytes')
    this.#clock = clock
    this.#key = encryptionKey
    for (const envelope of initial) this.append(envelope)
  }

  envelope(state: BraidState, event: BraidEvent, eventId?: string): BraidEventEnvelope {
    return {
      eventId: eventId ?? `event-${String(state.sequence + 1).padStart(6, '0')}-${event.kind}`,
      sequence: state.sequence + 1,
      revision: state.revision + 1,
      occurredAt: this.#clock.now(),
      event,
    }
  }

  append(envelope: BraidEventEnvelope): void {
    const identity = eventIdentity(envelope.event, envelope.eventId)
    if (identity && this.#eventIds.has(identity)) return
    const iv = randomBytes(12)
    const cipher = createCipheriv(ALGORITHM, this.#key, iv)
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(envelope), 'utf8'),
      cipher.final(),
    ])
    const tag = cipher.getAuthTag()
    this.#records.push(Buffer.concat([iv, tag, ciphertext]).toString('base64'))
    if (identity) this.#eventIds.add(identity)
  }

  all(): readonly BraidEventEnvelope[] {
    return this.#records.map((record) => {
      const encoded = Buffer.from(record, 'base64')
      const decipher = createDecipheriv(ALGORITHM, this.#key, encoded.subarray(0, 12))
      decipher.setAuthTag(encoded.subarray(12, 28))
      const plaintext = Buffer.concat([
        decipher.update(encoded.subarray(28)),
        decipher.final(),
      ]).toString('utf8')
      return JSON.parse(plaintext) as BraidEventEnvelope
    })
  }

  encryptedRecords(): readonly string[] {
    return [...this.#records]
  }
}

export class MemoryJournal extends EncryptedJournal {}
