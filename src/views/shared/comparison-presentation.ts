import type { AnalysisComparisonResult } from '../../app/analysis-comparison-contracts.js'
import type { AnalysisComparisonField } from '../../domain/entities.js'
import type { ComparisonArmView, ComparisonView } from './models.js'
import { sanitizeTerminalText } from './sanitize.js'

const MAX_VALUE_CHARS = 240

export function isAnalysisComparisonResult(value: unknown): value is AnalysisComparisonResult {
  if (!isRecord(value)) return false
  if (
    typeof value.baselineSourceDigest !== 'string' ||
    typeof value.candidateSourceDigest !== 'string' ||
    typeof value.baselineRunId !== 'string' ||
    typeof value.candidateRunId !== 'string' ||
    !Array.isArray(value.fields) ||
    !Array.isArray(value.rows) ||
    !isRecord(value.paired) ||
    !isRecord(value.semantic)
  ) {
    return false
  }
  return (
    Number.isInteger(value.paired.nPairs) &&
    Number.isInteger(value.paired.nUnpairedBaseline) &&
    Number.isInteger(value.paired.nUnpairedTreatment) &&
    value.semantic.status === 'unavailable' &&
    typeof value.semantic.reason === 'string'
  )
}

export function comparisonViewForResult(result: AnalysisComparisonResult): ComparisonView {
  const baseline = armView(result, 'baseline')
  const candidate = armView(result, 'candidate')
  return {
    baseline,
    candidate,
    pairCount: result.paired.nPairs,
    unpairedBaseline: result.paired.nUnpairedBaseline,
    unpairedCandidate: result.paired.nUnpairedTreatment,
    sampleLimit: sampleLimit(result.paired.nPairs),
    fields: result.fields.map((field) => ({
      name: field.name,
      baseline: capturedValue(field, 'baseline'),
      candidate: capturedValue(field, 'candidate'),
      asymmetry: field.asymmetry,
    })),
    pairedFacts: flattenFacts('paired', result.paired),
    semantic: result.semantic,
    replayed: result.replayed === true,
  }
}

export function comparisonLines(view: ComparisonView): readonly string[] {
  return ['/compare · frozen runs', ...comparisonDetails(view)]
}

export function comparisonDetails(view: ComparisonView): readonly string[] {
  const details = [
    ...armLines(view.baseline),
    ...armLines(view.candidate),
    `sample: ${view.pairCount} paired · ${view.unpairedBaseline} baseline-only · ${view.unpairedCandidate} candidate-only`,
    `! ${view.sampleLimit}`,
    'captured fields · baseline | candidate | availability',
    ...view.fields.map(
      (field) => `${field.name}: ${field.baseline} | ${field.candidate} | ${field.asymmetry}`,
    ),
    'paired measurements · candidate minus baseline where applicable',
    ...view.pairedFacts.map((fact) => `${fact.label}: ${fact.value}`),
    `semantic review: ${view.semantic.status} · ${view.semantic.reason}`,
  ]
  if (view.replayed) details.splice(0, 0, 'saved result: replayed from the local journal')
  return details.map((line) => sanitizeTerminalText(line))
}

function armLines(arm: ComparisonArmView): readonly string[] {
  return [
    `${arm.label} run: ${shortDigest(arm.runId)}`,
    `${arm.label} source: ${shortDigest(arm.sourceDigest)}`,
    `${arm.label} outcome: ${arm.outcome} · cost: ${arm.cost} · source: ${arm.costProvenance}`,
  ]
}

function armView(
  result: AnalysisComparisonResult,
  arm: 'baseline' | 'candidate',
): ComparisonArmView {
  const cost = result.fields.find((field) => field.name === 'run.cost_usd')
  const outcome = result.fields.find((field) => field.name === 'run.status')
  const costPresent = arm === 'baseline' ? cost?.baselinePresent : cost?.candidatePresent
  return {
    label: arm,
    runId: arm === 'baseline' ? result.baselineRunId : result.candidateRunId,
    sourceDigest: arm === 'baseline' ? result.baselineSourceDigest : result.candidateSourceDigest,
    outcome:
      outcome === undefined
        ? 'missing (terminal outcome not captured)'
        : capturedValue(outcome, arm),
    cost: cost === undefined ? 'missing' : capturedValue(cost, arm),
    costProvenance:
      costPresent === true ? 'frozen run field run.cost_usd' : 'not captured in frozen run',
  }
}

function capturedValue(field: AnalysisComparisonField, arm: 'baseline' | 'candidate'): string {
  const present = arm === 'baseline' ? field.baselinePresent : field.candidatePresent
  if (!present) return 'missing'
  const value = arm === 'baseline' ? field.baseline : field.candidate
  return value === undefined ? 'missing (declared present without a value)' : displayValue(value)
}

function flattenFacts(prefix: string, value: unknown): readonly { label: string; value: string }[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [{ label: prefix, value: '[]' }]
    return value.flatMap((entry, index) => flattenFacts(`${prefix}[${index}]`, entry))
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    if (entries.length === 0) return [{ label: prefix, value: '{}' }]
    return entries.flatMap(([key, entry]) => flattenFacts(`${prefix}.${key}`, entry))
  }
  return [{ label: prefix, value: displayValue(value) }]
}

function displayValue(value: unknown): string {
  let rendered: string
  if (typeof value === 'string') rendered = value
  else if (value === undefined) rendered = 'missing'
  else {
    try {
      rendered = JSON.stringify(value) ?? String(value)
    } catch {
      rendered = '[unserializable value]'
    }
  }
  const safe = sanitizeTerminalText(rendered)
  const points = Array.from(safe)
  return points.length <= MAX_VALUE_CHARS
    ? safe
    : `${points.slice(0, MAX_VALUE_CHARS - 1).join('')}…`
}

function sampleLimit(pairs: number): string {
  if (pairs === 0) return 'No matched runs exist, so no paired conclusion is available.'
  if (pairs === 1) {
    return 'One pair is descriptive; it cannot support a reliable general conclusion.'
  }
  return `${pairs} pairs describe only this measured sample; no semantic conclusion is shown.`
}

function shortDigest(value: string): string {
  const safe = sanitizeTerminalText(value)
  if (safe.length <= 24) return safe
  return `${safe.slice(0, 15)}…${safe.slice(-8)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
