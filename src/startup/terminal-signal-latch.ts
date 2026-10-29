const TERMINAL_EXIT_CODES = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
} as const

type TerminalSignal = keyof typeof TERMINAL_EXIT_CODES
export type TerminalSignalExitCode = (typeof TERMINAL_EXIT_CODES)[TerminalSignal]

export interface TerminalSignalLatch {
  readonly takeOver: (handler: (exitCode: TerminalSignalExitCode) => void) => () => void
  readonly consumeFrameRequest: () => boolean
  readonly dispose: () => void
}

export function createTerminalSignalLatch(
  initialHandler: (exitCode: TerminalSignalExitCode) => void,
): TerminalSignalLatch {
  let handler = initialHandler
  let latched: TerminalSignalExitCode | undefined
  let frameRequested = false
  let disposed = false
  const onFrameSignal = () => (frameRequested = true)
  const listeners = Object.fromEntries(
    Object.entries(TERMINAL_EXIT_CODES).map(([signal, exitCode]) => [
      signal,
      () => {
        if (latched !== undefined) return
        latched = exitCode
        handler(exitCode)
      },
    ]),
  ) as Record<TerminalSignal, () => void>

  for (const signal of Object.keys(TERMINAL_EXIT_CODES) as TerminalSignal[])
    process.on(signal, listeners[signal])
  process.on('SIGUSR2', onFrameSignal)

  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const signal of Object.keys(TERMINAL_EXIT_CODES) as TerminalSignal[])
      process.off(signal, listeners[signal])
    process.off('SIGUSR2', onFrameSignal)
  }

  return Object.freeze({
    takeOver: (nextHandler: (exitCode: TerminalSignalExitCode) => void) => {
      handler = nextHandler
      if (latched !== undefined) nextHandler(latched)
      return dispose
    },
    consumeFrameRequest: () => {
      const requested = frameRequested
      frameRequested = false
      return requested
    },
    dispose,
  })
}
