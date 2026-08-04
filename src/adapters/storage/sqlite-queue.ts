import { StorageError } from './sqlite-errors.js'

interface QueueTask<T> {
  readonly operation: () => Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
  readonly reject: (reason?: unknown) => void
}

export class BoundedWriteQueue {
  readonly #max: number
  readonly #tasks: QueueTask<unknown>[] = []
  #running = false
  #drainPromise: Promise<void> | undefined

  constructor(max: number) {
    this.#max = max
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#tasks.length >= this.#max) {
      return Promise.reject(
        new StorageError('STORAGE_QUEUE_FULL', 'The serialized SQLite writer queue is full'),
      )
    }
    return new Promise<T>((resolve, reject) => {
      this.#tasks.push({ operation, resolve, reject } as QueueTask<unknown>)
      void this.#drain()
    })
  }

  async #drain(): Promise<void> {
    if (this.#running) return this.#drainPromise
    this.#running = true
    const drain = (async () => {
      try {
        while (this.#tasks.length > 0) {
          const task = this.#tasks.shift()
          if (!task) continue
          try {
            task.resolve(await task.operation())
          } catch (error) {
            task.reject(error)
          }
        }
      } finally {
        this.#running = false
        this.#drainPromise = undefined
      }
    })()
    this.#drainPromise = drain
    return drain
  }

  async drain(): Promise<void> {
    while (this.#running || this.#tasks.length > 0) {
      await (this.#drainPromise ?? this.#drain())
    }
  }
}
