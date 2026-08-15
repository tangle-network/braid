import {
  type AnalystContext,
  type AnalystFinding,
  type AnalystRegistry,
  createTraceAnalyst,
  type TraceAnalysisEngine,
  type TraceAnalysisStore,
  type TraceAnalystDefinition,
} from '@tangle-network/agent-eval'
import { canonicalJson } from '../../domain/canonical.js'

export const BRAID_QUESTION_ANALYST_ID = 'question'

async function prepareQuestionContext(store: TraceAnalysisStore): Promise<string> {
  const overview = await store.getOverview({})
  const traceId = overview.total_traces === 1 ? overview.sample_trace_ids[0] : undefined
  if (traceId === undefined) {
    return 'Start with getDatasetOverview. Do not print the question or analyst instructions.'
  }
  return [
    'The frozen source contains exactly one trace.',
    `Exact trace id: ${JSON.stringify(traceId)}.`,
    'Call viewTrace for this exact id in your first code step.',
    'Do not spend a model step printing the question or analyst instructions.',
  ].join('\n')
}

export const BRAID_QUESTION_ANALYST_DEFINITION = Object.freeze({
  id: BRAID_QUESTION_ANALYST_ID,
  description: 'Answers one operator question against one frozen run with cited evidence.',
  area: 'question-answer',
  version: '1.5.0',
  question: 'Answer the operator question about this frozen run.',
  instructions: [
    'OUTPUT CONTRACT:',
    'Omit subject from every finding.',
    'Return one to five findings.',
    'Every evidence object must include one exact scalar string excerpt from the cited span.',
    'Copy each excerpt verbatim; never use an attribute label or a constructed JSON fragment.',
    'For numeric facts, quote a related model, status, or output string from the same span.',
    'Before SUBMIT, ensure each distinct request in Focus has one finding or one explicit limit.',
    'The final call must be SUBMIT(answer=answer, findings_json=json.dumps(findings)).',
    'Never pass either output positionally or pass the findings list without JSON encoding.',
    'Answer only the operator question shown after "Focus:".',
    'Use the trace tools before you answer.',
    'Follow PREPARED CONTEXT and inspect its exact trace id first.',
    'Answer every distinct request in Focus with a finding or an explicit limitation finding.',
    'Write each finding claim as a direct answer, not as a defect label.',
    'Cite the exact trace span that supports each claim.',
    'Use info severity for factual answers.',
    'Use a higher severity only when the trace proves a risk.',
    'If the trace cannot answer part of the question, state that limit in a finding.',
    'Cite the nearest trace span that proves the evidence boundary.',
    'Do not invent missing actions, results, costs, or verification.',
    'Use recommended_action only to tell the reviewer what to inspect next.',
  ].join('\n'),
  prepareContext: prepareQuestionContext,
  toolGroup: 'singleTrace',
  limits: Object.freeze({
    maxIterations: 12,
    maxLlmCalls: 4,
    maxToolCalls: 24,
    maxOutputChars: 32_000,
  }),
  minimumEvidenceCitations: 1,
  requireStructuredFindings: true,
}) satisfies TraceAnalystDefinition

function canonicalFinding(finding: AnalystFinding): AnalystFinding {
  return JSON.parse(canonicalJson(finding)) as AnalystFinding
}

/** Add Braid's question analyst unless agent-eval already provides the same contract. */
export function registerBraidQuestionAnalyst(
  registry: AnalystRegistry,
  engine: TraceAnalysisEngine,
): void {
  if (registry.list().some((analyst) => analyst.id === BRAID_QUESTION_ANALYST_ID)) return
  const analyst = createTraceAnalyst(BRAID_QUESTION_ANALYST_DEFINITION, { engine })
  registry.register({
    ...analyst,
    analyze: async (store: TraceAnalysisStore, context: AnalystContext) =>
      (await analyst.analyze(store, context)).map(canonicalFinding),
  })
}
