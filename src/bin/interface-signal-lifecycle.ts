import type { BraidApplication } from '../app/application.js'
import type { StartupPreview } from '../startup/preview-runtime.js'
import type { BraidUiController } from '../views/shared/intents.js'
import type { BraidTerminalApp } from '../views/tui/terminal-app.js'
import { recordInterfaceState } from './interface-state-recorder.js'

interface InterfaceSignalLifecycleInput {
  readonly controller: BraidUiController
  readonly view: Pick<BraidTerminalApp, 'stop'>
  readonly application: Pick<BraidApplication, 'markCleanupUncertain'>
  readonly nextOperationId: () => string
  readonly recordState?: string
  readonly startupPreview?: StartupPreview
}

export interface InterfaceSignalLifecycle {
  readonly interrupted: () => boolean
  readonly settle: () => Promise<void>
  /** Temporarily route termination signals to a native terminal attachment. */
  readonly takeOver: (handler: (exitCode: number) => void) => () => void
  readonly dispose: () => void
  readonly exitCode: () => number
}

export function createInterfaceSignalLifecycle(
  input: InterfaceSignalLifecycleInput,
): InterfaceSignalLifecycle {
  let signalExitCode: number | undefined
  let signalSnapshot: Promise<void> | undefined
  let frameSnapshot = Promise.resolve()
  let signalCleanup: Promise<void> | undefined
  let disposed = false
  let signalHandler: (exitCode: number) => void
  let signalTakeoverActive = false
  const shutdownMode =
    process.env.BRAID_SHUTDOWN_MODE === 'detach' ? ('detach' as const) : ('cancel' as const)
  const configuredDeadline = Number(process.env.BRAID_SHUTDOWN_DEADLINE_MS ?? 5_000)
  const shutdownDeadlineMs = Number.isInteger(configuredDeadline)
    ? Math.min(30_000, Math.max(250, configuredDeadline))
    : 5_000
  const stopFromSignal = (exitCode: number) => {
    signalExitCode ??= exitCode
    if (process.env.BRAID_CAPTURE_STATE_BEFORE_CANCEL === '1' && input.recordState) {
      signalSnapshot ??= recordInterfaceState(`${input.recordState}.signal`, input.controller)
    }
    signalCleanup ??= (async () => {
      const cleanup = input.controller
        .dispatch({
          type: 'shutdown',
          operationId: input.nextOperationId(),
          mode: shutdownMode,
        })
        .then(async (result) => {
          if (result.kind === 'accepted' && result.completion) await result.completion
        })
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          cleanup,
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              input.application.markCleanupUncertain(`Shutdown exceeded ${shutdownDeadlineMs} ms`)
              resolve()
            }, shutdownDeadlineMs)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
        input.view.stop()
      }
    })()
  }
  signalHandler = stopFromSignal
  const onFrameSnapshot = () => {
    if (input.recordState)
      frameSnapshot = frameSnapshot.then(() =>
        recordInterfaceState(`${input.recordState}.frame`, input.controller, 'atomic-signal-frame'),
      )
  }
  const onInterrupt = () => signalHandler(130)
  const onTerminate = () => signalHandler(143)
  const onHangup = () => signalHandler(129)
  const releaseTerminationSignals = input.startupPreview?.takeSignalOwnership((exitCode) =>
    signalHandler(exitCode),
  )
  if (releaseTerminationSignals === undefined) {
    process.once('SIGINT', onInterrupt)
    process.once('SIGTERM', onTerminate)
    process.once('SIGHUP', onHangup)
  }
  process.on('SIGUSR2', onFrameSnapshot)

  return Object.freeze({
    interrupted: () => signalExitCode !== undefined,
    settle: async () => {
      await signalCleanup
      await signalSnapshot
      await frameSnapshot
    },
    takeOver: (handler: (exitCode: number) => void) => {
      if (disposed) throw new Error('Termination signal lifecycle is closed')
      if (signalTakeoverActive) throw new Error('Termination signals already have an active owner')
      signalTakeoverActive = true
      let pendingExitCode: number | undefined
      let released = false
      signalHandler = (exitCode) => {
        if (pendingExitCode !== undefined) return
        pendingExitCode = exitCode
        handler(exitCode)
      }
      return () => {
        if (released) return
        released = true
        signalTakeoverActive = false
        signalHandler = stopFromSignal
        if (pendingExitCode !== undefined) stopFromSignal(pendingExitCode)
      }
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      if (releaseTerminationSignals === undefined) {
        process.off('SIGINT', onInterrupt)
        process.off('SIGTERM', onTerminate)
        process.off('SIGHUP', onHangup)
      } else releaseTerminationSignals()
      process.off('SIGUSR2', onFrameSnapshot)
    },
    exitCode: () => signalExitCode ?? 0,
  })
}
