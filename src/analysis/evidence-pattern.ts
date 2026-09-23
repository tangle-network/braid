/**
 * Evidence search patterns arrive from an analyst, which may be a model. They
 * are compiled through this bounded gate so a catastrophic pattern cannot stall
 * the frozen-source read. Rejection is explicit; there is no silent fallback.
 */

export const MAX_PATTERN_LENGTH = 200
export const MAX_SEARCHED_CHARS = 32_768
export const MAX_SEARCH_MS = 250
export const DEFAULT_MATCH_LIMIT = 100
export const MAX_MATCH_LIMIT = 1_000

export class EvidencePatternError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvidencePatternError'
  }
}

function unboundedQuantifierAt(pattern: string, index: number): boolean {
  const character = pattern[index]
  if (character === '*' || character === '+') return true
  if (character !== '{') return false
  const close = pattern.indexOf('}', index)
  if (close === -1) return false
  return /^\{\d*,\}$/u.test(pattern.slice(index, close + 1))
}

/**
 * Rejects a group that both contains an unbounded quantifier and is itself
 * unbounded — the `(a+)+` shape behind catastrophic backtracking.
 */
function hasNestedUnboundedQuantifier(pattern: string): boolean {
  const openings: number[] = []
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '\\') {
      index += 1
      continue
    }
    if (character === '(') {
      openings.push(index)
      continue
    }
    if (character !== ')') continue
    const start = openings.pop()
    if (start === undefined) continue
    const body = pattern.slice(start + 1, index)
    let bodyUnbounded = false
    for (let inner = 0; inner < body.length; inner += 1) {
      if (body[inner] === '\\') {
        inner += 1
        continue
      }
      if (unboundedQuantifierAt(body, inner)) {
        bodyUnbounded = true
        break
      }
    }
    if (bodyUnbounded && unboundedQuantifierAt(pattern, index + 1)) return true
  }
  return false
}

function hasUnsafeConstruct(pattern: string): boolean {
  let characterClass = false
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '\\') {
      index += 1
      continue
    }
    if (character === '[') characterClass = true
    if (character === ']') characterClass = false
    if (characterClass) continue
    if (character === '*' || character === '+' || character === '?') return true
    if (character === '(' || character === ')' || character === '|') return true
    if (character === '{') {
      const close = pattern.indexOf('}', index + 1)
      if (close === -1) return true
      const contents = pattern.slice(index + 1, close)
      const match = /^(\d+)(?:,(\d+))?$/u.exec(contents)
      if (!match || Number(match[2] ?? match[1]) > 64) return true
      index = close
    }
  }
  return false
}

export function compileEvidencePattern(pattern: string, flags = 'gu'): RegExp {
  if (pattern.length === 0) throw new EvidencePatternError('A search pattern must not be empty')
  if (pattern.length > MAX_PATTERN_LENGTH)
    throw new EvidencePatternError(
      `A search pattern may be at most ${MAX_PATTERN_LENGTH} characters`,
    )
  if (hasNestedUnboundedQuantifier(pattern))
    throw new EvidencePatternError(
      'A search pattern may not nest unbounded quantifiers; rewrite without (x+)+',
    )
  if (hasUnsafeConstruct(pattern))
    throw new EvidencePatternError(
      'A search pattern uses an unbounded or compound regex construct; use bounded literals and escapes',
    )
  try {
    return new RegExp(pattern, flags)
  } catch (error) {
    throw new EvidencePatternError(
      `A search pattern is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export function boundedSearchText(text: string): string {
  return text.length <= MAX_SEARCHED_CHARS ? text : text.slice(0, MAX_SEARCHED_CHARS)
}

export function boundedMatchLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MATCH_LIMIT
  return Math.max(0, Math.min(MAX_MATCH_LIMIT, Math.trunc(value)))
}

export class SearchDeadline {
  readonly #expiresAt: number

  constructor(nowMs: number, budgetMs = MAX_SEARCH_MS) {
    this.#expiresAt = nowMs + budgetMs
  }

  assertLive(nowMs: number): void {
    if (nowMs > this.#expiresAt)
      throw new EvidencePatternError(
        `A frozen-source search exceeded its ${MAX_SEARCH_MS}ms budget`,
      )
  }
}
