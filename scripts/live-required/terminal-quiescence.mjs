/**
 * Track terminal output until the renderer has caught up and its animated
 * status indicators have stopped producing frames.
 *
 * Pi's public Loader uses an 80ms default frame interval in 0.80.2, 0.82.1,
 * and 0.84.4. Three complete intervals provide a renderer-observable quiet
 * period that cannot occur while that indicator is still animating.
 */
export const PI_LOADER_INTERVAL_MS = 80
export const TERMINAL_QUIET_INTERVAL_MS = PI_LOADER_INTERVAL_MS * 3
export const TERMINAL_QUIET_POLL_INTERVAL_MS = 25

export function createTerminalOutputTracker({
  now = () => performance.now(),
  quietIntervalMs = TERMINAL_QUIET_INTERVAL_MS,
} = {}) {
  if (!Number.isFinite(quietIntervalMs) || quietIntervalMs <= 0) {
    throw new RangeError('terminal quiet interval must be positive')
  }

  let pendingWrites = 0
  let lastOutputAt = now()
  let revision = 0

  const observe = (data, write) => {
    if (typeof data !== 'string' || data.length === 0) {
      throw new TypeError('terminal output must be a non-empty string')
    }
    if (typeof write !== 'function') throw new TypeError('terminal output writer is required')

    lastOutputAt = now()
    revision += 1
    pendingWrites += 1
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      pendingWrites -= 1
    }
    try {
      write(settle)
    } catch (error) {
      settle()
      throw error
    }
  }

  const snapshot = () => ({
    pendingWrites,
    lastOutputAt,
    revision,
    quietForMs: Math.max(0, now() - lastOutputAt),
    quietIntervalMs,
  })

  return {
    observe,
    isQuiescent: () => pendingWrites === 0 && now() - lastOutputAt >= quietIntervalMs,
    snapshot,
  }
}

export async function waitForTerminalQuiescence(
  tracker,
  {
    timeoutMs,
    afterRevision,
    now = () => performance.now(),
    pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  if (
    !tracker ||
    typeof tracker.isQuiescent !== 'function' ||
    typeof tracker.snapshot !== 'function'
  ) {
    throw new TypeError('terminal output tracker is required')
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('terminal quiescence timeout must be positive')
  }
  if (afterRevision !== undefined && (!Number.isSafeInteger(afterRevision) || afterRevision < 0)) {
    throw new RangeError('terminal output revision must be a non-negative safe integer')
  }

  const deadline = now() + timeoutMs
  for (;;) {
    const snapshot = tracker.snapshot()
    const observedAfterAction = afterRevision === undefined || snapshot.revision > afterRevision
    if (observedAfterAction && tracker.isQuiescent()) return snapshot
    if (now() >= deadline) {
      throw new Error(
        `terminal output did not become quiescent after ${timeoutMs}ms: ${JSON.stringify(snapshot)}`,
      )
    }
    await pause(Math.min(TERMINAL_QUIET_POLL_INTERVAL_MS, Math.max(0, deadline - now())))
  }
}
