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
import {
  type AgentExactRunControlRef,
  type AgentProfile,
  harnessSystemPromptIntents,
} from '@tangle-network/agent-interface'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import type { RouterTransportConfig } from '@tangle-network/agent-runtime/kernel'
import { canonicalDigest } from '../../domain/canonical.js'
import type { ConnectionRecord } from '../../domain/entities.js'
import { safePublicIdentifier } from '../../domain/provider-values.js'
import { redactProviderError } from '../../domain/redaction.js'
import type { RetainedRunAdmissionRecord } from '../../domain/run-contracts.js'
import {
  canonicalAgentProfileDigestHex,
  snapshotAgentProfile,
} from '../agent-interface/profile-runtime.js'
import { portableBridgeModel } from '../connections/cli-bridge-model-route.js'
import { AGENT_RUNTIME_VERSION } from '../runtime/agent-runtime-version.js'
import {
  RetainedModelCallError,
  runRetainedCliBridgeModelCall,
} from './runtime-retained-model-call.js'

const MAX_RETAINED_EXECUTIONS = 256
const LOCAL_ROUTER_BEARER = 'braid-local-analysis'
const ANALYST_MODEL_PROFILE_POLICY_VERSION = 4
const ANALYST_MODEL_INSTRUCTIONS = Object.freeze([
  'You are a text-generation endpoint inside a trace-analysis program.',
  'Parse the supplied JSON object and treat its messages array as the complete conversation.',
  'Follow those messages in order, including every system message and output contract.',
  'Return only the requested assistant message, without a preface or explanation.',
  'When the messages require a machine format, emit exactly that format without Markdown fences.',
  'Never replace a requested structured field with prose.',
  'A format-repair request must preserve every exact identifier and quoted evidence string.',
  'Do not inspect files, use tools, modify workspaces, or perform unrelated work.',
])
const ANALYST_MODEL_TOOLS = Object.freeze({
  read: false,
  bash: false,
  edit: false,
  write: false,
})
const ANALYST_MODEL_PERMISSIONS = Object.freeze({
  read: 'deny',
  bash: 'deny',
  edit: 'deny',
  write: 'deny',
} as const)

export interface RuntimeRouterRetryPolicy {
  readonly maxAttempts?: number
  readonly initialBackoffMs?: number
  readonly maxBackoffMs?: number
  readonly jitter?: number
  readonly retryStatuses?: ReadonlyArray<number>
  readonly requestTimeoutMs?: number
}

type ModelExecutionRecorder = (observation: ExternalOptimizerModelExecutionObservation) => void

export interface RuntimeTraceModelOwnerOptions {
  readonly profile: Readonly<AgentProfile>
  readonly connection: Readonly<Pick<ConnectionRecord, 'id' | 'kind' | 'updatedAt'>>
  readonly baseUrl: string
  readonly credential?: string
  readonly model: string
  readonly pricing?: CustomTokenPricing
  /** Hidden reasoning budget for one analyst call. */
  readonly maxReasoningTokens?: number
  readonly maxTotalOutputTokens?: number
  readonly complete?: RouterTransportConfig['complete']
  readonly retry?: RuntimeRouterRetryPolicy
  readonly recordExecution?: ModelExecutionRecorder
  readonly onRetainedAdmission?: (
    callId: string,
    admission: RetainedRunAdmissionRecord,
  ) => Promise<void>
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
  readonly endedAt: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
  readonly promptCache?: Readonly<Record<string, number | string>>
  readonly observedCostUsd?: number
  readonly estimatedCostUsd?: number
  readonly usageCaptured: boolean
  readonly reportedModel?: string
  readonly finishReason?: string
  readonly errorKind?: string
  readonly errorStatus?: number
}

type RuntimeModelOperation = 'startRetainedRun' | 'streamAgentTurn'

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
): Readonly<Record<string, unknown>> | undefined {
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
  const errorStatus = final.error?.status ?? httpStatusFromReason(final.reason)
  const endedAt = Date.now()
  const promptCache = promptCacheFacts(calls)
  const cachedTokens = sumPromptCache(promptCache, ['cachedTokens', 'cacheReadTokens'])
  const cacheWriteTokens = sumPromptCache(promptCache, ['cacheWriteTokens'])
  const reasoningTokens = finiteTokenCount(final.metadata?.reasoningTokens)
  const observedCostUsd = completeCallAmount(calls, 'costUsd', (event) => event.usdKnown !== false)
  const estimatedCostUsd = completeCallAmount(calls, 'estimatedCostUsd')
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
    durationMs: Math.max(0, endedAt - startedAt),
    endedAt,
    inputTokens: usageCaptured
      ? calls.reduce((total, event) => total + (event.tokensIn ?? 0), 0)
      : 0,
    outputTokens: usageCaptured
      ? calls.reduce((total, event) => total + (event.tokensOut ?? 0), 0)
      : 0,
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(Object.keys(promptCache).length === 0 ? {} : { promptCache }),
    ...(observedCostUsd === undefined ? {} : { observedCostUsd }),
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
    usageCaptured,
    ...(lastCall?.model === undefined ? {} : { reportedModel: lastCall.model }),
    ...(lastCall?.finishReason === undefined ? {} : { finishReason: lastCall.finishReason }),
    ...(final.error?.kind === undefined ? {} : { errorKind: final.error.kind }),
    ...(errorStatus === undefined ? {} : { errorStatus }),
  }
}

function summarizeRetainedResult(
  result: import('@tangle-network/agent-interface/environment-provider').AgentTurnResult,
  model: string,
  startedAt: number,
): RuntimeCallSummary {
  const endedAt = Date.now()
  const inputTokens = finiteTokenCount(result.usage?.inputTokens)
  const outputTokens = finiteTokenCount(result.usage?.outputTokens)
  const usageCaptured = inputTokens !== undefined && outputTokens !== undefined
  const errorStatus = result.error === undefined ? undefined : httpStatusFromReason(result.error)
  const cachedTokens = finiteTokenCount(result.usage?.cacheReadInputTokens)
  const cacheWriteTokens = finiteTokenCount(result.usage?.cacheCreationInputTokens)
  const observedCostUsd = finiteNumber(result.usage?.cost)
  const reasoningTokens = finiteTokenCount(result.usage?.reasoningTokens)
  return {
    events: [],
    status: result.success ? 'completed' : 'failed',
    reason: result.success
      ? 'Retained model execution completed'
      : (result.error ?? 'Retained model execution failed'),
    content: result.text,
    durationMs: Math.max(0, endedAt - startedAt),
    endedAt,
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(observedCostUsd === undefined ? {} : { observedCostUsd }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    usageCaptured,
    reportedModel: model,
    ...(!result.success ? { errorKind: 'backend' } : {}),
    ...(errorStatus === undefined ? {} : { errorStatus }),
  }
}

function finiteTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function completeCallAmount(
  calls: readonly Extract<RuntimeStreamEvent, { readonly type: 'llm_call' }>[],
  field: 'costUsd' | 'estimatedCostUsd',
  accepts: (event: Extract<RuntimeStreamEvent, { readonly type: 'llm_call' }>) => boolean = () =>
    true,
): number | undefined {
  if (
    calls.length === 0 ||
    !calls.every((event) => accepts(event) && finiteNumber(event[field]) !== undefined)
  ) {
    return undefined
  }
  return calls.reduce((total, event) => total + (finiteNumber(event[field]) ?? 0), 0)
}

function promptCacheFacts(
  calls: readonly Extract<RuntimeStreamEvent, { readonly type: 'llm_call' }>[],
): Readonly<Record<string, number | string>> {
  const values = new Map<string, number | string>()
  for (const call of calls) {
    for (const [key, value] of Object.entries(call.promptCache ?? {})) {
      if (typeof value !== 'number' && typeof value !== 'string') continue
      if (typeof value === 'number' && !Number.isFinite(value)) continue
      values.set(key, value)
    }
  }
  return Object.freeze(Object.fromEntries(values))
}

function sumPromptCache(
  facts: Readonly<Record<string, number | string>>,
  keys: readonly string[],
): number | undefined {
  const values = keys
    .map((key) => finiteNumber(facts[key]))
    .filter((value): value is number => value !== undefined)
  return values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0)
}

function httpStatusFromReason(reason: string): number | undefined {
  const match = /(?:^|\b)HTTP\s+([1-5][0-9]{2})(?:\b|$)/iu.exec(reason)
  if (match?.[1] === undefined) return undefined
  const status = Number(match[1])
  return Number.isSafeInteger(status) ? status : undefined
}

function safeModelRoute(value: unknown): string {
  return safePublicIdentifier(value) ?? 'unknown-model'
}

function receiptFor(
  model: string,
  pricing: CustomTokenPricing | undefined,
  usage: Pick<
    RuntimeCallSummary,
    | 'inputTokens'
    | 'outputTokens'
    | 'usageCaptured'
    | 'observedCostUsd'
    | 'cachedTokens'
    | 'cacheWriteTokens'
    | 'reasoningTokens'
  >,
  knownNoExecution = false,
): import('@tangle-network/agent-eval').CostReceiptInput {
  const safeModel = safeModelRoute(model)
  if (!usage.usageCaptured && !knownNoExecution) {
    return {
      model: safeModel,
      inputTokens: 0,
      outputTokens: 0,
      usageUnknown: true,
      ...(usage.observedCostUsd === undefined
        ? { costUnknown: true }
        : { actualCostUsd: usage.observedCostUsd }),
    }
  }
  const receipt = {
    model: safeModel,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cachedTokens === undefined ? {} : { cachedTokens: usage.cachedTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  }
  if (usage.observedCostUsd !== undefined) {
    return { ...receipt, actualCostUsd: usage.observedCostUsd }
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
  const model = safeModelRoute(request.request.model)
  const receipt = receiptFor(model, pricing, summary)
  const promptTokens = summary.inputTokens + (summary.cachedTokens ?? 0)
  const costUsd =
    summary.observedCostUsd ??
    (summary.usageCaptured && pricing !== undefined ? costForTokenPricing(pricing, receipt) : null)
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
      promptTokens,
      completionTokens: summary.outputTokens,
      totalTokens: promptTokens + summary.outputTokens,
      captured: summary.usageCaptured,
      ...(summary.cachedTokens === undefined ? {} : { cachedPromptTokens: summary.cachedTokens }),
      ...(summary.reasoningTokens === undefined
        ? {}
        : { reasoningTokens: summary.reasoningTokens }),
    },
    costUsd,
    model,
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
  readonly retry: RuntimeRouterRetryPolicy
  readonly provider?: string
  readonly pricing?: CustomTokenPricing
  readonly receipt?: import('@tangle-network/agent-eval').CostReceiptInput
  readonly summary?: RuntimeCallSummary
  readonly dispatched: boolean
  readonly partialEvents?: readonly RuntimeStreamEvent[]
  readonly startedAt: number
  readonly failure?: string
  readonly operation: RuntimeModelOperation
  readonly controlRef?: AgentExactRunControlRef
}): Readonly<Record<string, unknown>> {
  const summary = input.summary
  const endedAt = summary?.endedAt ?? Date.now()
  const cost = costFacts(input.receipt, input.pricing, summary, input.dispatched)
  return Object.freeze({
    schema: 'braid.runtime-model-execution.v1',
    runtime: {
      package: '@tangle-network/agent-runtime',
      version: AGENT_RUNTIME_VERSION,
      operation: input.operation,
    },
    ...(input.provider === undefined ? {} : { provider: input.provider }),
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
    route: `${input.connection.kind}/${input.request.endpointFormat ?? 'chat-completions'}`,
    model: safeModelRoute(input.request.request.model),
    requestDigest: String(canonicalDigest(input.request.request)),
    startedAt: new Date(input.startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: summary?.durationMs ?? Math.max(0, endedAt - input.startedAt),
    billing: cost,
    dispatched: input.dispatched,
    ...(input.controlRef === undefined
      ? {}
      : {
          retained: {
            runId: input.controlRef.runId,
            environmentId: input.controlRef.environmentId,
            sessionId: input.controlRef.sessionId,
            executionId: input.controlRef.executionId,
            requestDigest: input.controlRef.requestDigest,
          },
        }),
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
            ...(summary.cachedTokens === undefined ? {} : { cachedTokens: summary.cachedTokens }),
            ...(summary.cacheWriteTokens === undefined
              ? {}
              : { cacheWriteTokens: summary.cacheWriteTokens }),
            ...(summary.reasoningTokens === undefined
              ? {}
              : { reasoningTokens: summary.reasoningTokens }),
            ...(summary.promptCache === undefined ? {} : { promptCache: summary.promptCache }),
            ...(summary.reportedModel === undefined
              ? {}
              : { reportedModel: safeModelRoute(summary.reportedModel) }),
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

function costFacts(
  receipt: import('@tangle-network/agent-eval').CostReceiptInput | undefined,
  pricing: CustomTokenPricing | undefined,
  summary: RuntimeCallSummary | undefined,
  dispatched: boolean,
): Readonly<Record<string, number | string>> {
  if (!dispatched || receipt === undefined) return { status: 'unknown' }
  if (receipt.actualCostUsd !== undefined && finiteNumber(receipt.actualCostUsd) !== undefined) {
    return { status: 'observed', usd: receipt.actualCostUsd }
  }
  if (
    receipt.estimatedCostUsd !== undefined &&
    finiteNumber(receipt.estimatedCostUsd) !== undefined
  ) {
    return { status: 'estimated', usd: receipt.estimatedCostUsd }
  }
  if (summary?.observedCostUsd !== undefined) {
    return { status: 'observed', usd: summary.observedCostUsd }
  }
  // Use the receipt pricing before a runner estimate. This keeps call details equal to the aggregate.
  if (summary?.usageCaptured === true && pricing !== undefined) {
    const estimated = costForTokenPricing(pricing, receipt)
    return { status: 'estimated', usd: estimated }
  }
  if (summary?.estimatedCostUsd !== undefined) {
    return { status: 'estimated', usd: summary.estimatedCostUsd }
  }
  return { status: 'unknown' }
}

function summaryFailure(summary: RuntimeCallSummary): string {
  if (summary.status === 'completed') return 'Agent Runtime model execution completed'
  if (summary.errorStatus !== undefined) {
    return `Agent Runtime model execution failed with HTTP ${summary.errorStatus}`
  }
  if (summary.status === 'aborted') return 'Agent Runtime model execution was cancelled'
  return `Agent Runtime model execution failed (${safePublicIdentifier(summary.errorKind) ?? 'provider-error'})`
}

function publicError(value: unknown): string {
  return redactProviderError(value instanceof Error ? value.message : String(value))
}

function analystCallProfile(
  options: RuntimeTraceModelOwnerOptions,
  request: ExternalOptimizerModelCallRequest['request'],
  retry: RuntimeRouterRetryPolicy,
): AgentProfile {
  const source = snapshotAgentProfile(options.profile)
  const provider = source.model?.provider?.trim()
  const bridge = options.connection.kind === 'cli-bridge'
  if (!bridge && !provider) {
    throw new TypeError(
      'Trace analysis requires AgentProfile.model.provider before model execution',
    )
  }
  let harness: AgentProfile['harness'] = 'cli-base'
  let model = safeModelRoute(options.model)
  let prompt: AgentProfile['prompt'] | undefined
  if (bridge) {
    const bridgeHarness = source.harness
    if (bridgeHarness === undefined) {
      throw new TypeError('CLI Bridge trace analysis requires AgentProfile.harness')
    }
    const authoredModel = source.model?.default?.trim()
    if (authoredModel === undefined || authoredModel.length === 0) {
      throw new TypeError('CLI Bridge trace analysis requires AgentProfile.model.default')
    }
    harness = bridgeHarness
    model = portableBridgeModel(bridgeHarness, authoredModel)
    prompt = analystModelPrompt(bridgeHarness)
  }
  const format = responseFormat(request)
  const sourceReasoning = source.model?.reasoningEffort
  const reasoningEffort =
    request.thinking === 'disabled'
      ? 'none'
      : request.thinking === 'enabled' &&
          (sourceReasoning === undefined || sourceReasoning === 'none')
        ? 'minimal'
        : sourceReasoning
  const maxVisibleOutputTokens = request.maxTokens ?? source.model?.maxVisibleOutputTokens
  const maxReasoningTokens = options.maxReasoningTokens ?? source.model?.maxReasoningTokens
  const maxTotalOutputTokens = options.maxTotalOutputTokens ?? source.model?.maxTotalOutputTokens
  if (
    maxTotalOutputTokens !== undefined &&
    ((maxVisibleOutputTokens !== undefined && maxVisibleOutputTokens > maxTotalOutputTokens) ||
      (maxReasoningTokens !== undefined && maxReasoningTokens > maxTotalOutputTokens) ||
      (maxVisibleOutputTokens !== undefined &&
        maxReasoningTokens !== undefined &&
        maxVisibleOutputTokens + maxReasoningTokens > maxTotalOutputTokens))
  ) {
    throw new RangeError(
      'Trace analysis execution limits exceed AgentProfile.model.maxTotalOutputTokens',
    )
  }
  const enforceableTotalOutputTokens =
    maxTotalOutputTokens ??
    (maxVisibleOutputTokens === undefined || maxReasoningTokens === undefined
      ? undefined
      : maxVisibleOutputTokens + maxReasoningTokens)
  return snapshotAgentProfile({
    name: `${source.name ?? 'Braid'} trace analyst`,
    description: 'One bounded trace-analysis model call',
    harness,
    ...(prompt === undefined ? {} : { prompt }),
    ...(bridge
      ? {
          tools: { ...ANALYST_MODEL_TOOLS },
          permissions: { ...ANALYST_MODEL_PERMISSIONS },
          ...(harness === 'pi' ? { extensions: { pi: { load: [] } } } : {}),
        }
      : {}),
    model: {
      default: model,
      ...(provider === undefined ? {} : { provider }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(bridge || maxVisibleOutputTokens === undefined ? {} : { maxVisibleOutputTokens }),
      ...(enforceableTotalOutputTokens === undefined
        ? {}
        : { maxTotalOutputTokens: enforceableTotalOutputTokens }),
      metadata: {
        ...(bridge ? {} : { retry }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(format === undefined ? {} : { extraBody: { response_format: format } }),
      },
    },
  })
}

function analystModelPrompt(harness: NonNullable<AgentProfile['harness']>): AgentProfile['prompt'] {
  const text = ANALYST_MODEL_INSTRUCTIONS.join('\n')
  const intents = harnessSystemPromptIntents(harness)
  if (intents.replace) return { systemPrompt: text }
  if (intents.append) return { appendSystemPrompt: text }
  return { instructions: [...ANALYST_MODEL_INSTRUCTIONS] }
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
  const sourceProfileDigest = canonicalAgentProfileDigestHex(options.profile)
  const callRef = `braid-agent-runtime:${String(
    canonicalDigest({
      version: ANALYST_MODEL_PROFILE_POLICY_VERSION,
      runtimeVersion: AGENT_RUNTIME_VERSION,
      profileDigest: sourceProfileDigest,
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
    let executionProfileDigest = sourceProfileDigest
    const operation: RuntimeModelOperation =
      options.connection.kind === 'cli-bridge' ? 'startRetainedRun' : 'streamAgentTurn'
    let controlRef: AgentExactRunControlRef | undefined
    try {
      const configuredModel = safePublicIdentifier(options.model)
      if (configuredModel === undefined) {
        throw new TypeError('Runtime model route is invalid')
      }
      if (request.request.model !== options.model) {
        throw new TypeError(
          `Runtime model route expected '${configuredModel}', received '${safeModelRoute(request.request.model)}'`,
        )
      }
      const messages = textMessages(request.request)
      const profile = analystCallProfile(options, request.request, retry)
      executionProfileDigest = canonicalAgentProfileDigestHex(profile)
      if (options.connection.kind === 'cli-bridge') {
        const onRetainedAdmission = options.onRetainedAdmission
        if (onRetainedAdmission === undefined) {
          throw new TypeError('CLI Bridge trace analysis requires durable admission storage')
        }
        dispatched = true
        const retained = await runRetainedCliBridgeModelCall({
          baseUrl: options.baseUrl,
          bearerToken: options.credential ?? LOCAL_ROUTER_BEARER,
          profile,
          model: configuredModel,
          messages,
          callId: request.callId,
          signal: request.signal,
          onAdmission: (admission) => onRetainedAdmission(request.callId, admission),
        })
        controlRef = retained.controlRef
        summary = summarizeRetainedResult(retained.result, configuredModel, startedAt)
      } else {
        dispatched = true
        const { createExecutor, streamAgentTurn } = await import(
          '@tangle-network/agent-runtime/kernel'
        )
        const executor = createExecutor({
          backend: 'router',
          routerBaseUrl: options.baseUrl,
          routerKey: options.credential ?? LOCAL_ROUTER_BEARER,
          ...(options.complete === undefined ? {} : { complete: options.complete }),
        })
        const backend = Object.freeze({
          kind: 'executor' as const,
          factory: executor,
          profile,
          agentRunName: configuredModel,
        })
        for await (const event of streamAgentTurn(
          backend,
          { prompt: JSON.stringify({ messages }) },
          {
            signal: request.signal,
            callId: request.callId,
            correlationId: `braid-analysis-${request.callId}`,
          },
        )) {
          events.push(event)
        }
        summary = summarizeRuntimeEvents(events, startedAt)
      }
      const receipt = receiptFor(options.model, pricing, summary)
      const evidence = executionEvidence({
        request,
        callRef,
        profileDigest: executionProfileDigest,
        connection: options.connection,
        retry,
        ...(profile.model?.provider === undefined ? {} : { provider: profile.model.provider }),
        ...(pricing === undefined ? {} : { pricing }),
        receipt,
        summary,
        dispatched,
        startedAt,
        operation,
        ...(controlRef === undefined ? {} : { controlRef }),
      })
      if (summary.status !== 'completed') {
        return {
          succeeded: false,
          error: summaryFailure(summary),
          receipt,
          execution: evidence,
        }
      }
      return {
        succeeded: true,
        response: responseFor(request, summary, pricing),
        receipt,
        execution: evidence,
      }
    } catch (error) {
      if (error instanceof RetainedModelCallError) controlRef = error.controlRef
      const message = publicError(error)
      const receipt = receiptFor(
        options.model,
        pricing,
        summary ?? { inputTokens: 0, outputTokens: 0, usageCaptured: false },
        !dispatched,
      )
      return {
        succeeded: false,
        error: message,
        receipt,
        execution: executionEvidence({
          request,
          callRef,
          profileDigest: executionProfileDigest,
          connection: options.connection,
          retry,
          ...(options.profile.model?.provider === undefined
            ? {}
            : { provider: options.profile.model.provider }),
          ...(pricing === undefined ? {} : { pricing }),
          receipt,
          ...(summary === undefined ? {} : { summary }),
          dispatched,
          ...(events.length === 0 ? {} : { partialEvents: events }),
          startedAt,
          operation,
          ...(controlRef === undefined ? {} : { controlRef }),
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
