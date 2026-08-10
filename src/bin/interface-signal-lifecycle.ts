import type { BraidApplication } from '../app/application.js'
import type { StartupPreview } from '../startup/preview-runtime.js'
import type { BraidTerminalApp } from '../views/tui/terminal-app.js'
import type { BraidUiController } from '../views/shared/intents.js'
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
  readonly dispose: () => void
  readonly exitCode: () => number
}

export function createInterfaceSignalLifecycle(
  input: InterfaceSignalLifecycleInput,
): InterfaceSignalLifecycle {
  let signalExitCode: number | undefined
  let signalSnapshot: Promise<void> | undefined
  let frameSnapshot: Promise<void> | undefined
  let signalCleanup: Promise<void> | undefined
  let disposed = false
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
  const onFrameSnapshot = () => {
    if (input.recordState)
      frameSnapshot ??= recordInterfaceState(
        `${input.recordState}.frame`,
        input.controller,
        'atomic-signal-frame',
      )
  }
  const onInterrupt = () => stopFromSignal(130)
  const onTerminate = () => stopFromSignal(143)
  const onHangup = () => stopFromSignal(129)
  const releaseTerminationSignals = input.startupPreview?.takeSignalOwnership(stopFromSignal)
  if (releaseTerminationSignals === undefined) {
    process.once('SIGINT', onInterrupt)
    process.once('SIGTERM', onTerminate)
    process.once('SIGHUP', onHangup)
  }
  process.once('SIGUSR2', onFrameSnapshot)

  return Object.freeze({
    interrupted: () => signalExitCode !== undefined,
    settle: async () => {
      await signalCleanup
      await signalSnapshot
      await frameSnapshot
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
