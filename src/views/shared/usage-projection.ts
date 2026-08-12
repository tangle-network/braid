import type { BraidState } from '../../domain/state.js'
import {
  freezeView,
  type SessionUsageView,
  type UsageMeasurementStatus,
  type UsageTotalsView,
  type UsageView,
} from './models.js'

const sessionUsageCache = new WeakMap<BraidState, SessionUsageView>()

/*
 * Application state is immutable and receives a new identity for each revision.
 * Retain its complete usage projection so idle renders do not rescan worker history.
 */
export function sessionUsageFor(state: BraidState): SessionUsageView {
  const cached = sessionUsageCache.get(state)
  if (cached !== undefined) return cached
  const runs = state.runs.filter((run) => run.conversationId === state.conversationId)
  const analyses = state.analyses.filter(
    (analysis) => analysis.source.conversationId === state.conversationId,
  )
  const runIds = new Set(runs.map((run) => String(run.id)))
  const supervisors = state.supervisors.filter(
    (supervisor) => supervisor.rootRunId !== undefined && runIds.has(String(supervisor.rootRunId)),
  )
  const supervisorIds = new Set(supervisors.map((supervisor) => String(supervisor.id)))
  const workers = state.workers.filter((worker) => supervisorIds.has(String(worker.supervisorId)))
  const usage = freezeView({
    turns: totalsForRuns(runs),
    analyses: totalsForAnalyses(analyses),
    delegated: totalsForWorkers(workers),
    attribution: supervisors.length === 0 && analyses.length === 0 ? 'complete' : 'separate-totals',
  } satisfies SessionUsageView)
  sessionUsageCache.set(state, usage)
  return usage
}

export function usageForRun(run: BraidState['runs'][number], elapsedMs?: number): UsageView {
  return {
    input: run.inputTokens,
    output: run.outputTokens,
    ...(run.reasoningTokens === undefined ? {} : { reasoning: run.reasoningTokens }),
    tokenStatus: tokenStatus(run.tokensKnown, run.inputTokens, run.outputTokens, run.llmCalls),
    ...(run.costUsd === undefined ? {} : { costUsd: run.costUsd }),
    ...(run.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: run.estimatedCostUsd }),
    costStatus: costStatus(run.usdKnown, run.costUsd, run.estimatedCostUsd),
    ...(run.promptCache === undefined ? {} : { promptCache: run.promptCache }),
    ...(run.llmCalls === undefined ? {} : { llmCalls: run.llmCalls }),
    ...(run.llmLatencyMs === undefined ? {} : { llmLatencyMs: run.llmLatencyMs }),
    ...(run.model === undefined ? {} : { model: run.model }),
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
  }
}

function totalsForRuns(runs: readonly BraidState['runs'][number][]): UsageTotalsView {
  return totalsForUsage(runs.map((run) => usageForRun(run)))
}

function totalsForAnalyses(analyses: readonly BraidState['analyses'][number][]): UsageTotalsView {
  return totalsForUsage(
    analyses.map((analysis) => {
      const usage = analysis.usage
      const modelCalls = analysis.modelCalls
      const tokens = analysisTokenUsage(usage, modelCalls)
      const cost = analysisCostUsage(usage, analysis.costUsd, modelCalls)
      const llmLatencyMs = analysisLatency(modelCalls, usage?.latencyMs)
      return {
        input: tokens.input,
        output: tokens.output,
        ...(usage?.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
        tokenStatus: tokens.status,
        ...(cost.costUsd === undefined ? {} : { costUsd: cost.costUsd }),
        ...(cost.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: cost.estimatedCostUsd }),
        costStatus: cost.status,
        ...(usage?.promptCache === undefined ? {} : { promptCache: usage.promptCache }),
        ...(modelCalls === undefined ? {} : { llmCalls: modelCalls.length }),
        ...(llmLatencyMs === undefined ? {} : { llmLatencyMs }),
        ...(usage?.model === undefined ? {} : { model: usage.model }),
        ...(analysis.wallTimeMs === undefined ? {} : { elapsedMs: analysis.wallTimeMs }),
      }
    }),
  )
}

type AnalysisTokenUsage = {
  readonly input: number
  readonly output: number
  readonly status: NonNullable<UsageView['tokenStatus']>
  readonly hasKnownTokens: boolean
}

type AnalysisCostUsage = {
  readonly costUsd?: number
  readonly estimatedCostUsd?: number
  readonly status: NonNullable<UsageView['costStatus']>
  readonly hasKnownCost: boolean
}

function analysisTokenUsage(
  usage: BraidState['analyses'][number]['usage'],
  modelCalls: BraidState['analyses'][number]['modelCalls'],
): AnalysisTokenUsage {
  const modelCallUsage = modelCallTokenUsage(modelCalls)
  if (usage === undefined) return modelCallUsage
  if (usage.tokensKnown !== false) {
    return {
      input: usage.input,
      output: usage.output,
      status: 'complete',
      hasKnownTokens: true,
    }
  }
  const usageHasKnownTokens = usage.input > 0 || usage.output > 0
  const hasKnownTokens = usageHasKnownTokens || modelCallUsage.hasKnownTokens
  return {
    input: maxOptional([usage.input, modelCallUsage.input]) ?? 0,
    output: maxOptional([usage.output, modelCallUsage.output]) ?? 0,
    status: hasKnownTokens ? 'observed-floor' : 'unknown',
    hasKnownTokens,
  }
}

function modelCallTokenUsage(
  modelCalls: BraidState['analyses'][number]['modelCalls'],
): AnalysisTokenUsage {
  if (modelCalls === undefined) {
    return { input: 0, output: 0, status: 'unknown', hasKnownTokens: false }
  }
  const inputCalls = modelCalls.filter((call) => call.inputTokens !== undefined)
  const outputCalls = modelCalls.filter((call) => call.outputTokens !== undefined)
  const hasKnownTokens = inputCalls.length > 0 || outputCalls.length > 0
  const allTokensKnown =
    modelCalls.length > 0 &&
    modelCalls.every(
      (call) =>
        call.tokensKnown && call.inputTokens !== undefined && call.outputTokens !== undefined,
    )
  return {
    input: sum(inputCalls.map((call) => call.inputTokens)),
    output: sum(outputCalls.map((call) => call.outputTokens)),
    status: !hasKnownTokens ? 'unknown' : allTokensKnown ? 'complete' : 'observed-floor',
    hasKnownTokens,
  }
}

function analysisCostUsage(
  usage: BraidState['analyses'][number]['usage'],
  legacyCostUsd: number | undefined,
  modelCalls: BraidState['analyses'][number]['modelCalls'],
): AnalysisCostUsage {
  const authoritativeCost = usageCostProjection(usage, legacyCostUsd)
  if (usage === undefined) {
    if (legacyCostUsd !== undefined) return authoritativeCost
    return modelCallCostUsage(modelCalls)
  }
  if (usage.usdKnown !== false && (usage.costUsd !== undefined || legacyCostUsd !== undefined)) {
    return authoritativeCost
  }
  const modelCallCost = modelCallCostUsage(modelCalls)
  if (usage.usdKnown === false) {
    const observedCostUsd = maxOptional([authoritativeCost.costUsd, modelCallCost.costUsd])
    const estimatedCostUsd = authoritativeCost.estimatedCostUsd
    return {
      ...(observedCostUsd === undefined ? {} : { costUsd: observedCostUsd }),
      ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
      status: costStatus(usage.usdKnown, observedCostUsd, estimatedCostUsd),
      hasKnownCost: observedCostUsd !== undefined || estimatedCostUsd !== undefined,
    }
  }
  if (modelCalls !== undefined && modelCallCost.hasKnownCost) return modelCallCost
  return authoritativeCost
}

function usageCostProjection(
  usage: BraidState['analyses'][number]['usage'],
  legacyCostUsd: number | undefined,
): AnalysisCostUsage {
  if (usage === undefined) {
    return legacyCostUsd === undefined
      ? { status: 'unknown', hasKnownCost: false }
      : { costUsd: legacyCostUsd, status: 'reported', hasKnownCost: true }
  }
  const costUsd = usage.costUsd ?? legacyCostUsd
  return {
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(usage.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: usage.estimatedCostUsd }),
    status: costStatus(usage.usdKnown, costUsd, usage.estimatedCostUsd),
    hasKnownCost: costUsd !== undefined || usage.estimatedCostUsd !== undefined,
  }
}

function modelCallCostUsage(
  modelCalls: BraidState['analyses'][number]['modelCalls'],
): AnalysisCostUsage {
  if (modelCalls === undefined) return { status: 'unknown', hasKnownCost: false }
  const observedCalls = modelCalls.filter(
    (call) => call.cost?.status === 'observed' && call.cost.usd !== undefined,
  )
  const estimatedCalls = modelCalls.filter(
    (call) => call.cost?.status === 'estimated' && call.cost.usd !== undefined,
  )
  const observedCostUsd = sumOptional(observedCalls.map((call) => call.cost.usd))
  const knownCostCalls = observedCalls.length + estimatedCalls.length
  if (knownCostCalls === 0) return { status: 'unknown', hasKnownCost: false }
  const unknownCostCalls = modelCalls.length - knownCostCalls
  if (unknownCostCalls > 0) {
    return {
      ...(observedCostUsd === undefined ? {} : { costUsd: observedCostUsd }),
      status: observedCostUsd === undefined ? 'unknown' : 'observed-floor',
      hasKnownCost: true,
    }
  }
  const estimatedTotalUsd = sumOptional(
    [...observedCalls, ...estimatedCalls].map((call) => call.cost.usd),
  )
  return {
    ...(observedCostUsd === undefined ? {} : { costUsd: observedCostUsd }),
    ...(estimatedCalls.length === 0 || estimatedTotalUsd === undefined
      ? {}
      : { estimatedCostUsd: estimatedTotalUsd }),
    status: estimatedCalls.length > 0 ? 'estimated' : 'reported',
    hasKnownCost: true,
  }
}

function analysisLatency(
  modelCalls: BraidState['analyses'][number]['modelCalls'],
  legacyLatencyMs: number | undefined,
): number | undefined {
  if (modelCalls === undefined) return legacyLatencyMs
  if (modelCalls.length === 0 || modelCalls.some((call) => call.latencyMs === undefined)) {
    return undefined
  }
  return sum(modelCalls.map((call) => call.latencyMs))
}

function totalsForUsage(usage: readonly UsageView[]): UsageTotalsView {
  const tokenStatuses = usage.map((entry) => entry.tokenStatus ?? 'unknown')
  const costStatuses = usage.map((entry) => entry.costStatus ?? 'unknown')
  const reasoning = sumOptional(usage.map((entry) => entry.reasoning))
  const costUsd = sumOptional(usage.map((entry) => entry.costUsd))
  const estimatedCostUsd = sumOptional(usage.map((entry) => entry.estimatedCostUsd))
  const promptCache = mergeCaches(usage.map((entry) => entry.promptCache))
  const calls = aggregateMeasurement(usage.map((entry) => entry.llmCalls))
  const latency = aggregateMeasurement(usage.map((entry) => entry.llmLatencyMs))
  return {
    sourceCount: usage.length,
    input: sum(usage.map((entry) => entry.input)),
    output: sum(usage.map((entry) => entry.output)),
    ...(reasoning === undefined ? {} : { reasoning }),
    tokenStatus: aggregateTokenStatus(tokenStatuses),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
    costStatus: aggregateCostStatus(costStatuses),
    ...(promptCache === undefined ? {} : { promptCache }),
    ...(calls.value === undefined ? {} : { llmCalls: calls.value }),
    ...(latency.value === undefined ? {} : { llmLatencyMs: latency.value }),
    unknownTokenSources: tokenStatuses.filter((status) => status !== 'complete').length,
    unknownCostSources: costStatuses.filter((status) => status !== 'reported').length,
    callStatus: calls.status,
    latencyStatus: latency.status,
    unknownCallSources: calls.unknownSources,
    unknownLatencySources: latency.unknownSources,
  }
}

function totalsForWorkers(workers: readonly BraidState['workers'][number][]): UsageTotalsView {
  const observedTokenSources = workers.filter(
    (worker) => worker.inputTokens !== undefined || worker.outputTokens !== undefined,
  )
  const observedCostSources = workers.filter((worker) => worker.spendUsd !== undefined)
  const missingTokens = workers.length - observedTokenSources.length
  const missingCosts = workers.length - observedCostSources.length
  const incompleteTokens = workers.filter(
    (worker) =>
      worker.inputTokens === undefined ||
      worker.outputTokens === undefined ||
      worker.usageCompleteness !== 'complete',
  ).length
  const incompleteCosts = workers.filter(
    (worker) => worker.spendUsd === undefined || worker.usageCompleteness !== 'complete',
  ).length
  const calls = aggregateMeasurement(workers.map(() => undefined))
  const latency = aggregateMeasurement(workers.map((worker) => worker.latencyMs))
  return {
    sourceCount: workers.length,
    input: sum(observedTokenSources.map((worker) => worker.inputTokens)),
    output: sum(observedTokenSources.map((worker) => worker.outputTokens)),
    tokenStatus:
      workers.length === 0 || observedTokenSources.length === 0
        ? 'unknown'
        : incompleteTokens > 0
          ? 'observed-floor'
          : 'complete',
    ...(observedCostSources.length === 0
      ? {}
      : { costUsd: sum(observedCostSources.map((worker) => worker.spendUsd)) }),
    costStatus:
      workers.length === 0 || observedCostSources.length === 0
        ? 'unknown'
        : incompleteCosts > 0
          ? 'observed-floor'
          : 'reported',
    ...(latency.value === undefined ? {} : { llmLatencyMs: latency.value }),
    unknownTokenSources: Math.max(missingTokens, incompleteTokens),
    unknownCostSources: Math.max(missingCosts, incompleteCosts),
    callStatus: calls.status,
    latencyStatus: latency.status,
    unknownCallSources: calls.unknownSources,
    unknownLatencySources: latency.unknownSources,
  }
}

function tokenStatus(
  known: false | undefined,
  input: number,
  output: number,
  calls: number | undefined,
): NonNullable<UsageView['tokenStatus']> {
  if (known !== false) return 'complete'
  return input > 0 || output > 0 || (calls ?? 0) > 0 ? 'observed-floor' : 'unknown'
}

function costStatus(
  known: false | undefined,
  costUsd: number | undefined,
  estimatedCostUsd: number | undefined,
): NonNullable<UsageView['costStatus']> {
  if (known !== false && costUsd !== undefined) return 'reported'
  if (costUsd !== undefined) return 'observed-floor'
  if (estimatedCostUsd !== undefined) return 'estimated'
  return 'unknown'
}

function aggregateTokenStatus(
  statuses: readonly NonNullable<UsageView['tokenStatus']>[],
): NonNullable<UsageView['tokenStatus']> {
  if (statuses.length === 0 || statuses.includes('unknown')) return 'unknown'
  return statuses.includes('observed-floor') ? 'observed-floor' : 'complete'
}

function aggregateCostStatus(
  statuses: readonly NonNullable<UsageView['costStatus']>[],
): NonNullable<UsageView['costStatus']> {
  if (statuses.length === 0 || statuses.includes('unknown')) return 'unknown'
  if (statuses.includes('observed-floor')) return 'observed-floor'
  return statuses.every((status) => status === 'reported') ? 'reported' : 'estimated'
}

function sum(values: readonly (number | undefined)[]): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0)
}

function sumOptional(values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => value !== undefined)
  return present.length === 0 ? undefined : sum(present)
}

function maxOptional(values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => value !== undefined)
  return present.length === 0 ? undefined : Math.max(...present)
}

function aggregateMeasurement(values: readonly (number | undefined)[]): {
  readonly value?: number
  readonly status: UsageMeasurementStatus
  readonly unknownSources: number
} {
  const unknownSources = values.filter((value) => value === undefined).length
  const value = sumOptional(values)
  return {
    ...(value === undefined ? {} : { value }),
    status: value === undefined ? 'unknown' : unknownSources === 0 ? 'complete' : 'partial',
    unknownSources,
  }
}

function mergeCaches(
  caches: readonly (Readonly<Record<string, number>> | undefined)[],
): Readonly<Record<string, number>> | undefined {
  const output: Record<string, number> = {}
  for (const cache of caches) {
    for (const [key, value] of Object.entries(cache ?? {})) output[key] = (output[key] ?? 0) + value
  }
  return Object.keys(output).length === 0 ? undefined : Object.freeze(output)
}
