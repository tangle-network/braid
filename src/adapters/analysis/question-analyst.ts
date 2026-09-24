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

const TOOL_SPAN_PATTERN = '"openinference\\.span\\.kind":"TOOL"'
const TOOL_RESULT_PART_PATTERN = '"kind":"tool-result"'
const TOOL_CALL_PART_PATTERN = '"kind":"tool-call"'

function spanHints(
  hits: readonly { readonly span_id: string; readonly span_name: string }[],
  limit: number,
): string[] {
  return [...new Map(hits.map((hit) => [hit.span_id, hit])).values()]
    .slice(-limit)
    .map((hit) => JSON.stringify({ span_id: hit.span_id, span_name: hit.span_name }))
}

async function prepareQuestionContext(
  store: TraceAnalysisStore,
  context?: AnalystContext,
): Promise<string> {
  const storeContext = context?.signal === undefined ? undefined : { signal: context.signal }
  const overview = await store.getOverview({}, storeContext)
  const traceId = overview.total_traces === 1 ? overview.sample_trace_ids[0] : undefined
  if (traceId === undefined) {
    return 'Read analyst_instructions first, then start with getDatasetOverview.'
  }
  const [tools, partResults, partCalls] = await Promise.all([
    store.searchTrace(
      { trace_id: traceId, regex_pattern: TOOL_SPAN_PATTERN, max_matches: 128 },
      storeContext,
    ),
    store.searchTrace(
      { trace_id: traceId, regex_pattern: TOOL_RESULT_PART_PATTERN, max_matches: 128 },
      storeContext,
    ),
    store.searchTrace(
      { trace_id: traceId, regex_pattern: TOOL_CALL_PART_PATTERN, max_matches: 128 },
      storeContext,
    ),
  ])
  const partResultHits = partResults.hits.filter(
    (hit) => hit.span_name === 'braid.run.part.updated',
  )
  const partCallHits = partCalls.hits.filter((hit) => hit.span_name === 'braid.run.part.updated')
  return [
    'The frozen source contains exactly one trace.',
    `Exact trace id: ${JSON.stringify(traceId)}.`,
    'Inspect these completed tool-result part spans first with viewSpans and their exact span_id values.',
    ...spanHints(partResultHits, 16),
    'If a write result only confirms success, inspect these exact normalized tool-call input spans for the edited source.',
    ...spanHints(partCallHits, 16),
    'Other normalized TOOL spans:',
    ...spanHints(tools.hits, 12),
    ...(tools.has_more || partResults.has_more || partCalls.has_more
      ? ['The span list is bounded and may omit later events.']
      : []),
    'If these spans do not answer Focus, use at most three focused searchTrace calls, one term at a time.',
    'Do not loop through search terms or retry a trace-tool HTTP 429; inspect returned hit.span_id values.',
    'An oversized viewTrace summary lists span names and counts, not span IDs.',
    'Treat this list as navigation only; cite evidence after reading the exact spans.',
    'The instruction variable may be shortened in a preview; read its full value before using trace tools.',
  ].join('\n')
}

export const BRAID_QUESTION_ANALYST_DEFINITION = Object.freeze({
  id: BRAID_QUESTION_ANALYST_ID,
  description: 'Answers one operator question against one frozen run with cited evidence.',
  area: 'question-answer',
  version: '1.7.3',
  question: 'Answer the operator question about this frozen run.',
  instructions: [
    'FIRST PYTHON STEP: print(analyst_instructions) so you can read every prepared span ID and the full output contract.',
    'OUTPUT CONTRACT:',
    'Omit subject from every finding.',
    'Return one to five findings.',
    'Every evidence object must include one short exact scalar string excerpt from the cited span.',
    'For edited source, cite one exact expression from the edit, not the whole multiline edit.',
    'Copy each excerpt verbatim; never add leading or trailing whitespace or a newline.',
    'Never use an attribute label or a constructed JSON fragment as an excerpt.',
    'Print the original span scalar before quoting it; JSON serialization can escape characters and change the excerpt.',
    'Before SUBMIT, check each proposed excerpt is a substring of its original span scalar in Python.',
    'For numeric facts, quote a related model, status, or output string from the same span.',
    'Before SUBMIT, ensure each distinct request in Focus has one finding or one explicit limit.',
    'The final call must be SUBMIT(answer=answer, findings_json=json.dumps(findings)).',
    'Never pass either output positionally or pass the findings list without JSON encoding.',
    'Answer only the operator question shown after "Focus:".',
    'Use the trace tools before you answer.',
    'Follow PREPARED CONTEXT and inspect its exact span IDs first.',
    "For braid.run.part.updated tool results, read span.attributes['braid.message_part'].result.content[i].text when present.",
    "For tool calls, read span.attributes['braid.message_part'].input when the result only confirms a write.",
    'A top-level span.status of UNSET is trace metadata, not evidence that the tool result is missing.',
    'Do not batch trace searches; stop searching once source and test evidence answer Focus.',
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
