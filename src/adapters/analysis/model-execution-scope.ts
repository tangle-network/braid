import { AsyncLocalStorage } from 'node:async_hooks'
import type { ExternalOptimizerModelExecutionObservation } from '@tangle-network/agent-eval/campaign'

const MAX_COMPLETED_RUNS = 256

interface ExecutionContext {
  readonly runId: string
  readonly observations: ExternalOptimizerModelExecutionObservation[]
}

class AsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  readonly #values: T[] = []
  readonly #waiters: Array<{
    readonly resolve: (result: IteratorResult<T>) => void
    readonly reject: (error: unknown) => void
  }> = []
  #closed = false
  #failure: unknown;

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (this.#failure !== undefined) return Promise.reject(this.#failure)
    if (this.#closed) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }))
  }

  push(value: T): void {
    const waiter = this.#waiters.shift()
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value })
      return
    }
    this.#values.push(value)
  }

  close(): void {
    this.#closed = true
    while (this.#waiters.length > 0) {
      this.#waiters.shift()?.resolve({ done: true, value: undefined })
    }
  }

  fail(error: unknown): void {
    this.#failure = error
    while (this.#waiters.length > 0) this.#waiters.shift()?.reject(error)
  }
}

/** Associates Agent Eval's callback observations with one analysis run. */
export class ModelExecutionScope {
  readonly #storage = new AsyncLocalStorage<ExecutionContext>()
  readonly #completed = new Map<string, readonly ExternalOptimizerModelExecutionObservation[]>()

  record = (observation: ExternalOptimizerModelExecutionObservation): void => {
    const context = this.#storage.getStore()
    if (context === undefined) return
    context.observations.push(structuredClone(observation))
  }

  async *stream<T>(runId: string, source: AsyncIterable<T>): AsyncGenerator<T, void, void> {
    const context: ExecutionContext = { runId, observations: [] }
    const queue = new AsyncQueue<T>()
    const producer = this.#storage.run(context, async () => {
      try {
        for await (const value of source) queue.push(value)
        queue.close()
      } catch (error) {
        queue.fail(error)
      } finally {
        const completed = Object.freeze(
          context.observations.map((observation) => structuredClone(observation)),
        )
        this.#completed.delete(context.runId)
        this.#completed.set(context.runId, completed)
        while (this.#completed.size > MAX_COMPLETED_RUNS) {
          const oldestRunId = this.#completed.keys().next().value
          if (oldestRunId === undefined) break
          this.#completed.delete(oldestRunId)
        }
      }
    })
    try {
      for await (const value of queue) yield value
    } finally {
      await producer
    }
  }

  modelExecutions(runId: string): readonly ExternalOptimizerModelExecutionObservation[] {
    const observations = this.#completed.get(runId)
    if (observations === undefined) return []
    this.#completed.delete(runId)
    return observations.map((observation) => structuredClone(observation))
  }
}
