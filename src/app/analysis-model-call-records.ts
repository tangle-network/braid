import type { ExternalOptimizerModelExecutionObservation } from '@tangle-network/agent-eval/campaign'
import type {
  AnalysisModelCallCost,
  AnalysisModelCallRecord,
} from '../domain/analysis-model-call.js'
import { safePublicIdentifier } from '../domain/provider-values.js'
import { isCanonicalIsoDateTime } from '../domain/text.js'

type JsonRecord = Readonly<Record<string, unknown>>

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function firstFinite(source: JsonRecord | undefined, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = finite(source?.[key])
    if (value !== undefined) return value
  }
  return undefined
}

function costFromExecution(execution: JsonRecord | undefined): AnalysisModelCallCost {
  const billing = record(execution?.billing)
  const status = billing?.status
  const usd = finite(billing?.usd)
  if (status === 'observed' && usd !== undefined) return { status, usd }
  if (status === 'estimated' && usd !== undefined) return { status, usd }
  return { status: 'unknown' }
}

function sourceSequence(sequence: unknown, fallback: number): number {
  return typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence > 0
    ? sequence
    : fallback
}

function safeEndpointPath(value: unknown): AnalysisModelCallRecord['path'] {
  if (value === '/v1/chat/completions' || value === '/v1/responses') return value
  return 'unknown-path'
}

function modelCallRecord(
  observation: ExternalOptimizerModelExecutionObservation,
  sequence: number,
): AnalysisModelCallRecord {
  const execution = record(observation.execution)
  const runtime = record(execution?.runtime)
  const usage = record(execution?.usage)
  const connection = record(execution?.connection)
  const routeValue = record(execution?.route)
  const inputTokens = finite(usage?.inputTokens)
  const outputTokens = finite(usage?.outputTokens)
  const tokensKnown =
    usage?.captured === true && inputTokens !== undefined && outputTokens !== undefined
  const startedAt = isCanonicalIsoDateTime(execution?.startedAt) ? execution.startedAt : undefined
  const endedAt = isCanonicalIsoDateTime(execution?.endedAt) ? execution.endedAt : undefined
  const responseStatus = httpStatus(
    observation.succeeded
      ? observation.responseStatus
      : execution?.terminal && record(execution.terminal)?.errorStatus,
  )
  const failureCode = observation.succeeded
    ? undefined
    : safePublicIdentifier(record(execution?.terminal)?.errorKind)
  const provider =
    safePublicIdentifier(execution?.provider) ?? safePublicIdentifier(runtime?.provider)
  const route =
    safePublicIdentifier(execution?.route) ??
    safePublicIdentifier(routeValue?.name) ??
    safePublicIdentifier(connection?.kind) ??
    safePublicIdentifier(execution?.endpointFormat)
  const cachedTokens = firstFinite(usage, ['cachedTokens', 'cacheReadTokens'])
  const cacheWriteTokens = firstFinite(usage, ['cacheWriteTokens'])
  const latencyMs = finite(execution?.durationMs)

  return {
    sequence: sourceSequence(observation.sequence, sequence),
    callId: safePublicIdentifier(observation.callId) ?? 'unknown-call',
    callRef: safePublicIdentifier(observation.callRef) ?? 'unknown-call-ref',
    path: safeEndpointPath(observation.path),
    model: safePublicIdentifier(observation.model) ?? 'unknown-model',
    ...(provider === undefined ? {} : { provider }),
    ...(route === undefined ? {} : { route }),
    ...(tokensKnown && inputTokens !== undefined ? { inputTokens } : {}),
    ...(tokensKnown && outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    tokensKnown,
    cost: costFromExecution(execution),
    ...(latencyMs === undefined ? {} : { latencyMs }),
    outcome: observation.succeeded ? 'succeeded' : 'failed',
    ...(responseStatus === undefined ? {} : { responseStatus }),
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
  }
}

function httpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined
}

/** Map Agent Eval observations without retaining their opaque execution payload. */
export function analysisModelCallRecords(
  observations: readonly ExternalOptimizerModelExecutionObservation[],
): readonly AnalysisModelCallRecord[] {
  return Object.freeze(
    observations.map((observation, index) => modelCallRecord(observation, index + 1)),
  )
}
