import {
  type ChatResponse,
  type CustomTokenPricing,
  costForTokenPricing,
  resolveModelPricing,
} from '@tangle-network/agent-eval'
import type {
  ExternalOptimizerModelCall,
  ExternalOptimizerModelCallRequest,
  ExternalOptimizerModelCallResult,
  ExternalOptimizerModelExecutionObservation,
} from '@tangle-network/agent-eval/campaign'
import {
  type AgentExactRunControlRef,
  type AgentProfile,
  harnessSystemPromptIntents,
} from '@tangle-network/agent-interface'
import { profileOptimizerModelCall } from '@tangle-network/agent-runtime/kernel'
import type { RouterTransportConfig } from '@tangle-network/agent-runtime/kernel'
import { canonicalDigest } from '../../domain/canonical.js'
import type { ConnectionRecord } from '../../domain/entities.js'
import type { RetainedRunAdmissionRecord } from '../../domain/run-contracts.js'
import { safePublicIdentifier } from '../../domain/provider-values.js'
import { redactProviderError } from '../../domain/redaction.js'
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

interface RetainedCallSummary {
  readonly status: 'completed' | 'failed' | 'aborted' | 'blocked'
  readonly content: string
  readonly durationMs: number
  readonly endedAt: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
  readonly observedCostUsd?: number
  readonly usageCaptured: boolean
  readonly reportedModel?: string
  readonly errorKind?: string
  readonly errorStatus?: number
}

type RuntimeModelOperation = 'startRetainedRun' | 'profileOptimizerModelCall'

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

function eventFacts(eventTypes: readonly string[]): Readonly<Record<string, number>> {
  const counts = new Map<string, number>()
  for (const type of eventTypes) counts.set(type, (counts.get(type) ?? 0) + 1)
  return Object.freeze(
    Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right))),
  )
}

function runtimeExecutionRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

function runtimeExecutionWasDispatched(value: unknown): boolean {
  return runtimeExecutionRecord(value)?.executed === true
}

function runtimeEventTypes(value: unknown): readonly string[] {
  const eventTypes = runtimeExecutionRecord(value)?.eventTypes
  return Array.isArray(eventTypes)
    ? eventTypes.filter((eventType): eventType is string => typeof eventType === 'string')
    : []
}

function runtimePromptCache(
  response: ChatResponse | undefined,
): Readonly<Record<string, number | string>> | undefined {
  const value = response?.raw.promptCache
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value).filter(
    ([, entry]) =>
      typeof entry === 'string' || (typeof entry === 'number' && Number.isFinite(entry)),
  )
  return entries.length === 0 ? undefined : Object.freeze(Object.fromEntries(entries))
}

function runtimeUsageFacts(
  response: ChatResponse | undefined,
  receipt: import('@tangle-network/agent-eval').CostReceiptInput,
): Readonly<Record<string, unknown>> {
  const usageUnknown = receipt.usageUnknown === true
  const promptCache = runtimePromptCache(response)
  const cachedTokens = receipt.cachedTokens ?? response?.usage.cachedPromptTokens
  const reasoningTokens = receipt.reasoningTokens ?? response?.usage.reasoningTokens
  return {
    captured: !usageUnknown,
    inputTokens: usageUnknown ? 0 : receipt.inputTokens,
    outputTokens: usageUnknown ? 0 : receipt.outputTokens,
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
    ...(receipt.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: receipt.cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(promptCache === undefined ? {} : { promptCache }),
    ...(receipt.model === undefined ? {} : { reportedModel: safeModelRoute(receipt.model) }),
  }
}

function summarizeRetainedResult(
  result: import('@tangle-network/agent-interface/environment-provider').AgentTurnResult,
  model: string,
  startedAt: number,
): RetainedCallSummary {
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
    status: result.success ? 'completed' : 'failed',
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
    RetainedCallSummary,
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
  summary: RetainedCallSummary,
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
        types: eventFacts([]),
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
  readonly summary?: RetainedCallSummary
  readonly runtimeResult?: ExternalOptimizerModelCallResult
  readonly dispatched: boolean
  readonly eventTypes?: readonly string[]
  readonly startedAt: number
  readonly endedAt?: number
  readonly durationMs?: number
  readonly failure?: string
  readonly operation: RuntimeModelOperation
  readonly controlRef?: AgentExactRunControlRef
}): Readonly<Record<string, unknown>> {
  const summary = input.summary
  const runtimeExecution = runtimeExecutionRecord(input.runtimeResult?.execution)
  const runtimeResponse =
    input.runtimeResult?.succeeded === true ? input.runtimeResult.response : undefined
  const runtimeWasExecuted = runtimeExecutionWasDispatched(input.runtimeResult?.execution)
  const eventTypes = input.eventTypes ?? runtimeEventTypes(input.runtimeResult?.execution)
  const endedAt = input.endedAt ?? summary?.endedAt ?? Date.now()
  const durationMs =
    input.durationMs ??
    runtimeResponse?.durationMs ??
    summary?.durationMs ??
    Math.max(0, endedAt - input.startedAt)
  const cost = costFacts(input.receipt, input.pricing, summary, input.dispatched)
  const terminal =
    summary === undefined
      ? runtimeWasExecuted
        ? {
            status:
              typeof runtimeExecution?.status === 'string'
                ? runtimeExecution.status
                : runtimeResponse === undefined
                  ? 'failed'
                  : 'completed',
            reason:
              input.failure ??
              (runtimeResponse === undefined
                ? 'Agent Runtime model execution failed'
                : 'Agent Runtime model execution completed'),
          }
        : undefined
      : {
          status: summary.status,
          reason: summaryFailure(summary),
          ...(summary.errorKind === undefined ? {} : { errorKind: summary.errorKind }),
          ...(summary.errorStatus === undefined ? {} : { errorStatus: summary.errorStatus }),
        }
  const usage =
    summary === undefined
      ? runtimeWasExecuted && input.receipt !== undefined
        ? runtimeUsageFacts(runtimeResponse, input.receipt)
        : undefined
      : {
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
          ...(summary.reportedModel === undefined
            ? {}
            : { reportedModel: safeModelRoute(summary.reportedModel) }),
        }
  const output = summary?.content ?? runtimeResponse?.content
  return Object.freeze({
    schema: 'braid.runtime-model-execution.v1',
    runtime: {
      package: '@tangle-network/agent-runtime',
      version: AGENT_RUNTIME_VERSION,
      operation: input.operation,
      ...(input.runtimeResult === undefined ? {} : { execution: input.runtimeResult.execution }),
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
    durationMs,
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
    ...(terminal === undefined ? {} : { terminal }),
    ...(usage === undefined ? {} : { usage }),
    ...(summary !== undefined || runtimeWasExecuted ? { events: eventFacts(eventTypes) } : {}),
    ...(output === undefined ? {} : { outputDigest: String(canonicalDigest(output)) }),
    ...(input.failure === undefined ? {} : { failure: input.failure }),
  })
}

function costFacts(
  receipt: import('@tangle-network/agent-eval').CostReceiptInput | undefined,
  pricing: CustomTokenPricing | undefined,
  summary: RetainedCallSummary | undefined,
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
  if (receipt.customTokenPricing !== undefined && receipt.usageUnknown !== true) {
    return { status: 'estimated', usd: costForTokenPricing(receipt.customTokenPricing, receipt) }
  }
  return { status: 'unknown' }
}

function summaryFailure(summary: RetainedCallSummary): string {
  if (summary.status === 'completed') return 'Agent Runtime model execution completed'
  if (summary.errorStatus !== undefined) {
    return `Agent Runtime model execution failed with HTTP ${summary.errorStatus}`
  }
  if (summary.status === 'aborted') return 'Agent Runtime model execution was cancelled'
  return `Agent Runtime model execution failed (${safePublicIdentifier(summary.errorKind) ?? 'provider-error'})`
}

function publicError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value)
  const status = httpStatusFromReason(message)
  return status === undefined ? redactProviderError(message) : `HTTP ${status}`
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
  // Runtime's profile adapter owns response-format materialization for direct calls.
  const format = bridge ? responseFormat(request) : undefined
  const sourceReasoning = source.model?.reasoningEffort
  const reasoningEffort =
    request.thinking === 'disabled'
      ? 'none'
      : request.thinking === 'enabled' &&
          (sourceReasoning === undefined || sourceReasoning === 'none')
        ? 'minimal'
        : sourceReasoning
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
      metadata: {
        ...(bridge ? {} : { retry }),
        ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
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
    let dispatched = false
    let summary: RetainedCallSummary | undefined
    let runtimeResult: ExternalOptimizerModelCallResult | undefined
    let executionProfileDigest = sourceProfileDigest
    const operation: RuntimeModelOperation =
      options.connection.kind === 'cli-bridge' ? 'startRetainedRun' : 'profileOptimizerModelCall'
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
        runtimeResult = await profileOptimizerModelCall({
          profile,
          context: 'Braid trace analysis',
          executor: {
            backend: 'router',
            routerBaseUrl: options.baseUrl,
            routerKey: options.credential ?? LOCAL_ROUTER_BEARER,
            ...(options.complete === undefined ? {} : { complete: options.complete }),
          },
          ...(pricing === undefined ? {} : { pricing }),
        })(request)
        dispatched = runtimeExecutionWasDispatched(runtimeResult.execution)
        const receipt = runtimeResult.receipt
        const error = runtimeResult.succeeded ? undefined : publicError(runtimeResult.error)
        const evidence = executionEvidence({
          request,
          callRef,
          profileDigest: executionProfileDigest,
          connection: options.connection,
          retry,
          ...(profile.model?.provider === undefined ? {} : { provider: profile.model.provider }),
          ...(pricing === undefined ? {} : { pricing }),
          receipt,
          runtimeResult,
          dispatched,
          eventTypes: runtimeEventTypes(runtimeResult.execution),
          startedAt,
          endedAt: Date.now(),
          ...(runtimeResult.succeeded ? { durationMs: runtimeResult.response.durationMs } : {}),
          operation,
          ...(error === undefined ? {} : { failure: error }),
        })
        if (error !== undefined) {
          return {
            succeeded: false,
            error,
            receipt,
            execution: evidence,
          }
        }
        return { ...runtimeResult, execution: evidence }
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
        eventTypes: [],
        startedAt,
        endedAt: summary.endedAt,
        durationMs: summary.durationMs,
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
      const receipt =
        runtimeResult?.receipt ??
        receiptFor(
          options.model,
          pricing,
          summary ?? { inputTokens: 0, outputTokens: 0, usageCaptured: false },
          !dispatched,
        )
      const runtimeDispatched =
        runtimeResult === undefined
          ? dispatched
          : runtimeExecutionWasDispatched(runtimeResult.execution)
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
          ...(runtimeResult === undefined ? {} : { runtimeResult }),
          dispatched: runtimeDispatched,
          ...(runtimeResult === undefined
            ? { eventTypes: [] }
            : { eventTypes: runtimeEventTypes(runtimeResult.execution) }),
          startedAt,
          endedAt: Date.now(),
          ...(runtimeResult?.succeeded ? { durationMs: runtimeResult.response.durationMs } : {}),
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
