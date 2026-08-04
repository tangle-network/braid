const MAX_QUEUED_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_QUEUED_OUTPUT_ITEMS = 4096
const MAX_DRAIN_WAIT_MS = 10_000

export interface BoundedOutputTarget {
  write(chunk: string): boolean
  once?: (event: 'drain', listener: () => void) => unknown
}

export class BoundedOutputQueue {
  readonly #target: BoundedOutputTarget
  #tail: Promise<void> = Promise.resolve()
  #failure: unknown
  #queuedBytes = 0
  #queuedItems = 0

  constructor(target: BoundedOutputTarget) {
    this.#target = target
  }

  write(chunk: string): Promise<void> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure)
    const bytes = Buffer.byteLength(chunk, 'utf8')
    if (
      bytes > MAX_QUEUED_OUTPUT_BYTES ||
      this.#queuedBytes + bytes > MAX_QUEUED_OUTPUT_BYTES ||
      this.#queuedItems >= MAX_QUEUED_OUTPUT_ITEMS
    ) {
      const error = new Error('OUTPUT_BACKPRESSURE_LIMIT: output queue is full')
      this.#failure = error
      return Promise.reject(error)
    }
    this.#queuedBytes += bytes
    this.#queuedItems += 1
    const task = this.#tail.then(async () => {
      if (this.#failure !== undefined) throw this.#failure
      this.#queuedBytes -= bytes
      this.#queuedItems -= 1
      if (!this.#target.write(chunk)) await this.#waitForDrain()
    })
    this.#tail = task.catch((error: unknown) => {
      this.#failure = error
    })
    return task
  }

  async flush(): Promise<void> {
    await this.#tail
    if (this.#failure !== undefined) throw this.#failure
  }

  async #waitForDrain(): Promise<void> {
    if (typeof this.#target.once !== 'function')
      throw new Error('OUTPUT_BACKPRESSURE_UNAVAILABLE: output has no drain notification')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('OUTPUT_BACKPRESSURE_TIMEOUT: output did not drain'))
      }, MAX_DRAIN_WAIT_MS)
      try {
        this.#target.once?.('drain', () => {
          clearTimeout(timer)
          resolve()
        })
      } catch (error) {
        clearTimeout(timer)
        reject(error)
      }
    })
  }
}
