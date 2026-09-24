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
import { safeAnalysisText } from './trace-event-projection.js'

export const BRAID_QUESTION_ANALYST_ID = 'question'
const initialNavigationByContext = new WeakMap<AnalystContext, string>()

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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface ScalarLeaf {
  readonly path: string
  readonly text: string
}

function leafPath(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`
}

function longestScalarLeaf(value: unknown, path: string, depth = 0): ScalarLeaf | undefined {
  if (typeof value === 'string') return value.length > 0 ? { path, text: value } : undefined
  if (depth >= 8) return undefined
  const children = Array.isArray(value)
    ? value.map((item, index) => longestScalarLeaf(item, `${path}[${index}]`, depth + 1))
    : record(value)
      ? Object.entries(value).map(([key, item]) =>
          longestScalarLeaf(item, leafPath(path, key), depth + 1),
        )
      : []
  return children.reduce<ScalarLeaf | undefined>(
    (best, child) => (child && (!best || child.text.length > best.text.length) ? child : best),
    undefined,
  )
}

function scalarPreview(text: string): string | undefined {
  const segment = [...text.matchAll(/[\x20-\x7e]{8,}/gu)]
    .map((match) => match[0])
    .sort((left, right) => right.length - left.length)[0]
  const sample = segment?.slice(0, 64)
  return sample && safeAnalysisText(sample) === sample ? sample : undefined
}

function navigationLine(entry: { readonly spanId: string; readonly leaf: ScalarLeaf }): string {
  const sample = scalarPreview(entry.leaf.text)
  const path =
    entry.leaf.path.length <= 160 && safeAnalysisText(entry.leaf.path) === entry.leaf.path
      ? entry.leaf.path
      : '[inspect span for leaf path]'
  return `span ${entry.spanId} ${path}${sample ? ` exact sample: ${sample}` : ''}`
}

type ViewedSpan = Awaited<ReturnType<TraceAnalysisStore['viewSpans']>>['spans'][number]

async function viewAllSpans(
  store: TraceAnalysisStore,
  traceId: string,
  spanIds: readonly string[],
  storeContext?: { readonly signal?: AbortSignal },
): Promise<ViewedSpan[]> {
  const spans = new Map<string, ViewedSpan>()
  const pending = [spanIds]
  while (pending.length > 0) {
    const requested = pending.pop()
    if (!requested || requested.length === 0) continue
    const viewed = await store.viewSpans({ trace_id: traceId, span_ids: requested }, storeContext)
    if (viewed.missing_span_ids.length > 0) {
      throw new Error(`Frozen trace lost requested spans: ${viewed.missing_span_ids.join(', ')}`)
    }
    for (const span of viewed.spans) spans.set(span.span_id, span)
    if (!viewed.has_more) continue
    const omitted = viewed.omitted_span_ids
    if (omitted.length === 0) throw new Error('Frozen trace reported omitted spans without IDs')
    if (omitted.length === requested.length) {
      if (omitted.length === 1) {
        throw new Error(`Frozen trace span exceeds the view budget: ${omitted[0]}`)
      }
      const midpoint = Math.ceil(omitted.length / 2)
      pending.push(omitted.slice(midpoint), omitted.slice(0, midpoint))
    } else {
      pending.push(omitted)
    }
  }
  return spanIds.map((spanId) => {
    const span = spans.get(spanId)
    if (!span) throw new Error(`Frozen trace did not return requested span: ${spanId}`)
    return span
  })
}

async function inputSpanHints(
  store: TraceAnalysisStore,
  traceId: string,
  hits: readonly { readonly span_id: string; readonly span_name: string }[],
  storeContext?: { readonly signal?: AbortSignal },
): Promise<{
  readonly hints: readonly string[]
  readonly navigation: readonly string[]
}> {
  const unique = [...new Map(hits.map((hit) => [hit.span_id, hit])).values()]
  const spans = new Map<string, { readonly attributes: Readonly<Record<string, unknown>> }>()
  for (let start = 0; start < unique.length; start += 100) {
    const viewed = await viewAllSpans(
      store,
      traceId,
      unique.slice(start, start + 100).map((hit) => hit.span_id),
      storeContext,
    )
    for (const span of viewed) spans.set(span.span_id, span)
  }
  const calls = new Map<
    string,
    { readonly hit: (typeof unique)[number]; readonly index: number; readonly leaf: ScalarLeaf }
  >()
  unique.forEach((hit, index) => {
    const part = spans.get(hit.span_id)?.attributes['braid.message_part']
    if (!record(part)) return
    const leaf = longestScalarLeaf(part.input, 'input')
    if (!leaf) return
    const callId = typeof part.callId === 'string' ? part.callId : hit.span_id
    const previous = calls.get(callId)
    if (previous === undefined || leaf.text.length >= previous.leaf.text.length)
      calls.set(callId, { hit, index, leaf })
  })
  const ranked = [...calls.values()].sort(
    (left, right) => right.leaf.text.length - left.leaf.text.length || right.index - left.index,
  )
  const chosen = ranked.slice(0, 16).sort((left, right) => left.index - right.index)
  return {
    hints: spanHints(
      chosen.map((entry) => entry.hit),
      chosen.length,
    ),
    navigation: ranked
      .slice(0, 2)
      .map((entry) => navigationLine({ spanId: entry.hit.span_id, leaf: entry.leaf })),
  }
}

async function resultNavigation(
  store: TraceAnalysisStore,
  traceId: string,
  hits: readonly { readonly span_id: string }[],
  searchHasMore: boolean,
  storeContext?: { readonly signal?: AbortSignal },
): Promise<string | undefined> {
  const spanIds = [...new Set(hits.map((hit) => hit.span_id))].slice(-16)
  if (spanIds.length === 0) return undefined
  const viewed = await viewAllSpans(store, traceId, spanIds, storeContext)
  const order = new Map(spanIds.map((spanId, index) => [spanId, index]))
  const candidates = viewed.flatMap((span) => {
    const part = span.attributes['braid.message_part']
    if (!record(part)) return []
    const leaf = longestScalarLeaf(part.result, 'result')
    return leaf
      ? [{ spanId: span.span_id, leaf, status: part.status, index: order.get(span.span_id) ?? -1 }]
      : []
  })
  const completed = candidates.filter((entry) => entry.status === 'completed')
  const latest = (completed.length > 0 ? completed : candidates).sort(
    (left, right) => right.index - left.index,
  )[0]
  if (!latest) return undefined
  const label = searchHasMore
    ? latest.status === 'completed'
      ? 'Latest returned completed result (search incomplete)'
      : 'Latest returned result (search incomplete)'
    : latest.status === 'completed'
      ? 'Latest completed result'
      : 'Latest result'
  return `${label}: ${navigationLine(latest)}`
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
  const inputHints = await inputSpanHints(store, traceId, partCallHits, storeContext)
  const resultHint = await resultNavigation(
    store,
    traceId,
    partResultHits,
    partResults.has_more,
    storeContext,
  )
  if (context) {
    initialNavigationByContext.set(
      context,
      [
        'Read these exact frozen spans with viewSpans before citing their original scalar leaves:',
        ...inputHints.navigation,
        ...(resultHint ? [resultHint] : []),
      ].join('\n'),
    )
  }
  return [
    'The frozen source contains exactly one trace.',
    `Exact trace id: ${JSON.stringify(traceId)}.`,
    'Inspect these completed tool-result part spans first with viewSpans and their exact span_id values.',
    ...spanHints(partResultHits, 16),
    'If a write result only confirms success, inspect these exact normalized tool-call input spans for the edited source.',
    ...inputHints.hints,
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
  version: '1.7.6',
  question: (context: AnalystContext) =>
    ['Answer the operator question about this frozen run.', initialNavigationByContext.get(context)]
      .filter(Boolean)
      .join('\n'),
  instructions: [
    'FIRST PYTHON STEP: print(analyst_instructions) alone, with no other call or trailing expression.',
    'OUTPUT CONTRACT:',
    'Omit subject from every finding.',
    'Return one to five findings.',
    'Every evidence object must include one short exact scalar string excerpt from the cited span.',
    'For edited source, cite one exact expression from the edit, not the whole multiline edit.',
    'Copy each excerpt verbatim; never add leading or trailing whitespace or a newline.',
    'Never use an attribute label or a constructed JSON fragment as an excerpt.',
    'Read and print the original leaf string from the cited span before quoting it.',
    'Never cite text from json.dumps of an object; serialization escapes backslashes and Unicode characters.',
    'Before SUBMIT, check each proposed excerpt is a substring of that leaf string in Python.',
    'For numeric facts, quote a related model, status, or output string from the same span.',
    'Before SUBMIT, ensure each distinct request in Focus has one finding or one explicit limit.',
    'For a passing-test claim, cite an assertion for the behavior named in Focus and a later passing test run.',
    'Reconcile test results in time order; an earlier failure is not the final outcome after a later passing run.',
    'Describe a remaining gap only if it remains in the final source and test state.',
    'The final call must be SUBMIT(answer=answer, findings_json=json.dumps(findings)).',
    'Never pass either output positionally or pass the findings list without JSON encoding.',
    'Answer only the operator question shown after "Focus:".',
    'Use the trace tools before you answer.',
    'Follow PREPARED CONTEXT and inspect its exact span IDs first.',
    "For braid.run.part.updated tool results, read span.attributes['braid.message_part'].result.content[i].text when present.",
    "For tool calls, inspect original string fields inside span.attributes['braid.message_part'].input, such as input.content or input.edits[i].newText.",
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
