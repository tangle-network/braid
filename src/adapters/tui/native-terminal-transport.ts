import type {
  AgentTerminalSession,
  TerminalDetachAck,
  TerminalOutputEvent,
} from '@tangle-network/agent-interface'
import type {
  NativeTerminalCleanup,
  NativeTerminalCleanupIssue,
  NativeTerminalTransport,
  NativeTerminalTransportInput,
  NativeTerminalTransportOutcome,
  NativeTerminalTransportPhase,
  NativeTerminalTransportResult,
} from '../../ports/native-terminal-transport.js'

const DEFAULT_DETACH_CHORD = '\u001d'
const DEFAULT_CLEANUP_TIMEOUT_MS = 1_000

export function createNativeTerminalTransport(
  input: NativeTerminalTransportInput,
): NativeTerminalTransport {
  let runPromise: Promise<NativeTerminalTransportResult> | undefined
  return Object.freeze({
    run: (options?: { readonly signal?: AbortSignal }) => {
      runPromise ??= runTransport(input, options?.signal)
      return runPromise
    },
  })
}

async function runTransport(
  input: NativeTerminalTransportInput,
  callerSignal: AbortSignal | undefined,
): Promise<NativeTerminalTransportResult> {
  const session = input.session
  const sessionId = session.ref.terminalSessionId
  const detachChord = input.detachChord ?? DEFAULT_DETACH_CHORD
  const cleanupTimeoutMs =
    input.cleanupTimeoutMs === undefined || !Number.isFinite(input.cleanupTimeoutMs)
      ? DEFAULT_CLEANUP_TIMEOUT_MS
      : Math.min(30_000, Math.max(0, Math.floor(input.cleanupTimeoutMs)))
  const transportAbort = new AbortController()
  let finished = false
  let terminalStartAttempted = false
  let outcome: NativeTerminalTransportOutcome | undefined
  let signalRelease: (() => void) | undefined
  let forwardingBusy = false
  let forwardingTail = Promise.resolve()
  let detachRequested = false
  let settleOutcome: (value: NativeTerminalTransportOutcome) => void = () => {}
  const outcomeReady = new Promise<NativeTerminalTransportOutcome>((resolve) => {
    settleOutcome = resolve
  })
  const finish = (next: NativeTerminalTransportOutcome): void => {
    if (finished) return
    finished = true
    outcome = next
    transportAbort.abort()
    settleOutcome(next)
  }
  const enqueue = (
    phase: Extract<NativeTerminalTransportPhase, 'input' | 'resize'>,
    operation: () => Promise<void>,
  ): void => {
    const run = async (): Promise<void> => {
      if (finished) return
      forwardingBusy = true
      try {
        await operation()
      } catch (error) {
        finish(transportError(sessionId, phase, error))
      } finally {
        forwardingBusy = false
      }
    }
    forwardingTail = forwardingBusy ? forwardingTail.then(run) : run()
  }
  const requestDetach = (): void => {
    if (detachRequested || finished) return
    detachRequested = true
    // Finish immediately so the lifecycle aborts in-flight forwarding and skips queued operations.
    finish({ kind: 'detached', sessionId, trigger: 'user' })
  }
  const onInput = (data: string): void => {
    if (finished) return
    const chordAt = data.indexOf(detachChord)
    const forwarded = chordAt < 0 ? data : data.slice(0, chordAt)
    if (forwarded.length > 0) {
      enqueue('input', () => session.input({ data: forwarded }, { signal: transportAbort.signal }))
    }
    if (chordAt >= 0) requestDetach()
  }
  const onResize = (): void => {
    if (finished) return
    const cols = input.terminal.columns
    const rows = input.terminal.rows
    enqueue('resize', () => session.resize({ cols, rows }, { signal: transportAbort.signal }))
  }
  const onSignal = (exitCode: number): void =>
    finish({ kind: 'aborted', sessionId, source: 'signal', exitCode })
  const onCallerAbort = (): void => finish({ kind: 'aborted', sessionId, source: 'caller' })
  const consumeEvents = async (): Promise<void> => {
    try {
      for await (const event of session.events({ signal: transportAbort.signal })) {
        if (finished) return
        if (event.type === 'output') {
          input.terminal.write(event.data)
          continue
        }
        if (event.type === 'exit') {
          finish(remoteExit(sessionId, event))
          return
        }
        if (event.type === 'error') {
          finish(transportError(sessionId, 'events', new Error(event.message)))
          return
        }
      }
      if (!finished) {
        finish(
          transportError(
            sessionId,
            'events',
            new Error('terminal event stream ended without exit'),
          ),
        )
      }
    } catch (error) {
      if (!finished) finish(transportError(sessionId, 'events', error))
    }
  }
  const issues: NativeTerminalCleanupIssue[] = []
  let terminalCleanup: NativeTerminalCleanup['terminal'] = 'not-started'
  let signalCleanup: NativeTerminalCleanup['signal'] = 'not-installed'
  let remoteCleanup: NativeTerminalCleanup['remote'] = 'not-required'
  let callerAbortCleanup: (() => void) | undefined
  try {
    if (callerSignal?.aborted) onCallerAbort()
    else if (callerSignal !== undefined) {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true })
      callerAbortCleanup = () => callerSignal.removeEventListener('abort', onCallerAbort)
    }

    if (!finished && input.signals !== undefined) {
      try {
        signalRelease = input.signals.takeOver(onSignal)
      } catch (error) {
        finish(transportError(sessionId, 'signal-install', error))
      }
    }
    if (!finished) {
      terminalStartAttempted = true
      try {
        input.terminal.start(onInput, onResize)
      } catch (error) {
        finish(transportError(sessionId, 'terminal-start', error))
      }
    }
    if (!finished) {
      void consumeEvents()
      await outcomeReady
    }
  } catch (error) {
    if (!finished) finish(transportError(sessionId, 'terminal-start', error))
  } finally {
    callerAbortCleanup?.()
    transportAbort.abort()
    outcome ??= transportError(sessionId, 'events', new Error('transport ended without an outcome'))
    if (signalRelease !== undefined) {
      try {
        signalRelease()
        signalCleanup = 'restored'
      } catch (error) {
        signalCleanup = 'failed'
        issues.push({ phase: 'signal-release', message: errorMessage(error) })
      }
    }
    if (terminalStartAttempted) {
      try {
        input.terminal.stop()
        terminalCleanup = 'restored'
      } catch (error) {
        terminalCleanup = 'failed'
        issues.push({ phase: 'terminal-stop', message: errorMessage(error) })
      }
    }
    if (shouldDetach(outcome)) {
      const detach = await detachRemote(session, cleanupTimeoutMs)
      remoteCleanup = detach.remote
      if (detach.issue !== undefined) issues.push(detach.issue)
      if (detach.remote === 'closed' && outcome.kind === 'detached') {
        const closed = detach.ack?.status === 'closed' ? detach.ack : undefined
        outcome = {
          kind: 'remote-exit',
          sessionId,
          reason: 'closed-during-detach',
          ...(closed?.exitCode === undefined ? {} : { exitCode: closed.exitCode }),
          ...(closed?.exitSignal === undefined ? {} : { exitSignal: closed.exitSignal }),
        }
      }
    }
  }
  return {
    outcome,
    cleanup: {
      terminal: terminalCleanup,
      signal: signalCleanup,
      remote: remoteCleanup,
      issues: Object.freeze(issues),
    },
  }
}
function shouldDetach(outcome: NativeTerminalTransportOutcome): boolean {
  return (
    outcome.kind === 'detached' || outcome.kind === 'aborted' || outcome.kind === 'transport-error'
  )
}

function transportError(
  sessionId: string,
  phase: NativeTerminalTransportPhase,
  error: unknown,
): NativeTerminalTransportOutcome {
  return { kind: 'transport-error', sessionId, phase, message: errorMessage(error) }
}

function remoteExit(
  sessionId: string,
  event: Extract<TerminalOutputEvent, { type: 'exit' }>,
): NativeTerminalTransportOutcome {
  return {
    kind: 'remote-exit',
    sessionId,
    reason: 'exited',
    ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
    ...(event.exitSignal === undefined ? {} : { exitSignal: event.exitSignal }),
  }
}
async function detachRemote(
  session: AgentTerminalSession,
  timeoutMs: number,
): Promise<{
  readonly remote: NativeTerminalCleanup['remote']
  readonly ack?: TerminalDetachAck
  readonly issue?: NativeTerminalCleanupIssue
}> {
  const controller = new AbortController()
  let timedOut = false
  try {
    const acknowledgement = await settleWithin(
      session.detach({ signal: controller.signal }),
      timeoutMs,
      () => {
        timedOut = true
        controller.abort()
      },
    )
    if (acknowledgement === undefined) {
      return {
        remote: 'unknown',
        issue: { phase: 'remote-detach', message: 'remote detach did not settle before cleanup' },
      }
    }
    if (acknowledgement.status === 'detached') return { remote: 'detached', ack: acknowledgement }
    if (acknowledgement.status === 'closed') return { remote: 'closed', ack: acknowledgement }
    return {
      remote: 'unknown',
      ack: acknowledgement,
      issue: { phase: 'remote-detach', message: acknowledgement.message },
    }
  } catch (error) {
    return {
      remote: 'unknown',
      issue: {
        phase: 'remote-detach',
        message: timedOut ? 'remote detach did not settle before cleanup' : errorMessage(error),
      },
    }
  }
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          onTimeout?.()
          resolve(undefined)
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 512 ? `${message.slice(0, 509)}...` : message
}
