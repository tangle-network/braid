export class ConnectionSetupTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`Connection setup exceeded its ${timeoutMs}ms deadline`)
    this.name = 'ConnectionSetupTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export class ConnectionSetupCancelledError extends Error {
  constructor() {
    super('Connection setup was cancelled')
    this.name = 'ConnectionSetupCancelledError'
  }
}

/** Run the complete health-plus-capabilities probe under one cancellable deadline. */
export async function withConnectionSetupDeadline<T>(input: {
  readonly timeoutMs: number
  readonly signal?: AbortSignal
  readonly work: (signal: AbortSignal) => Promise<T>
}): Promise<T> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error('Connection setup timeout must be a positive integer')
  }
  if (input.signal?.aborted === true) throw new ConnectionSetupCancelledError()
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectDeadline: ((error: Error) => void) | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject
  })
  const cancel = (): void => {
    controller.abort(input.signal?.reason)
    rejectDeadline?.(new ConnectionSetupCancelledError())
  }
  input.signal?.addEventListener('abort', cancel, { once: true })
  timer = setTimeout(() => {
    const error = new ConnectionSetupTimeoutError(input.timeoutMs)
    controller.abort(error)
    rejectDeadline?.(error)
  }, input.timeoutMs)
  try {
    return await Promise.race([input.work(controller.signal), deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    input.signal?.removeEventListener('abort', cancel)
  }
}
