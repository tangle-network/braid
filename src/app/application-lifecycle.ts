export interface TrackedApplicationOperation {
  readonly runId: string
  readonly completion: Promise<unknown>
}

export interface AdmissionRegistration {
  readonly runId: string
  readonly signal: AbortSignal
  release(): void
}

export const DEFAULT_APPLICATION_DRAIN_TIMEOUT_MS = 5_000

export interface LifecycleCloseOptions {
  readonly runIds: readonly string[]
  readonly shouldSettleRun?: (runId: string) => boolean
  readonly timeoutMs: number
  readonly cancel: (runId: string) => Promise<void>
  readonly markUnknown: (runId: string) => Promise<void>
}

/** Owns admission state and the bounded drain of application operations. */
export class ApplicationLifecycle {
  #accepting = true
  #closed = false
  #active = new Map<string, Promise<unknown>>()
  #admissions = new Map<
    string,
    { readonly controller: AbortController; readonly registration: AdmissionRegistration }
  >()
  #closePromise: Promise<void> | undefined

  acceptsAdmission(): boolean {
    return this.#accepting
  }

  isClosed(): boolean {
    return this.#closed
  }

  registerAdmission(runId: string): AdmissionRegistration {
    const controller = new AbortController()
    let entry: {
      readonly controller: AbortController
      readonly registration: AdmissionRegistration
    }
    const registration: AdmissionRegistration = {
      runId,
      signal: controller.signal,
      release: () => {
        if (this.#admissions.get(runId) === entry) this.#admissions.delete(runId)
      },
    }
    entry = { controller, registration }
    if (!this.#accepting) controller.abort(new Error('Application is closing'))
    else this.#admissions.set(runId, entry)
    return registration
  }

  track(operation: TrackedApplicationOperation): void {
    if (this.#closed) return
    if (this.#active.has(operation.runId)) return
    this.#active.set(operation.runId, operation.completion)
    void operation.completion.then(
      () => this.#active.delete(operation.runId),
      () => this.#active.delete(operation.runId),
    )
  }

  activeOperations(): readonly TrackedApplicationOperation[] {
    return [...this.#active.entries()].map(([runId, completion]) => ({ runId, completion }))
  }

  close(task: () => Promise<void>): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise
    this.#accepting = false
    this.#abortAdmissions()
    this.#closePromise = Promise.resolve()
      .then(task)
      .finally(() => {
        this.#closed = true
        this.#active.clear()
      })
    return this.#closePromise
  }

  async settleActive(options: LifecycleCloseOptions): Promise<readonly string[]> {
    this.#abortAdmissions()
    const deadline = Date.now() + Math.max(0, options.timeoutMs)
    const trackedRunIds = [...this.#active.keys()].filter(
      (runId) => options.shouldSettleRun?.(runId) ?? true,
    )
    const runIds = [...new Set([...options.runIds, ...trackedRunIds])]
    await untilDeadline(Promise.allSettled(runIds.map((runId) => options.cancel(runId))), deadline)

    const operations = this.activeOperations()
    if (operations.length === 0) return []
    const pending = new Set(operations.map((operation) => operation.runId))
    const waiters = operations.map((operation) =>
      operation.completion.then(
        () => pending.delete(operation.runId),
        () => pending.delete(operation.runId),
      ),
    )
    await untilDeadline(
      Promise.all(waiters).then(() => undefined),
      deadline,
    )

    const unsettled = [...pending]
    await untilDeadline(
      Promise.allSettled(unsettled.map((runId) => options.markUnknown(runId))).then(
        () => undefined,
      ),
      deadline,
    )
    return unsettled
  }

  #abortAdmissions(): void {
    for (const entry of this.#admissions.values()) {
      if (!entry.controller.signal.aborted)
        entry.controller.abort(new Error('Application is closing'))
    }
  }
}

export async function boundedDrain(
  completions: Iterable<Promise<unknown>>,
  timeoutMs = DEFAULT_APPLICATION_DRAIN_TIMEOUT_MS,
): Promise<boolean> {
  const pending = [...completions]
  if (pending.length === 0) return true
  const drained = await untilDeadline(
    Promise.allSettled(pending).then(() => true),
    Date.now() + Math.max(0, timeoutMs),
  )
  return drained === true
}

async function untilDeadline<T>(promise: Promise<T>, deadline: number): Promise<T | undefined> {
  const remaining = Math.max(0, deadline - Date.now())
  if (remaining === 0) return undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), remaining)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
