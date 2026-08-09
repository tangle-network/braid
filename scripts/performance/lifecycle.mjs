import { cleanupProcessProbes } from './process-probes.mjs'

export function createPerformanceLifecycle() {
  const controller = new AbortController()
  const cleanups = new Set()
  const lateCleanups = []
  let abortCleanupPromise = Promise.resolve()
  let closePromise

  const addCleanup = (cleanup) => {
    if (controller.signal.aborted) {
      lateCleanups.push(abortCleanupPromise.then(() => cleanup()).catch(() => undefined))
      return cleanup
    }
    cleanups.add(cleanup)
    return cleanup
  }

  const abort = (reason = 'performance run interrupted') => {
    if (controller.signal.aborted) return
    controller.abort(reason)
    abortCleanupPromise = cleanupProcessProbes().catch(() => undefined)
  }

  const throwIfAborted = () => {
    if (controller.signal.aborted) {
      throw new Error(
        `Performance run aborted: ${String(controller.signal.reason ?? 'interrupted')}`,
      )
    }
  }

  const close = () => {
    if (closePromise) return closePromise
    closePromise = (async () => {
      await abortCleanupPromise
      await cleanupProcessProbes()
      const pending = [...cleanups].reverse()
      cleanups.clear()
      await Promise.allSettled(pending.map((cleanup) => cleanup()))
      await Promise.all(lateCleanups.splice(0))
      await cleanupProcessProbes()
    })()
    return closePromise
  }

  return Object.freeze({
    signal: controller.signal,
    addCleanup,
    abort,
    close,
    throwIfAborted,
  })
}
