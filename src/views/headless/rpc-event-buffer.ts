import type { BraidEventEnvelope } from '../../domain/events.js'
import { AppError } from '../../app/application.js'
import { MAX_OUTPUT_QUEUE, MAX_OUTPUT_QUEUE_BYTES, utf8Bytes } from '../../domain/bounds.js'

export class RpcEventBuffer {
  #events: BraidEventEnvelope[] | undefined
  #bytes = 0

  begin(): void {
    this.#events = []
    this.#bytes = 0
  }

  get active(): boolean {
    return this.#events !== undefined
  }

  add(envelope: BraidEventEnvelope): void {
    if (!this.#events) throw new Error('RPC event buffer is not active')
    const bytes = utf8Bytes(JSON.stringify(envelope))
    if (this.#events.length >= MAX_OUTPUT_QUEUE || this.#bytes + bytes > MAX_OUTPUT_QUEUE_BYTES) {
      throw new AppError('OUTPUT_BACKPRESSURE', 'Buffered event output is full')
    }
    this.#events.push(envelope)
    this.#bytes += bytes
  }

  take(): readonly BraidEventEnvelope[] {
    const events = this.#events ?? []
    this.clear()
    return events
  }

  clear(): void {
    this.#events = undefined
    this.#bytes = 0
  }
}
