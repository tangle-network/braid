import {
  type ChatResponse,
  type CustomTokenPricing,
  costForTokenPricing,
  resolveModelPricing,
} from '@tangle-network/agent-eval'
import type {
  ExternalOptimizerModelCall,
  ExternalOptimizerModelCallRequest,
  ExternalOptimizerModelExecutionObservation,
} from '@tangle-network/agent-eval/campaign'
import { type AgentProfile, snapshotAgentProfile } from '@tangle-network/agent-interface'
import {
  type BackendRetryPolicy,
  createOpenAICompatibleBackend,
  type OpenAIChatResponseFormat,
  type RuntimeStreamEvent,
  runAgentTaskStream,
} from '@tangle-network/agent-runtime'
import { canonicalDigest } from '../../domain/canonical.js'
import type { ConnectionRecord } from '../../domain/entities.js'
import { redactProfile, redactProviderError } from '../../domain/redaction.js'
import { AGENT_RUNTIME_VERSION } from '../runtime/agent-runtime-version.js'

const LOCAL_BRIDGE_API_KEY_MARKER = 'braid-local-cli-bridge'
const MAX_RETAINED_EXECUTIONS = 256

type ModelExecutionRecorder = (observation: ExternalOptimizerModelExecutionObservation) => void

export interface RuntimeTraceModelOwnerOptions {
  readonly profile: Readonly<AgentProfile>
  readonly connection: Readonly<Pick<ConnectionRecord, 'id' | 'kind' | 'updatedAt'>>
  readonly baseUrl: string
  readonly credential?: string
  readonly model: string
  readonly pricing?: CustomTokenPricing
  readonly fetch?: typeof fetch
  readonly retry?: BackendRetryPolicy
  readonly recordExecution?: ModelExecutionRecorder
}

export interface RuntimeTraceModelOwner {
  readonly call: ExternalOptimizerModelCall
  readonly callRef: string
  readonly recordExecution: ModelExecutionRecorder
  readonly pricing?: CustomTokenPricing
  readonly executions: () => readonly ExternalOptimizerModelExecutionObservation[]
}

interface RuntimeCallSummary {
  readonly events: readonly RuntimeStreamEvent[]
  readonly status: 'completed' | 'failed' | 'aborted' | 'blocked'
  readonly reason: string
  readonly content: string
  readonly durationMs: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly usageCaptured: boolean
  readonly reportedModel?: string
  readonly finishReason?: string
  readonly errorKind?: string
  readonly errorStatus?: number
}

function catalogPricing(model: string): CustomTokenPricing | undefined {
  const pricing = resolveModelPricing(model)
  if (pricing === null) return undefined
  return {
    inputUsdPerMillion: pricing.input * 1_000,
    outputUsdPerMillion: pricing.output * 1_000,
  }
}

function responseFormat(
  request: ExternalOptimizerModelCallRequest['request'],
): OpenAIChatResponseFormat | undefined {
  if (request.jsonSchema !== undefined) {
    return {
      type: 'json_schema',
      json_schema: {
        name: request.jsonSchema.name,
        schema: request.jsonSchema.schema,
        strict: true,
      },
    }
  }
  return request.jsonMode === true ? { type: 'json_object' } : undefined
}

function textMessages(
  request: ExternalOptimizerModelCallRequest['request'],
): Array<{ role: string; content: string }> {
  return request.messages.map((message, index) => {
    if (typeof message.content !== 'string') {
      throw new TypeError(
        `Runtime trace analysis supports text messages only; message ${index} is multimodal`,
      )
    }
    return { role: message.role, content: message.content }
  })
}

function assertRequestSupported(request: ExternalOptimizerModelCallRequest['request']): void {
  if (request.thinking !== undefined) {
    throw new TypeError(
      'agent-runtime 0.128.0 does not expose a provider-neutral thinking field for chat requests; configure reasoning on the AgentProfile instead',
    )
  }
}

function eventFacts(events: readonly RuntimeStreamEvent[]): Readonly<Record<string, number>> {
  const counts = new Map<string, number>()
  for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
  return Object.freeze(
    Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right))),
  )
}

function summarizeRuntimeEvents(
  events: readonly RuntimeStreamEvent[],
  startedAt: number,
): RuntimeCallSummary {
  const final = events.at(-1)
  if (final?.type !== 'final') {
    throw new Error(
      `agent-runtime model call ended without a final event (last: ${final?.type ?? 'none'})`,
    )
  }
  const calls = events.filter(
    (event): event is Extract<RuntimeStreamEvent, { readonly type: 'llm_call' }> =>
      event.type === 'llm_call',
  )
  const usageCaptured =
    calls.length > 0 &&
    calls.every(
      (event) =>
        Number.isSafeInteger(event.tokensIn) &&
        (event.tokensIn ?? -1) >= 0 &&
        Number.isSafeInteger(event.tokensOut) &&
        (event.tokensOut ?? -1) >= 0,
    )
  const lastCall = calls.at(-1)
  return {
    events,
    status: final.status,
    reason: final.reason,
    content:
      final.text ??
      events
        .filter(
          (event): event is Extract<RuntimeStreamEvent, { readonly type: 'text_delta' }> =>
            event.type === 'text_delta',
        )
        .map((event) => event.text)
        .join(''),
    durationMs: Math.max(0, Date.now() - startedAt),
    inputTokens: usageCaptured
      ? calls.reduce((total, event) => total + (event.tokensIn ?? 0), 0)
      : 0,
    outputTokens: usageCaptured
      ? calls.reduce((total, event) => total + (event.tokensOut ?? 0), 0)
      : 0,
    usageCaptured,
    ...(lastCall?.model === undefined ? {} : { reportedModel: lastCall.model }),
    ...(lastCall?.finishReason === undefined ? {} : { finishReason: lastCall.finishReason }),
    ...(final.error?.kind === undefined ? {} : { errorKind: final.error.kind }),
    ...(final.error?.status === undefined ? {} : { errorStatus: final.error.status }),
  }
}

function receiptFor(
  model: string,
  pricing: CustomTokenPricing | undefined,
  usage: Pick<RuntimeCallSummary, 'inputTokens' | 'outputTokens' | 'usageCaptured'>,
  knownNoExecution = false,
): import('@tangle-network/agent-eval').CostReceiptInput {
  if (!usage.usageCaptured && !knownNoExecution) {
    return {
      model,
      inputTokens: 0,
      outputTokens: 0,
      usageUnknown: true,
      costUnknown: true,
    }
  }
  const receipt = {
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  }
  if (pricing !== undefined) return { ...receipt, customTokenPricing: pricing }
  if (usage.inputTokens === 0 && usage.outputTokens === 0) {
    return { ...receipt, estimatedCostUsd: 0 }
  }
  return { ...receipt, costUnknown: true }
}

function responseFor(
  request: ExternalOptimizerModelCallRequest,
  summary: RuntimeCallSummary,
  pricing: CustomTokenPricing | undefined,
): ChatResponse {
  const receipt = receiptFor(request.request.model, pricing, summary)
  const costUsd =
    summary.usageCaptured && pricing !== undefined ? costForTokenPricing(pricing, receipt) : null
  const raw = {
    source: '@tangle-network/agent-runtime',
    version: AGENT_RUNTIME_VERSION,
    eventDigest: String(
      canonicalDigest({
        types: eventFacts(summary.events),
        status: summary.status,
        output: String(canonicalDigest(summary.content)),
      }),
    ),
  }
  return {
    content: summary.content,
    usage: {
      promptTokens: summary.inputTokens,
      completionTokens: summary.outputTokens,
      totalTokens: summary.inputTokens + summary.outputTokens,
      captured: summary.usageCaptured,
    },
    costUsd,
    model: request.request.model,
    durationMs: summary.durationMs,
    ...(summary.finishReason === undefined ? {} : { finishReason: summary.finishReason }),
    contentEmpty: summary.content.trim().length === 0,
    raw,
  }
}

function executionEvidence(input: {
  readonly request: ExternalOptimizerModelCallRequest
  readonly callRef: string
  readonly profileDigest: string
  readonly connection: RuntimeTraceModelOwnerOptions['connection']
  readonly retry: BackendRetryPolicy
  readonly summary?: RuntimeCallSummary
  readonly dispatched: boolean
  readonly partialEvents?: readonly RuntimeStreamEvent[]
  readonly startedAt: number
  readonly failure?: string
}): Readonly<Record<string, unknown>> {
  const summary = input.summary
  return Object.freeze({
    schema: 'braid.runtime-model-execution.v1',
    runtime: {
      package: '@tangle-network/agent-runtime',
      version: AGENT_RUNTIME_VERSION,
      operation: 'runAgentTaskStream',
    },
    callId: input.request.callId,
    callRef: input.callRef,
    profileDigest: input.profileDigest,
    connection: {
      id: String(input.connection.id),
      kind: input.connection.kind,
      updatedAt: input.connection.updatedAt,
    },
    transport: {
      maxAttempts: input.retry.maxAttempts ?? 1,
      ...(input.retry.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: input.retry.requestTimeoutMs }),
    },
    endpointFormat: input.request.endpointFormat ?? 'chat-completions',
    model: input.request.request.model,
    requestDigest: String(canonicalDigest(input.request.request)),
    durationMs: summary?.durationMs ?? Math.max(0, Date.now() - input.startedAt),
    dispatched: input.dispatched,
    ...(summary === undefined
      ? {}
      : {
          terminal: {
            status: summary.status,
            reason: summaryFailure(summary),
            ...(summary.errorKind === undefined ? {} : { errorKind: summary.errorKind }),
            ...(summary.errorStatus === undefined ? {} : { errorStatus: summary.errorStatus }),
          },
          usage: {
            captured: summary.usageCaptured,
            inputTokens: summary.inputTokens,
            outputTokens: summary.outputTokens,
            ...(summary.reportedModel === undefined
              ? {}
              : { reportedModel: summary.reportedModel }),
          },
          events: eventFacts(summary.events),
          outputDigest: String(canonicalDigest(summary.content)),
        }),
    ...(summary !== undefined || input.partialEvents === undefined
      ? {}
      : { events: eventFacts(input.partialEvents) }),
    ...(input.failure === undefined ? {} : { failure: input.failure }),
  })
}

function summaryFailure(summary: RuntimeCallSummary): string {
  if (summary.status === 'completed') return 'Agent Runtime model execution completed'
  if (summary.errorStatus !== undefined) {
    return `Agent Runtime model execution failed with HTTP ${summary.errorStatus}`
  }
  if (summary.status === 'aborted') return 'Agent Runtime model execution was cancelled'
  return `Agent Runtime model execution failed (${summary.errorKind ?? summary.status})`
}

function publicError(value: unknown, dispatched: boolean): string {
  if (!dispatched && value instanceof Error) return value.message
  return redactProviderError(value instanceof Error ? value.message : String(value))
}

/**
 * Owns one trace-analysis model route without giving Agent Eval a credential.
 * Agent Runtime performs the request and supplies the normalized evidence.
 */
export function createRuntimeTraceModelOwner(
  options: RuntimeTraceModelOwnerOptions,
): RuntimeTraceModelOwner {
  // Analyst calls settle one receipt per invocation. Keep retries explicit so a
  // single recorded invocation cannot conceal multiple paid provider requests.
  const retry = Object.freeze({ maxAttempts: 1, ...options.retry })
  const profileDigest = String(
    canonicalDigest(redactProfile(snapshotAgentProfile(options.profile))),
  )
  const callRef = `braid-agent-runtime:${String(
    canonicalDigest({
      version: 1,
      runtimeVersion: AGENT_RUNTIME_VERSION,
      profileDigest,
      connection: {
        id: String(options.connection.id),
        kind: options.connection.kind,
        updatedAt: options.connection.updatedAt,
      },
      endpoint: options.baseUrl,
      model: options.model,
      retry,
    }),
  )}`
  const pricing = options.pricing ?? catalogPricing(options.model)
  const retained: ExternalOptimizerModelExecutionObservation[] = []
  const recordExecution: ModelExecutionRecorder = (observation) => {
    const snapshot = structuredClone(observation)
    retained.push(snapshot)
    if (retained.length > MAX_RETAINED_EXECUTIONS) retained.shift()
    options.recordExecution?.(structuredClone(snapshot))
  }

  const call: ExternalOptimizerModelCall = async (request) => {
    const startedAt = Date.now()
    const events: RuntimeStreamEvent[] = []
    let dispatched = false
    let summary: RuntimeCallSummary | undefined
    try {
      if (request.request.model !== options.model) {
        throw new TypeError(
          `Runtime model route expected '${options.model}', received '${request.request.model}'`,
        )
      }
      assertRequestSupported(request.request)
      const messages = textMessages(request.request)
      const format = responseFormat(request.request)
      const backend = createOpenAICompatibleBackend({
        apiKey: options.credential ?? LOCAL_BRIDGE_API_KEY_MARKER,
        baseUrl: options.baseUrl,
        model: options.model,
        kind: `braid-analysis:${options.connection.kind}`,
        ...(request.request.maxTokens === undefined
          ? {}
          : { maxTokens: request.request.maxTokens }),
        ...(request.request.temperature === undefined
          ? {}
          : { temperature: request.request.temperature }),
        ...(format === undefined ? {} : { responseFormat: format }),
        ...(options.fetch === undefined ? {} : { fetchImpl: options.fetch }),
        retry,
      })
      dispatched = true
      for await (const event of runAgentTaskStream({
        task: {
          id: `braid-analysis-${request.callId}`,
          intent: 'Execute one bounded trace-analysis model call',
        },
        backend,
        input: { messages },
        signal: request.signal,
      })) {
        events.push(event)
      }
      summary = summarizeRuntimeEvents(events, startedAt)
      const evidence = executionEvidence({
        request,
        callRef,
        profileDigest,
        connection: options.connection,
        retry,
        summary,
        dispatched,
        startedAt,
      })
      if (summary.status !== 'completed') {
        return {
          succeeded: false,
          error: summaryFailure(summary),
          receipt: receiptFor(options.model, pricing, summary),
          execution: evidence,
        }
      }
      return {
        succeeded: true,
        response: responseFor(request, summary, pricing),
        receipt: receiptFor(options.model, pricing, summary),
        execution: evidence,
      }
    } catch (error) {
      const message = publicError(error, dispatched)
      return {
        succeeded: false,
        error: message,
        receipt: receiptFor(
          options.model,
          pricing,
          summary ?? { inputTokens: 0, outputTokens: 0, usageCaptured: false },
          !dispatched,
        ),
        execution: executionEvidence({
          request,
          callRef,
          profileDigest,
          connection: options.connection,
          retry,
          ...(summary === undefined ? {} : { summary }),
          dispatched,
          ...(events.length === 0 ? {} : { partialEvents: events }),
          startedAt,
          failure: message,
        }),
      }
    }
  }

  return Object.freeze({
    call,
    callRef,
    recordExecution,
    ...(pricing === undefined ? {} : { pricing }),
    executions: () => retained.map((observation) => structuredClone(observation)),
  })
}
