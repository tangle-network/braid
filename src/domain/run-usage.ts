import type { RunRecord, TurnUsage } from './entities.js'

function usageBase(
  run: RunRecord,
): Omit<
  RunRecord,
  | 'inputTokens'
  | 'outputTokens'
  | 'tokensKnown'
  | 'reasoningTokens'
  | 'costUsd'
  | 'usdKnown'
  | 'estimatedCostUsd'
  | 'promptCache'
  | 'model'
> {
  const {
    inputTokens: _inputTokens,
    outputTokens: _outputTokens,
    tokensKnown: _tokensKnown,
    reasoningTokens: _reasoningTokens,
    costUsd: _costUsd,
    usdKnown: _usdKnown,
    estimatedCostUsd: _estimatedCostUsd,
    promptCache: _promptCache,
    model: _model,
    ...base
  } = run
  return base
}

function mergeCache(
  left: Readonly<Record<string, number>> | undefined,
  right: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, number>> | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  const output: Record<string, number> = { ...left }
  for (const [key, value] of Object.entries(right)) output[key] = (output[key] ?? 0) + value
  return Object.freeze(output)
}

function maxOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return Math.max(left, right)
}

function maxCache(
  left: Readonly<Record<string, number>> | undefined,
  right: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, number>> | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  const output: Record<string, number> = { ...left }
  for (const [key, value] of Object.entries(right)) output[key] = Math.max(output[key] ?? 0, value)
  return Object.freeze(output)
}

/** Add one Runtime llm_call event to the live run total. */
export function addRunUsage(run: RunRecord, usage: TurnUsage): RunRecord {
  const { tokensKnown: _tokensKnown, usdKnown: _usdKnown, ...base } = run
  const priorCalls = run.llmCalls ?? 0
  const firstCall = priorCalls === 0
  const tokensKnown = usage.tokensKnown !== false && (firstCall || run.tokensKnown !== false)
  const usdKnown = usage.usdKnown !== false && (firstCall || run.usdKnown !== false)
  const costUsd = (run.costUsd ?? 0) + (usage.costUsd ?? 0)
  const estimatedCostUsd = (run.estimatedCostUsd ?? 0) + (usage.estimatedCostUsd ?? 0)
  const promptCache = mergeCache(run.promptCache, usage.promptCache)
  return {
    ...base,
    inputTokens: run.inputTokens + usage.input,
    outputTokens: run.outputTokens + usage.output,
    ...(tokensKnown ? {} : { tokensKnown: false as const }),
    ...(usage.reasoning === undefined
      ? {}
      : { reasoningTokens: (run.reasoningTokens ?? 0) + usage.reasoning }),
    ...(run.costUsd === undefined && usage.costUsd === undefined ? {} : { costUsd }),
    ...(usdKnown ? {} : { usdKnown: false as const }),
    ...(run.estimatedCostUsd === undefined && usage.estimatedCostUsd === undefined
      ? {}
      : { estimatedCostUsd }),
    ...(promptCache === undefined ? {} : { promptCache }),
    llmCalls: priorCalls + 1,
    ...(usage.latencyMs === undefined
      ? {}
      : { llmLatencyMs: (run.llmLatencyMs ?? 0) + usage.latencyMs }),
    ...(usage.model === undefined ? {} : { model: usage.model }),
  }
}

/** Replace live estimates with Runtime's terminal cumulative usage. */
export function finalizeRunUsage(run: RunRecord, usage: TurnUsage): RunRecord {
  const base = usageBase(run)
  const tokensKnown = usage.tokensKnown !== false
  const usdKnown = usage.usdKnown !== false
  const inputTokens = tokensKnown ? usage.input : Math.max(run.inputTokens, usage.input)
  const outputTokens = tokensKnown ? usage.output : Math.max(run.outputTokens, usage.output)
  const reasoningTokens = tokensKnown
    ? usage.reasoning
    : maxOptional(run.reasoningTokens, usage.reasoning)
  const observedCost = usdKnown ? usage.costUsd : maxOptional(run.costUsd, usage.costUsd)
  const estimatedCostUsd = maxOptional(run.estimatedCostUsd, usage.estimatedCostUsd)
  const promptCache = tokensKnown
    ? (usage.promptCache ?? run.promptCache)
    : maxCache(run.promptCache, usage.promptCache)
  return {
    ...base,
    inputTokens,
    outputTokens,
    ...(tokensKnown ? {} : { tokensKnown: false as const }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(observedCost === undefined ? {} : { costUsd: observedCost }),
    ...(usdKnown ? {} : { usdKnown: false as const }),
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
    ...(promptCache === undefined ? {} : { promptCache }),
    ...(usage.model === undefined
      ? run.model === undefined
        ? {}
        : { model: run.model }
      : { model: usage.model }),
  }
}

export function usageSnapshotForRun(run: RunRecord): TurnUsage {
  return {
    input: run.inputTokens,
    output: run.outputTokens,
    ...(run.tokensKnown === false ? { tokensKnown: false } : {}),
    ...(run.reasoningTokens === undefined ? {} : { reasoning: run.reasoningTokens }),
    ...(run.costUsd === undefined ? {} : { costUsd: run.costUsd }),
    ...(run.usdKnown === false ? { usdKnown: false } : {}),
    ...(run.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: run.estimatedCostUsd }),
    ...(run.promptCache === undefined ? {} : { promptCache: run.promptCache }),
    ...(run.llmLatencyMs === undefined ? {} : { latencyMs: run.llmLatencyMs }),
    ...(run.model === undefined ? {} : { model: run.model }),
  }
}

export const UNKNOWN_TURN_USAGE: TurnUsage = Object.freeze({
  input: 0,
  output: 0,
  tokensKnown: false,
  usdKnown: false,
})
