import type { ExecutionPort } from '../ports/execution.js'

/**
 * Silence that makes Braid ask the provider whether the stream is still alive.
 * The sidecar's heartbeats are not events, so a dead connection can look healthy for hours;
 * only ingested events count as activity. A quiet long tool call also reaches this bound, which
 * is why the provider's own status is read before anything is aborted: a running run is simply
 * replayed from its cursor. The bound sits far below agent-runtime's 8-minute observation idle
 * limit, and two minutes after the provider run ends Braid must no longer say `streaming`.
 */
export const DEFAULT_STREAM_IDLE_MS = 45_000
/** A status read that outlives this deadline counts as a lost provider. */
export const DEFAULT_STATUS_TIMEOUT_MS = 15_000

export const STALLED = Symbol('stalled')

export function streamIdleMs(execution: ExecutionPort): number {
  return execution.streamIdleMs ?? DEFAULT_STREAM_IDLE_MS
}

export function statusTimeoutMs(execution: ExecutionPort): number {
  return execution.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS
}

/** Settles with the promise, or with `STALLED` once `ms` pass; the timer never outlives either. */
export async function withinDeadline<T>(
  promise: PromiseLike<T> | T,
  ms: number,
): Promise<T | typeof STALLED> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<typeof STALLED>((resolve) => {
    timer = setTimeout(() => resolve(STALLED), ms)
  })
  const pending = Promise.resolve(promise)
  // A promise abandoned at its deadline may still reject later.
  pending.catch(() => undefined)
  try {
    return await Promise.race([pending, deadline])
  } finally {
    clearTimeout(timer)
  }
}

export type PumpOutcome = 'ended' | 'stopped' | 'stalled'

/**
 * Starts the idle bound for the wait on the next event. Provisioning and dispatch precede it and
 * report their own failures; the bound starts once the provider run exists (its admission is
 * committed) or the first event has arrived, whichever is first, even mid-wait.
 */
export class IdleArm {
  #armed = false
  #release!: () => void
  readonly whenArmed = new Promise<void>((resolve) => {
    this.#release = resolve
  })
  get armed(): boolean {
    return this.#armed
  }
  arm(): void {
    this.#armed = true
    this.#release()
  }
}

/**
 * Feed an async stream to `handle`, with the idle bound on both the next event and the
 * handler (an ingest that never commits is silence too). The timers belong to this function,
 * not to the stream's await chain, so a reader that never settles cannot hold the run open.
 */
export async function pumpWithIdleBound<T>(
  stream: AsyncIterable<T>,
  idleMs: number,
  arm: IdleArm,
  handle: (item: T) => Promise<'continue' | 'stop'> | 'continue' | 'stop',
): Promise<PumpOutcome> {
  const iterator = stream[Symbol.asyncIterator]()
  let settled = false
  try {
    for (;;) {
      const next = await nextWithin(iterator.next(), idleMs, arm)
      if (next === STALLED) return 'stalled'
      if (next.done) {
        settled = true
        return 'ended'
      }
      const handled = await withinDeadline(handle(next.value), idleMs)
      if (handled === STALLED) return 'stalled'
      if (handled === 'stop') return 'stopped'
    }
  } finally {
    // A hung reader never settles its return; the abandoned call must not become a rejection.
    if (!settled) void Promise.resolve(iterator.return?.()).catch(() => undefined)
  }
}

async function nextWithin<T>(
  pending: Promise<T>,
  idleMs: number,
  arm: IdleArm,
): Promise<T | typeof STALLED> {
  pending.catch(() => undefined)
  if (arm.armed) return withinDeadline(pending, idleMs)
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  const deadline = arm.whenArmed.then<T | typeof STALLED>(() => {
    // The first event may finish this wait before its handler arms the stream.
    if (settled) return pending
    return new Promise<typeof STALLED>((resolve) => {
      timer = setTimeout(() => resolve(STALLED), idleMs)
    })
  })
  try {
    return await Promise.race([pending, deadline])
  } finally {
    settled = true
    clearTimeout(timer)
  }
}

export function stallDetail(execution: ExecutionPort): string {
  return `no provider events for ${Math.round(streamIdleMs(execution) / 1000)} seconds`
}
