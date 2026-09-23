import type { TraceAnalystSpan } from '@tangle-network/agent-eval'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import { canonicalDigest } from '../domain/canonical.js'
import type { BraidEvent, TurnUsage } from '../domain/events.js'
import type { BraidState } from '../domain/state.js'
import type { ExecutionPort } from '../ports/execution.js'
import type { IdSource } from '../ports/ids.js'
import { runtimeTraceForEvents } from './analysis-source.js'
import { AppError } from './errors.js'
import { receiptIdForOperation } from './operation-authority.js'
import { ApplicationReceiptService } from './application-receipts.js'
import { ApplicationStateStore } from './application-state.js'
import { sanitizeDiagnosticText } from '../analysis/diagnostics.js'

export interface SendInput {
  readonly operationId: string
  readonly text: string
  readonly conversationId?: string
  readonly branchId?: string
}

export interface SendReceipt {
  readonly operationId: string
  readonly runId: string
  readonly revision: number
  readonly replayed: boolean
  readonly completion: Promise<BraidState>
}

export interface ApplicationRunCancellationReceipt {
  readonly operationId: string
  readonly runId: string
  readonly status: 'accepted' | 'replayed'
  readonly effect: 'requested'
  readonly receiptId: string
}

interface RunOperation {
  readonly runId: string
  completion: Promise<void>
}

function usageFromFinal(event: Extract<RuntimeStreamEvent, { type: 'final' }>): TurnUsage {
  const metadata = event.metadata ?? {}
  const tokenUsage =
    metadata.tokenUsage && typeof metadata.tokenUsage === 'object'
      ? (metadata.tokenUsage as Record<string, unknown>)
      : {}
  const input = typeof tokenUsage.input === 'number' ? tokenUsage.input : null
  const output = typeof tokenUsage.output === 'number' ? tokenUsage.output : null
  const costUsd = typeof metadata.costUsd === 'number' ? metadata.costUsd : undefined
  const model = typeof metadata.model === 'string' ? metadata.model : undefined
  return {
    input,
    output,
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(model === undefined ? {} : { model }),
  }
}

/** Owns admission, streaming, cancellation, runtime-event capture, and idle waits. */
export class ApplicationRunService {
  readonly #state: ApplicationStateStore
  readonly #execution: ExecutionPort
  readonly #ids: IdSource
  readonly #receipts: ApplicationReceiptService
  readonly #runtimeEvents = new Map<string, RuntimeStreamEvent[]>()
  readonly #traceSpans = new Map<string, TraceAnalystSpan[]>()
  #activeAbort: AbortController | undefined
  #selectedAnalysisRunId: string | undefined

  constructor(options: {
    readonly state: ApplicationStateStore
    readonly execution: ExecutionPort
    readonly ids: IdSource
    readonly receipts: ApplicationReceiptService
  }) {
    this.#state = options.state
    this.#execution = options.execution
    this.#ids = options.ids
    this.#receipts = options.receipts
  }

  analysisRunId(): string | undefined {
    return this.#selectedAnalysisRunId
  }

  analysisTraces(): readonly {
    readonly traceId: string
    readonly spans: readonly TraceAnalystSpan[]
  }[] {
    return [...this.#runtimeEvents.entries()].map(([runId, events]) => {
      const cacheKey = `trace-${runId}`
      let spans = this.#traceSpans.get(cacheKey)
      if (!spans) {
        spans = [...runtimeTraceForEvents(runId, events)]
        this.#traceSpans.set(cacheKey, spans)
      }
      const traceId = spans[0]?.trace_id ?? cacheKey
      return { traceId, spans: structuredClone(spans) }
    })
  }

  send(input: SendInput): SendReceipt {
    const state = this.#state.state()
    if (state.workspace === null)
      throw new AppError('NOT_INITIALIZED', 'Initialize a workspace before sending')
    if (!input.operationId) throw new AppError('OPERATION_ID_REQUIRED', 'send requires operationId')
    if (!input.text.trim()) throw new AppError('EMPTY_MESSAGE', 'Message must not be empty')
    const conversationId = input.conversationId ?? state.conversationId
    const branchId = input.branchId ?? state.branchId
    if (conversationId !== state.conversationId || branchId !== state.branchId)
      throw new AppError('UNKNOWN_BRANCH', 'The requested conversation branch is not open')
    const digest = canonicalDigest({
      command: 'send',
      conversationId,
      branchId,
      text: input.text,
      profile: state.profile,
    })
    const previous = this.#receipts.read<RunOperation>(input.operationId, digest)
    if (previous) {
      const operation = this.#receipts.requireResult(previous, 'The send operation result is not available')
      return {
        operationId: input.operationId,
        runId: operation.runId,
        revision: this.#state.state().revision,
        replayed: true,
        completion: operation.completion.then(() => this.#state.state()),
      }
    }
    if (state.activeRunId) throw new AppError('RUN_ACTIVE', `Run ${state.activeRunId} is still active`)
    if (state.draft !== input.text) this.#state.commit({ kind: 'draft.changed', text: input.text })
    const runId = this.#ids.next('run')
    this.#selectedAnalysisRunId = runId
    this.#state.commit({
      kind: 'run.requested',
      operationId: input.operationId,
      runId,
      turnId: this.#ids.next('turn'),
      userMessageId: this.#ids.next('message'),
      assistantMessageId: this.#ids.next('message'),
      text: input.text,
    })
    const operation: RunOperation = { runId, completion: Promise.resolve() }
    this.#receipts.setResult(input.operationId, digest, operation)
    const abort = new AbortController()
    this.#activeAbort = abort
    operation.completion = this.#execute(input.operationId, runId, input.text, abort)
    return {
      operationId: input.operationId,
      runId,
      revision: this.#state.state().revision,
      replayed: false,
      completion: operation.completion.then(() => this.#state.state()),
    }
  }

  cancelActive(): boolean {
    const state = this.#state.state()
    const runId = state.activeRunId
    if (!runId || !this.#activeAbort || this.#activeAbort.signal.aborted) return false
    const run = state.runs.find((entry) => entry.id === runId)
    if (!run) return false
    const receipt = this.cancelRun({
      operationId: `cancel-${run.operationId}`,
      runId,
      reason: 'Cancelled by user',
    })
    return receipt.status === 'accepted' || receipt.status === 'replayed'
  }

  cancelRun(input: {
    readonly operationId: string
    readonly runId: string
    readonly reason: string
  }): ApplicationRunCancellationReceipt {
    if (!input.operationId || !input.runId)
      throw new AppError('OPERATION_ID_REQUIRED', 'Cancellation requires operationId and runId')
    const targetId = `run:${input.runId}`
    const safeInput = {
      ...input,
      reason: sanitizeDiagnosticText(input.reason, 'Cancelled by user'),
    }
    const digest = canonicalDigest({ kind: 'cancel-run', targetId, input: safeInput })
    const previous = this.#receipts.read<ApplicationRunCancellationReceipt>(input.operationId, digest)
    if (previous) {
      const result = this.#receipts.requireResult(previous, 'Cancellation result is not available')
      return { ...result, status: 'replayed' }
    }
    if (this.#state.state().activeRunId !== input.runId)
      throw new AppError('RUN_NOT_ACTIVE', `Run ${input.runId} is not active`)
    const abort = this.#activeAbort
    if (!abort || abort.signal.aborted)
      throw new AppError('RUN_NOT_ACTIVE', `Run ${input.runId} is no longer cancellable`)
    abort.abort(new Error(safeInput.reason))
    const result: ApplicationRunCancellationReceipt = {
      operationId: input.operationId,
      runId: input.runId,
      status: 'accepted',
      effect: 'requested',
      receiptId: receiptIdForOperation(input.operationId, targetId),
    }
    this.#receipts.setResult(input.operationId, digest, result)
    this.#receipts.publish(input.operationId, targetId, result)
    return result
  }

  async waitForIdle(): Promise<BraidState> {
    const state = this.#state.state()
    const activeRun = state.activeRunId
    if (!activeRun) return state
    const run = state.runs.find((entry) => entry.id === activeRun)
    const operation = run ? this.#receipts.result<RunOperation>(run.operationId) : undefined
    if (operation) await operation.completion
    return this.#state.state()
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
        profile: this.#state.state().profile,
        signal: abort.signal,
      })
      for await (const runtimeEvent of stream) {
        const events = this.#runtimeEvents.get(runId) ?? []
        events.push(structuredClone(runtimeEvent))
        this.#runtimeEvents.set(runId, events)
        this.#traceSpans.delete(`trace-${runId}`)
        if (runtimeEvent.type === 'text_delta' && runtimeEvent.text) {
          this.#state.commit({ kind: 'run.text.delta', runId, text: runtimeEvent.text })
        } else if (runtimeEvent.type === 'final') {
          terminalSeen = true
          this.#state.commit({
            kind: 'run.finished',
            runId,
            status: runtimeEvent.status,
            finalText: runtimeEvent.text ?? '',
            usage: usageFromFinal(runtimeEvent),
            ...(runtimeEvent.error
              ? { error: sanitizeDiagnosticText(runtimeEvent.error.message) }
              : {}),
          })
        }
      }
      if (!terminalSeen) throw new Error('Runtime stream ended without a final event')
    } catch (error) {
      if (!terminalSeen) {
        const message = sanitizeDiagnosticText(
          error instanceof Error ? error.message : String(error),
        )
        this.#state.commit({
          kind: 'run.finished',
          runId,
          status: abort.signal.aborted ? 'aborted' : 'failed',
          finalText: '',
          usage: { input: null, output: null },
          error: message,
        })
      }
    } finally {
      if (this.#activeAbort === abort) this.#activeAbort = undefined
    }
  }
}
