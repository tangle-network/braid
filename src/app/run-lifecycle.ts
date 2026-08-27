import type { AgentProfile } from '@tangle-network/agent-interface'
import type { BraidEvent } from '../domain/events.js'
import type { BraidState } from '../domain/state.js'
import type { ExecutionPort } from '../ports/execution.js'
import type { EffectDispatchResult } from './effect-coordinator.js'
import { IncrementalSanitizer } from '../domain/incremental-sanitizer.js'
import { redactSensitiveText } from '../domain/redaction.js'
import { safeDiagnostic, usageFromFinal } from './provider-values.js'

export interface RunLifecycleOptions {
  readonly execution: ExecutionPort
  /** The unredacted profile the provider needs; never the projected state copy. */
  readonly profile: Readonly<AgentProfile>
  readonly cancelTimeoutMs: number
  readonly state: () => BraidState
  readonly commit: (event: BraidEvent) => void
  readonly flush: () => Promise<void>
}

/**
 * Owns one run's provider stream and its cancellation reconciliation.
 *
 * The dispatch result reported back to the effect coordinator answers a
 * different question from the run status written to the journal. A stream
 * exception after dispatch leaves the external boundary `unknown`, because the
 * provider may already have accepted the turn, while the run itself is a
 * `failed` turn the user can see and retry under a new operation identity.
 */
export class RunLifecycle {
  readonly #execution: ExecutionPort
  readonly #executionProfile: Readonly<AgentProfile>
  readonly #cancelTimeoutMs: number
  readonly #state: () => BraidState
  readonly #commit: (event: BraidEvent) => void
  readonly #flush: () => Promise<void>
  readonly #cancellationRequested = new Set<string>()
  readonly #terminalizedRuns = new Set<string>()
  readonly #textSanitizers = new Map<string, IncrementalSanitizer>()
  #activeAbort: AbortController | undefined

  constructor(options: RunLifecycleOptions) {
    this.#execution = options.execution
    this.#executionProfile = options.profile
    this.#cancelTimeoutMs = options.cancelTimeoutMs
    this.#state = options.state
    this.#commit = options.commit
    this.#flush = options.flush
  }

  get hasActiveExecution(): boolean {
    return this.#activeAbort !== undefined && !this.#activeAbort.signal.aborted
  }

  canCancel(): boolean {
    return this.#execution.capabilities?.cancel === true && this.#execution.cancelRun !== undefined
  }

  execute(operationId: string, runId: string, text: string): Promise<EffectDispatchResult> {
    const abort = new AbortController()
    this.#activeAbort = abort
    if (this.#cancellationRequested.has(runId) || this.#terminalizedRuns.has(runId)) {
      this.#activeAbort = undefined
      return Promise.resolve({ status: 'failed', detail: 'RUN_NOT_DISPATCHED' })
    }
    this.#textSanitizers.set(runId, new IncrementalSanitizer())
    return this.#execute(operationId, runId, text, abort)
  }

  abortActive(reason: string): boolean {
    if (!this.hasActiveExecution) return false
    this.#activeAbort?.abort(new Error(reason))
    return true
  }

  startCancellation(operationId: string, runId: string, reason: string): Promise<void> {
    this.#cancellationRequested.add(runId)
    this.#commit({ kind: 'run.cancel.requested', operationId, runId, reason })
    const providerResult = this.#execution.cancelRun
      ? this.#execution.cancelRun({ operationId, runId, reason }).catch((error) => ({
          status: 'unknown' as const,
          reason: safeDiagnostic(
            error instanceof Error ? error.message : error,
            'PROVIDER_CANCEL_ERROR',
          ),
        }))
      : Promise.resolve({
          status: 'unknown' as const,
          reason:
            'Cancellation outcome could not be confirmed because the runtime adapter does not expose provider cancellation',
        })
    this.abortActive(reason)
    return this.#waitForCancellation(runId, providerResult)
  }

  /**
   * A run that was still active when the process died has no observable
   * outcome, so it is closed as `unknown` rather than guessed as failed.
   */
  reconcileAfterRestart(): void {
    const state = this.#state()
    const run = state.activeRunId
      ? state.runs.find((candidate) => candidate.id === state.activeRunId)
      : undefined
    if (!run) return
    this.#terminalizedRuns.add(run.id)
    this.#commit({
      kind: 'run.finished',
      runId: run.id,
      status: 'unknown',
      finalText: '',
      usage: { input: run.inputTokens, output: run.outputTokens },
      error: 'Provider state is unknown after restart',
    })
  }

  async #execute(
    operationId: string,
    runId: string,
    text: string,
    abort: AbortController,
  ): Promise<EffectDispatchResult> {
    const sanitizer = this.#textSanitizers.get(runId) ?? new IncrementalSanitizer()
    let textFinished = false
    const finishText = (): string => {
      if (textFinished) return ''
      textFinished = true
      return sanitizer.finish()
    }
    const commitPendingText = (): void => {
      const pending = finishText()
      if (pending && !this.#terminalizedRuns.has(runId)) {
        this.#commit({ kind: 'run.text.delta', runId, text: pending })
      }
    }
    let terminalSeen = false
    let terminalDurable = false
    let terminalStatus: string | undefined
    let dispatchStarted = false
    try {
      await this.#flush()
      dispatchStarted = true
      const stream = this.#execution.streamTurn({
        operationId,
        runId,
        text,
        profile: this.#executionProfile,
        signal: abort.signal,
      })
      for await (const runtimeEvent of stream) {
        if (this.#terminalizedRuns.has(runId)) break
        if (runtimeEvent.type === 'text_delta' && runtimeEvent.text) {
          const textDelta = sanitizer.push(runtimeEvent.text)
          if (textDelta) this.#commit({ kind: 'run.text.delta', runId, text: textDelta })
        } else if (runtimeEvent.type === 'final' && !terminalSeen) {
          const pendingText = finishText()
          if (
            runtimeEvent.text === undefined &&
            pendingText &&
            !this.#terminalizedRuns.has(runId)
          ) {
            this.#commit({ kind: 'run.text.delta', runId, text: pendingText })
          }
          const finalText = redactSensitiveText(runtimeEvent.text ?? '')
          terminalStatus = runtimeEvent.status
          this.#commit({
            kind: 'run.finished',
            runId,
            status: runtimeEvent.status,
            finalText,
            usage: usageFromFinal(runtimeEvent),
            ...(runtimeEvent.error
              ? { error: safeDiagnostic(runtimeEvent.error.message, 'RUNTIME_FINAL_ERROR') }
              : {}),
          })
          terminalSeen = true
          await this.#flush()
          terminalDurable = true
          break
        }
      }
      if (!terminalSeen && !this.#terminalizedRuns.has(runId)) {
        throw new Error('Runtime stream ended without a final event')
      }
      return this.#observedOutcome(terminalStatus, dispatchStarted, terminalDurable)
    } catch (error) {
      if (!terminalDurable && !this.#settledElsewhere(runId)) {
        try {
          commitPendingText()
          this.#commit({
            kind: 'run.finished',
            runId,
            status: abort.signal.aborted ? 'aborted' : 'failed',
            finalText: '',
            usage: { input: 0, output: 0 },
            error: safeDiagnostic(
              error instanceof Error ? error.message : error,
              dispatchStarted ? 'RUNTIME_STREAM_ERROR' : 'RUNTIME_DISPATCH_ERROR',
            ),
          })
          await this.#flush()
        } catch (commitError) {
          return {
            status: dispatchStarted ? 'unknown' : 'failed',
            detail: safeDiagnostic(
              commitError instanceof Error ? commitError.message : commitError,
              dispatchStarted ? 'RUNTIME_OUTCOME_NOT_DURABLE' : 'RUNTIME_FAILURE_NOT_DURABLE',
            ),
          }
        }
      }
      return this.#observedOutcome(terminalStatus, dispatchStarted, terminalDurable, error)
    } finally {
      if (!textFinished) sanitizer.finish()
      this.#textSanitizers.delete(runId)
      if (this.#activeAbort === abort) this.#activeAbort = undefined
    }
  }

  #settledElsewhere(runId: string): boolean {
    return this.#terminalizedRuns.has(runId) || this.#cancellationRequested.has(runId)
  }

  #observedOutcome(
    terminalStatus: string | undefined,
    dispatchStarted: boolean,
    terminalDurable: boolean,
    error?: unknown,
  ): EffectDispatchResult {
    if (error !== undefined && !terminalDurable) {
      return {
        status: dispatchStarted ? 'unknown' : 'failed',
        detail: safeDiagnostic(
          error instanceof Error ? error.message : error,
          dispatchStarted ? 'RUNTIME_OUTCOME_UNKNOWN' : 'RUNTIME_DISPATCH_FAILED',
        ),
      }
    }
    return {
      status: terminalStatus === 'completed' ? 'terminal' : 'failed',
      ...(terminalStatus === undefined ? {} : { detail: terminalStatus }),
    }
  }

  async #waitForCancellation(
    runId: string,
    providerResult: Promise<{ readonly status: 'cancelled' | 'unknown'; readonly reason?: string }>,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<{ readonly status: 'unknown'; readonly reason: string }>(
      (resolve) => {
        timer = setTimeout(
          () =>
            resolve({ status: 'unknown', reason: 'Cancellation outcome could not be confirmed' }),
          this.#cancelTimeoutMs,
        )
      },
    )
    try {
      const outcome = await Promise.race([providerResult, timeout])
      const state = this.#state()
      const run = state.runs.find((candidate) => candidate.id === runId)
      if (state.activeRunId !== runId || !run || run.status === 'unknown') return
      this.#terminalizedRuns.add(runId)
      this.abortActive('Cancellation reconciliation complete')
      this.#commit({
        kind: 'run.finished',
        runId,
        status: outcome.status === 'cancelled' ? 'aborted' : 'unknown',
        finalText: '',
        usage: { input: run.inputTokens, output: run.outputTokens },
        error:
          outcome.status === 'cancelled'
            ? 'Cancellation acknowledged by the provider'
            : (outcome.reason ?? 'Cancellation outcome could not be confirmed'),
      })
      await this.#flush()
    } finally {
      if (timer) clearTimeout(timer)
      this.#cancellationRequested.delete(runId)
    }
  }
}
