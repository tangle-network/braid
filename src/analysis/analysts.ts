import {
  type AnalystRegistry,
  buildDefaultAnalystRegistry,
  type TraceAnalysisEngine,
  type TraceAnalystDefinition,
} from '@tangle-network/agent-eval'

import { type AnalysisKind, ANALYSIS_KINDS } from './commands.js'
import { analystIdForKind, analysisKindForAnalystId, W11_ANALYST_IDS } from './analyst-ids.js'
import { createDeterministicAnalystRegistry } from './deterministic-analysts.js'

export type W11AnalysisKind = AnalysisKind
export { analystIdForKind, analysisKindForAnalystId, W11_ANALYST_IDS }

const liveDefinitions: readonly TraceAnalystDefinition[] = ANALYSIS_KINDS.map((kind) => ({
  id: analystIdForKind(kind),
  description: `Answer the ${kind} analysis request from the frozen trace source.`,
  area: kind === 'ask' ? 'answer' : kind,
  version: '1.0.0',
  question: (context) =>
    context.tags?.question ?? `Analyze the frozen source for ${kind} findings.`,
  instructions: [
    `You are the live Braid ${kind} analyst.`,
    'Answer the exact user question supplied by the caller when one is present.',
    'Use only observations returned by trace tools.',
    'Every finding must cite the exact trace span that supports it.',
    'State uncertainty instead of inventing a root cause or missing evidence.',
    'Return a concise answer and actionable next step.',
  ].join('\n'),
  toolGroup: 'all',
  limits: { maxIterations: 12, maxLlmCalls: 8, maxToolCalls: 48 },
}))

export interface W11AnalystRegistryOptions {
  readonly engine: TraceAnalysisEngine
}

/** Build the configured live registry backed by agent-eval's trace engine. */
export function createW11AnalystRegistry(options: W11AnalystRegistryOptions): AnalystRegistry {
  return buildDefaultAnalystRegistry({
    engine: options.engine,
    definitions: liveDefinitions,
    includeBehavioral: false,
  })
}

/** Deterministic fixtures are test-only; production callers must provide an engine. */
export function createW11FixtureAnalystRegistry(): AnalystRegistry {
  return createDeterministicAnalystRegistry()
}
