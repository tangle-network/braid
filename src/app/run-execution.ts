import type { AgentProfile } from '@tangle-network/agent-interface'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import {
  boundedText,
  MAX_INTERACTION_FIELDS,
  MAX_TEXT_BYTES,
  redactSensitiveText,
  truncateUtf8,
  utf8Bytes,
} from '../domain/bounds.js'
import { canonicalDigest } from '../domain/canonical.js'
import type { TurnUsage } from '../domain/events.js'
import type { ExecutionPort } from '../ports/execution.js'
import type { InteractionReceiveResult, ReceiveInteractionInput } from '../ports/interactions.js'
import { assertRuntimeSessionId, runtimeQuestionRequest } from './runtime-interaction.js'
import type { ApplicationStateStore } from './application-state.js'
import { RuntimeStreamBudget } from './runtime-stream-budget.js'

export interface RunExecutionInput {
  readonly operationId: string
  readonly runId: string
  readonly text: string
  readonly signal: AbortController
}

export class RunExecutionService {
  readonly #execution: ExecutionPort
  readonly #profile: Readonly<AgentProfile>
  readonly #protectedValues: readonly string[]
  readonly #state: ApplicationStateStore
  readonly #receiveQuestion: (
    input: ReceiveInteractionInput,
  ) => InteractionReceiveResult & { readonly automation: Promise<unknown> }
  #activeAbort: AbortController | undefined

  constructor(options: {
    readonly execution: ExecutionPort
    readonly profile: Readonly<AgentProfile>
    readonly protectedValues: readonly string[]
    readonly state: ApplicationStateStore
    readonly receiveQuestion: (
      input: ReceiveInteractionInput,
    ) => InteractionReceiveResult & { readonly automation: Promise<unknown> }
  }) {
    this.#execution = options.execution
    this.#profile = options.profile
    this.#protectedValues = options.protectedValues
    this.#state = options.state
    this.#receiveQuestion = options.receiveQuestion
  }

  start(input: RunExecutionInput): Promise<void> {
    this.#activeAbort = input.signal
    return this.#execute(input)
  }

  cancelActive(): boolean {
    if (!this.#activeAbort || this.#activeAbort.signal.aborted) return false
    this.#activeAbort.abort(new Error('Cancelled by user'))
    return true
  }

  async #execute(input: RunExecutionInput): Promise<void> {
    let terminalSeen = false
    let sessionId: string | undefined
    try {
      const stream = this.#execution.streamTurn({
        operationId: input.operationId,
        runId: input.runId,
        text: input.text,
        profile: this.#profile,
        signal: input.signal.signal,
      })
      const streamBudget = new RuntimeStreamBudget()
      for await (const runtimeEvent of stream) {
        streamBudget.accept(runtimeEvent)
        if (terminalSeen) throw new Error('Runtime stream emitted data after its final event')
        if (runtimeEvent.type === 'session_created' || runtimeEvent.type === 'session_resumed') {
          assertRuntimeSessionId(runtimeEvent.session.id)
          sessionId = runtimeEvent.session.id
          this.#state.commit({
            kind: 'run.session.bound',
            runId: input.runId,
            providerSessionId: sessionId,
          })
        } else if (runtimeEvent.type === 'questions_start') {
          if (runtimeEvent.questions.length > MAX_INTERACTION_FIELDS) {
            throw new Error('Runtime question batch exceeds the interaction limit')
          }
          const requests = runtimeEvent.questions.map(runtimeQuestionRequest)
          for (const request of requests) {
            this.#receiveRuntimeQuestion(input.runId, sessionId, request)
          }
        } else if (runtimeEvent.type === 'text_delta' && runtimeEvent.text) {
          const current =
            this.#state
              .state()
              .messages.find(
                (message) => message.runId === input.runId && message.role === 'assistant',
              )?.text ?? ''
          const remaining = Math.max(0, MAX_TEXT_BYTES - utf8Bytes(current))
          const delta = truncateUtf8(
            redactSensitiveText(runtimeEvent.text, this.#protectedValues, MAX_TEXT_BYTES),
            remaining,
          )
          if (delta) this.#state.commit({ kind: 'run.text.delta', runId: input.runId, text: delta })
        } else if (runtimeEvent.type === 'final') {
          this.#state.commit({
            kind: 'run.finished',
            runId: input.runId,
            status: runtimeEvent.status,
            finalText: redactSensitiveText(
              runtimeEvent.text ?? '',
              this.#protectedValues,
              MAX_TEXT_BYTES,
            ),
            usage: usageFromFinal(runtimeEvent),
            ...(runtimeEvent.error
              ? { error: redactSensitiveText(runtimeEvent.error.message, this.#protectedValues) }
              : {}),
          })
          terminalSeen = true
        }
      }
      if (!terminalSeen) throw new Error('Runtime stream ended without a final event')
    } catch (error) {
      if (!terminalSeen) {
        this.#state.commit({
          kind: 'run.finished',
          runId: input.runId,
          status: input.signal.signal.aborted ? 'aborted' : 'failed',
          finalText: '',
          usage: { input: 0, output: 0 },
          error: redactSensitiveText(
            error instanceof Error ? error.message : String(error),
            this.#protectedValues,
          ),
        })
      }
    } finally {
      if (this.#activeAbort === input.signal) this.#activeAbort = undefined
    }
  }

  #receiveRuntimeQuestion(
    runId: string,
    providerSessionId: string | undefined,
    request: ReturnType<typeof runtimeQuestionRequest>,
  ): void {
    const state = this.#state.state()
    const run = state.runs.find((candidate) => candidate.id === runId)
    this.#receiveQuestion({
      runId,
      ...(providerSessionId === undefined ? {} : { providerSessionId }),
      profileDigest: canonicalDigest(state.profile),
      ...(state.workspace === null ? {} : { workspaceId: state.workspace }),
      ...(run?.conversationId === undefined ? {} : { conversationId: run.conversationId }),
      ...(run?.branchId === undefined ? {} : { branchId: run.branchId }),
      ...(run?.model === undefined ? {} : { model: run.model }),
      ...(typeof state.profile.harness === 'string' ? { runner: state.profile.harness } : {}),
      request,
    })
  }
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
  const model = typeof metadata.model === 'string' ? boundedText(metadata.model, 512) : undefined
  return {
    input,
    output,
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(model ? { model } : {}),
  }
}
