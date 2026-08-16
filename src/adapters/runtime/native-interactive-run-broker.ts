import type { RetainedInteractiveRunHandle } from '@tangle-network/agent-runtime/kernel'
import type {
  NativeInteractiveExecutionControl,
  NativeInteractiveRunOutcome,
} from '../../ports/native-interactive-execution.js'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
  settled: boolean
}

interface BrokerEntry {
  readonly handle: Deferred<RetainedInteractiveRunHandle>
  readonly outcome: Deferred<NativeInteractiveRunOutcome>
  opened: boolean
}

export interface NativeInteractiveRunLease {
  publish(handle: RetainedInteractiveRunHandle): void
  outcome(options?: { readonly signal?: AbortSignal }): Promise<NativeInteractiveRunOutcome>
  fail(error: unknown): void
  close(): void
}

/** One in-memory rendezvous only; Runtime and Braid's journal remain the durable owners. */
export class NativeInteractiveRunBroker implements NativeInteractiveExecutionControl {
  readonly #entries = new Map<string, BrokerEntry>()

  open(runId: string): NativeInteractiveRunLease {
    const entry = this.#entry(runId)
    if (entry.opened) throw new Error(`Interactive run ${runId} already has an active execution`)
    entry.opened = true
    let closed = false
    return Object.freeze({
      publish: (handle: RetainedInteractiveRunHandle) => {
        if (closed) throw new Error(`Interactive run ${runId} execution is closed`)
        entry.handle.resolve(handle)
      },
      outcome: (options?: { readonly signal?: AbortSignal }) =>
        abortable(entry.outcome.promise, options?.signal),
      fail: (error: unknown) => {
        entry.handle.reject(asError(error))
        entry.outcome.reject(asError(error))
      },
      close: () => {
        if (closed) return
        closed = true
        entry.handle.reject(new Error(`Interactive run ${runId} ended before terminal attach`))
        entry.outcome.reject(new Error(`Interactive run ${runId} ended without a terminal outcome`))
        if (this.#entries.get(runId) === entry) this.#entries.delete(runId)
      },
    })
  }

  waitForHandle(
    runId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RetainedInteractiveRunHandle> {
    return abortable(this.#entry(runId).handle.promise, options?.signal)
  }

  settle(runId: string, outcome: NativeInteractiveRunOutcome): void {
    const entry = this.#entries.get(runId)
    if (entry === undefined || !entry.opened) {
      throw new Error(`Interactive run ${runId} has no active execution`)
    }
    if (entry.outcome.settled) {
      throw new Error(`Interactive run ${runId} already has a terminal outcome`)
    }
    entry.outcome.resolve(structuredClone(outcome))
  }

  #entry(runId: string): BrokerEntry {
    if (runId.trim().length === 0) throw new Error('Interactive run id must not be empty')
    const current = this.#entries.get(runId)
    if (current !== undefined) return current
    const entry: BrokerEntry = {
      handle: deferred<RetainedInteractiveRunHandle>(),
      outcome: deferred<NativeInteractiveRunOutcome>(),
      opened: false,
    }
    this.#entries.set(runId, entry)
    return entry
  }
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => {}
  let rejectPromise: (error: unknown) => void = () => {}
  const value: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    }),
    resolve: (next) => {
      if (value.settled) return
      value.settled = true
      resolvePromise(next)
    },
    reject: (error) => {
      if (value.settled) return
      value.settled = true
      rejectPromise(error)
    },
    settled: false,
  }
  void value.promise.catch(() => undefined)
  return value
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  if (signal === undefined) return promise
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
