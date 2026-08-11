import type { AnalysisModelCallRecord } from '../../domain/analysis-model-call.js'
import type { AnalysisRecord } from '../../domain/entities.js'
import type { AnalysisExecutionView, AnalysisModelCallView } from './models.js'
import { sanitizeTerminalText } from './sanitize.js'

export function analysisExecutionView(record: AnalysisRecord): AnalysisExecutionView {
  const modelCalls = record.modelCalls?.map(analysisModelCallView)
  const observedModels = new Set<string>()
  const aggregateModel = safeModel(record.usage?.model)
  if (aggregateModel !== undefined) observedModels.add(aggregateModel)
  for (const call of modelCalls ?? []) observedModels.add(call.model)
  const configuredModel = safeModel(record.provenance?.model)
  const runner = safeModel(record.provenance?.runner)
  return {
    ...(configuredModel === undefined ? {} : { configuredModel }),
    ...(runner === undefined ? {} : { runner }),
    observedModels: Object.freeze([...observedModels].sort()),
    ...(modelCalls === undefined ? {} : { modelCalls: Object.freeze(modelCalls) }),
    ...(record.wallTimeMs === undefined ? {} : { wallTimeMs: record.wallTimeMs }),
  }
}

export function analysisModelCallView(record: AnalysisModelCallRecord): AnalysisModelCallView {
  const provider = safeModel(record.provider)
  return {
    sequence: record.sequence,
    ...(provider === undefined ? {} : { provider }),
    model: safeModel(record.model) ?? 'unknown-model',
    ...(record.inputTokens === undefined ? {} : { inputTokens: record.inputTokens }),
    ...(record.outputTokens === undefined ? {} : { outputTokens: record.outputTokens }),
    tokensKnown: record.tokensKnown,
    ...(record.cost.usd === undefined ? {} : { costUsd: record.cost.usd }),
    costStatus: record.cost.status,
    ...(record.latencyMs === undefined ? {} : { latencyMs: record.latencyMs }),
    outcome: record.outcome,
  }
}

export function analysisModelCallLine(call: AnalysisModelCallView): string {
  const provider = call.provider ?? 'provider unknown'
  const latency = call.latencyMs === undefined ? 'latency unknown' : `latency ${call.latencyMs}ms`
  return `#${call.sequence} ${provider}/${call.model} · ${tokens(call)} · ${cost(call)} · ${latency}`
}

export function analysisModelCallSummary(calls: readonly AnalysisModelCallView[]): string {
  if (calls.length === 0) return '0 model calls reported.'
  const input = calls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0)
  const output = calls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0)
  const tokenGaps = calls.filter((call) => !call.tokensKnown).length
  const knownCostCalls = calls.filter(
    (call) => call.costStatus !== 'unknown' && call.costUsd !== undefined,
  )
  const cost = knownCostCalls.reduce((sum, call) => sum + (call.costUsd ?? 0), 0)
  const costGaps = calls.length - knownCostCalls.length
  const estimatedCosts = knownCostCalls.filter((call) => call.costStatus === 'estimated').length
  const latency = calls.reduce((sum, call) => sum + (call.latencyMs ?? 0), 0)
  const latencyGaps = calls.filter((call) => call.latencyMs === undefined).length
  const failures = calls.filter((call) => call.outcome === 'failed').length
  const gap = (count: number): string => (count === 0 ? '' : ` (+${count} unknown)`)
  return [
    `${calls.length} ${calls.length === 1 ? 'call' : 'calls'}`,
    `tokens ${tokenGaps === 0 ? '' : '≥'}${input} in / ${tokenGaps === 0 ? '' : '≥'}${output} out${gap(tokenGaps)}`,
    knownCostCalls.length === 0
      ? `cost unknown${gap(costGaps)}`
      : `cost ${costPrefix(estimatedCosts, costGaps)}$${cost.toFixed(4)}${gap(costGaps)}`,
    latency === 0 && latencyGaps > 0
      ? `latency unknown${gap(latencyGaps)}`
      : `model ${latencyGaps === 0 ? '' : '≥'}${latency}ms${gap(latencyGaps)}`,
    ...(failures === 0 ? [] : [`${failures} failed`]),
  ].join(' · ')
}

function costPrefix(estimatedCosts: number, unknownCosts: number): string {
  if (unknownCosts > 0 && estimatedCosts > 0) return 'known ~'
  if (unknownCosts > 0) return '≥'
  if (estimatedCosts > 0) return '~'
  return ''
}

function tokens(call: AnalysisModelCallView): string {
  const input = call.inputTokens === undefined ? '?' : String(call.inputTokens)
  const output = call.outputTokens === undefined ? '?' : String(call.outputTokens)
  if (call.tokensKnown) return `tokens ${input} in / ${output} out`
  if (call.inputTokens !== undefined || call.outputTokens !== undefined) {
    return `tokens ${input} in / ${output} out (observed floor)`
  }
  return 'tokens unknown'
}

function cost(call: AnalysisModelCallView): string {
  if (call.costStatus === 'observed' && call.costUsd !== undefined) {
    return `cost ${usd(call.costUsd)}`
  }
  if (call.costStatus === 'estimated' && call.costUsd !== undefined) {
    return `cost ~${usd(call.costUsd)}`
  }
  return 'cost unknown'
}

function usd(value: number): string {
  return `$${value.toFixed(6).replace(/0+$/u, '').replace(/\.$/u, '')}`
}

function safeModel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const safe = sanitizeTerminalText(value).trim()
  return safe.length === 0 || safe === 'unknown-model' ? undefined : safe
}
