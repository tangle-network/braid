import type { AgentProfile } from '@tangle-network/agent-interface'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import type { BraidEvent, TurnUsage } from '../domain/events.js'
import { redactProviderError, redactSensitiveText } from '../domain/redaction.js'
import type { BraidState } from '../domain/state.js'
import type { ExecutionPort } from '../ports/execution.js'

export interface RunLifecycleOptions {
  readonly execution: ExecutionPort
  readonly profile: Readonly<AgentProfile>
  readonly cancelTimeoutMs: number
  readonly state: () => BraidState
  readonly commit: (event: BraidEvent) => void
}

function usageFromFinal(event: Extract<RuntimeStreamEvent, { type: 'final' }>): TurnUsage {
  const metadata = event.metadata ?? {}
  const tokenUsage =
    metadata.tokenUsage && typeof metadata.tokenUsage === 'object'
      ? (metadata.tokenUsage as Record<string, unknown>)
      : {}
  const input = typeof tokenUsage.input === 'number' ? tokenUsage.input : 0
  const output = typeof tokenUsage.output === 'number' ? tokenUsage.output : 0
  const costUsd = typeof metadata.costUsd === 'number' ? metadata.costUsd : undefined
  const model = typeof metadata.model === 'string' ? metadata.model : undefined
  return {
    input,
    output,
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(model === undefined ? {} : { model }),
  }
}

export class RunLifecycle {
  readonly #execution: ExecutionPort
  readonly #executionProfile: Readonly<AgentProfile>
  readonly #cancelTimeoutMs: number
  readonly #state: () => BraidState
  readonly #commit: (event: BraidEvent) => void
  readonly #cancellationRequested = new Set<string>()
  readonly #terminalizedRuns = new Set<string>()
  #activeAbort: AbortController | undefined

  constructor(options: RunLifecycleOptions) {
    this.#execution = options.execution
    this.#executionProfile = options.profile
    this.#cancelTimeoutMs = options.cancelTimeoutMs
    this.#state = options.state
    this.#commit = options.commit
  }

  get hasActiveExecution(): boolean {
    return this.#activeAbort !== undefined && !this.#activeAbort.signal.aborted
  }

  canCancel(): boolean {
    return this.#execution.capabilities?.cancel === true && this.#execution.cancelRun !== undefined
  }

  execute(operationId: string, runId: string, text: string): Promise<void> {
    const abort = new AbortController()
    this.#activeAbort = abort
    return this.#execute(operationId, runId, text, abort)
  }

  startCancellation(operationId: string, runId: string, reason: string): Promise<void> {
    this.#cancellationRequested.add(runId)
    this.#commit({
      kind: 'run.cancel.requested',
      operationId,
      runId,
      reason,
    })
    const providerResult = this.#execution.cancelRun
      ? this.#execution.cancelRun({ operationId, runId, reason }).catch((error) => ({
          status: 'unknown' as const,
          reason: redactProviderError(error),
        }))
      : Promise.resolve({
          status: 'unknown' as const,
          reason:
            'Cancellation outcome could not be confirmed because the runtime adapter does not expose provider cancellation',
        })
    if (this.#activeAbort && !this.#activeAbort.signal.aborted)
      this.#activeAbort.abort(new Error(reason))
    return this.#waitForCancellation(runId, providerResult)
  }

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
  ): Promise<void> {
    let terminalSeen = false
    try {
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
          this.#commit({
            kind: 'run.text.delta',
            runId,
            text: redactSensitiveText(runtimeEvent.text),
          })
        } else if (runtimeEvent.type === 'final') {
          terminalSeen = true
          this.#commit({
            kind: 'run.finished',
            runId,
            status: runtimeEvent.status,
            finalText: runtimeEvent.text ?? '',
            usage: usageFromFinal(runtimeEvent),
            ...(runtimeEvent.error
              ? { error: redactProviderError(runtimeEvent.error.message) }
              : {}),
          })
        }
      }
      if (!terminalSeen && !this.#terminalizedRuns.has(runId))
        throw new Error('Runtime stream ended without a final event')
    } catch (error) {
      if (
        !terminalSeen &&
        !this.#terminalizedRuns.has(runId) &&
        !this.#cancellationRequested.has(runId)
      ) {
        const message = redactProviderError(error)
        this.#commit({
          kind: 'run.finished',
          runId,
          status: abort.signal.aborted ? 'aborted' : 'failed',
          finalText: '',
          usage: { input: 0, output: 0 },
          error: message,
        })
      }
    } finally {
      if (this.#activeAbort === abort) this.#activeAbort = undefined
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
      this.#activeAbort?.abort(new Error('Cancellation reconciliation complete'))
      this.#commit({
        kind: 'run.finished',
        runId,
        status: outcome.status === 'cancelled' ? 'aborted' : 'unknown',
        finalText: '',
        usage: { input: run.inputTokens, output: run.outputTokens },
        error:
          outcome.status === 'cancelled'
            ? 'Cancellation acknowledged by the provider'
            : redactSensitiveText(outcome.reason ?? 'Cancellation outcome could not be confirmed'),
      })
    } finally {
      if (timer) clearTimeout(timer)
      this.#cancellationRequested.delete(runId)
    }
  }
}
