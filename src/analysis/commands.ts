/**
 * The single command registry shared by the TUI editor, the command palette,
 * and the headless RPC surface. Views and the controller must not keep their
 * own list of analysis command names.
 */

export type AnalysisKind = 'ask' | 'failure' | 'cost' | 'tools' | 'improvement'

export const ANALYSIS_KINDS: readonly AnalysisKind[] = [
  'ask',
  'failure',
  'cost',
  'tools',
  'improvement',
]

export const MAX_QUESTION_LENGTH = 2_000
export const MAX_SELECTED_FINDINGS = 64

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:-]{0,255}$/u

export type AnalysisCommand =
  | { readonly command: 'analysis'; readonly kind: AnalysisKind; readonly question?: string }
  | {
      readonly command: 'compare'
      readonly baselineSourceId: string
      readonly treatmentSourceId: string
    }
  | {
      readonly command: 'promote'
      readonly analysisId: string
      readonly findingIds: readonly string[]
    }
  | {
      readonly command: 'fork'
      readonly analysisId: string
      readonly findingIds: readonly string[]
    }

export type ParsedAnalysisCommand =
  | { readonly status: 'command'; readonly command: AnalysisCommand }
  | { readonly status: 'invalid'; readonly name: string; readonly message: string }

export interface AnalysisCommandSpec {
  readonly name: string
  readonly usage: string
  readonly summary: string
}

export const ANALYSIS_COMMAND_SPECS: readonly AnalysisCommandSpec[] = [
  { name: 'ask', usage: '/ask <question>', summary: 'Cited answer about the frozen run' },
  { name: 'analyze', usage: '/analyze <recipe>', summary: 'Run a named analysis recipe' },
  { name: 'compare', usage: '/compare <sourceA> <sourceB>', summary: 'Paired frozen comparison' },
  {
    name: 'promote',
    usage: '/promote <analysisId> [findingId…]',
    summary: 'Attach cited findings',
  },
  { name: 'fork', usage: '/fork <analysisId> [findingId…]', summary: 'Fork from an analysis' },
]

const ANALYSIS_COMMAND_NAMES: readonly string[] = ANALYSIS_COMMAND_SPECS.map((spec) => spec.name)
export const analysisCommandNames: readonly string[] = ANALYSIS_COMMAND_NAMES

function isAnalysisKind(value: string): value is AnalysisKind {
  return ANALYSIS_KINDS.includes(value as AnalysisKind)
}

function invalid(name: string, message: string): ParsedAnalysisCommand {
  return { status: 'invalid', name, message }
}

function question(rest: readonly string[]): string | undefined {
  const text = rest.join(' ').trim()
  if (text.length === 0) return undefined
  return text
}

function selection(
  name: string,
  rest: readonly string[],
): { readonly analysisId: string; readonly findingIds: readonly string[] } | ParsedAnalysisCommand {
  const [analysisId, ...findingIds] = rest
  if (!analysisId) return invalid(name, `${name} requires an analysis identifier`)
  if (!IDENTIFIER.test(analysisId)) return invalid(name, `${name} analysis identifier is not valid`)
  if (findingIds.length > MAX_SELECTED_FINDINGS)
    return invalid(name, `${name} accepts at most ${MAX_SELECTED_FINDINGS} findings`)
  const rejected = findingIds.find((id) => !IDENTIFIER.test(id))
  if (rejected) return invalid(name, `${name} finding identifier is not valid: ${rejected}`)
  if (new Set(findingIds).size !== findingIds.length)
    return invalid(name, `${name} lists the same finding twice`)
  return { analysisId, findingIds }
}

function isParsed(value: object): value is ParsedAnalysisCommand {
  return 'status' in value
}

/** Returns null when the input is not an analysis command at all. */
export function parseAnalysisCommand(input: string): ParsedAnalysisCommand | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null
  const parts = trimmed.slice(1).split(/\s+/u).filter(Boolean)
  let name = parts.shift()
  const rest = parts
  let recipeCommand = false
  if (name === 'analyze') {
    const recipe = rest.shift()
    if (!recipe) return invalid('analyze', 'analyze requires a recipe name')
    if (!isAnalysisKind(recipe)) return invalid('analyze', `Unknown analysis recipe: ${recipe}`)
    name = recipe
    recipeCommand = true
  }
  if (name === undefined) return null
  if (!recipeCommand && ANALYSIS_KINDS.includes(name as AnalysisKind) && name !== 'ask')
    return invalid(name, `/${name} is a prototype command; use /analyze ${name}`)
  if (!ANALYSIS_COMMAND_NAMES.includes(name) && !(recipeCommand && isAnalysisKind(name)))
    return null

  if (name === 'compare') {
    if (rest.length !== 2) return invalid(name, 'compare requires exactly two source identifiers')
    const [baselineSourceId, treatmentSourceId] = rest
    if (!baselineSourceId || !treatmentSourceId || !IDENTIFIER.test(baselineSourceId))
      return invalid(name, 'compare source identifiers are not valid')
    if (!IDENTIFIER.test(treatmentSourceId))
      return invalid(name, 'compare source identifiers are not valid')
    if (baselineSourceId === treatmentSourceId)
      return invalid(name, 'compare requires two different sources')
    return {
      status: 'command',
      command: { command: 'compare', baselineSourceId, treatmentSourceId },
    }
  }

  if (name === 'promote' || name === 'fork') {
    const selected = selection(name, rest)
    if (isParsed(selected)) return selected
    return { status: 'command', command: { command: name, ...selected } }
  }

  if (!isAnalysisKind(name)) return null
  const text = question(rest)
  if (text !== undefined && text.length > MAX_QUESTION_LENGTH)
    return invalid(name, `A question may be at most ${MAX_QUESTION_LENGTH} characters`)
  if (text !== undefined && name !== 'ask')
    return invalid(name, `/${name} does not take a question; use /ask instead`)
  return {
    status: 'command',
    command: { command: 'analysis', kind: name, ...(text === undefined ? {} : { question: text }) },
  }
}
