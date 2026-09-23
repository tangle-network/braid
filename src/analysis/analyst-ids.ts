import { ANALYSIS_KINDS, type AnalysisKind } from './commands.js'

export const W11_ANALYST_IDS: Readonly<Record<AnalysisKind, string>> = Object.freeze({
  ask: 'braid.ask',
  failure: 'braid.failure',
  cost: 'braid.cost',
  tools: 'braid.tools',
  improvement: 'braid.improvement',
})

export function analystIdForKind(kind: AnalysisKind): string {
  if (!Object.hasOwn(W11_ANALYST_IDS, kind)) throw new TypeError(`Unknown analysis kind: ${kind}`)
  return W11_ANALYST_IDS[kind]
}

export function analysisKindForAnalystId(analystId: string): AnalysisKind | undefined {
  return ANALYSIS_KINDS.find((kind) => W11_ANALYST_IDS[kind] === analystId)
}
