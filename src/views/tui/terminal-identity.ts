import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import { modeForColumns } from './layout.js'
import type { BraidTheme } from './theme.js'

export interface TerminalIdentityView {
  readonly workspace?: string | null
  readonly conversationTitle?: string | null
  readonly branch?: string | null
  readonly profileName: string
  readonly runner: string
  readonly model: string
  readonly connection: string
  readonly effort?: string
  readonly maxOutputTokens?: number
  readonly execution?: string
}

export function renderTerminalIdentity(
  theme: BraidTheme,
  identity: TerminalIdentityView,
  width: number,
): string[] {
  return [renderTerminalContext(theme, identity, [], width)]
}

/** Renders the selected AgentProfile and execution route beside the composer. */
export function renderTerminalContext(
  theme: BraidTheme,
  identity: TerminalIdentityView,
  right: readonly string[],
  width: number,
  priority: 'left' | 'right' = 'left',
): string {
  const safeWidth = Math.max(1, Math.floor(width))
  const mode = modeForColumns(safeWidth)
  const model =
    mode === 'wide' ? cleanTerminalField(identity.model) : compactModelName(identity.model)
  const profile = terminalValuePart(
    theme,
    mode === 'narrow' ? identity.profileName : `profile ${identity.profileName}`,
  )
  const route = terminalValuePart(theme, `${identity.runner} / ${model}`)
  const connection = terminalValuePart(
    theme,
    mode === 'narrow' ? compactConnectionName(identity.connection) : identity.connection,
  )
  const effortValue = cleanTerminalField(identity.effort)
  const effort =
    mode === 'wide' && effortValue && effortValue !== 'none' && effortValue !== 'off'
      ? terminalValuePart(theme, effortValue)
      : ''
  const execution = terminalValuePart(theme, identity.execution ?? '')
  const branchValue = cleanTerminalField(identity.branch)
  const branch =
    mode === 'wide' && branchValue && branchValue !== 'main' && branchValue !== 'branch-1'
      ? terminalValuePart(theme, branchValue)
      : ''
  return fitTerminalColumns(
    [profile, route, connection, effort, execution, branch],
    right,
    safeWidth,
    priority,
  )
}

function compactModelName(value: string): string {
  const safe = cleanTerminalField(value)
  const segments = safe.split('/').filter((segment) => segment.length > 0)
  return segments.at(-1) ?? safe
}

function compactConnectionName(value: string): string {
  const safe = cleanTerminalField(value)
  return safe === 'deterministic fixture' ? 'fixture' : safe
}

export function cleanTerminalField(value: string | null | undefined): string {
  return value === undefined || value === null
    ? ''
    : sanitizeTerminalText(value)
        .replace(/[\n\t]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim()
}

export function terminalValuePart(theme: BraidTheme, value: string): string {
  const safe = cleanTerminalField(value)
  return safe ? theme.text(safe) : ''
}

export function fitTerminalAtomic(value: string, width: number): string {
  return truncateToWidth(value, width, '…')
}

function prefixes(parts: readonly string[], width: number, separator: string): readonly string[] {
  const present = parts.filter((part) => part.length > 0)
  const result = ['']
  let current = ''
  for (const part of present) {
    const candidate = current ? `${current}${separator}${part}` : part
    if (visibleWidth(candidate) > width) break
    result.push(candidate)
    current = candidate
  }
  return result
}

export function compactTerminalNumber(value: number): string {
  if (value < 1_000) return String(Math.round(value))
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}m`
}

export function fitTerminalColumns(
  left: readonly string[],
  right: readonly string[],
  width: number,
  priority: 'left' | 'right' = 'left',
): string {
  const leftPrefixes = prefixes(left, width, ' · ')
  const rightPrefixes = prefixes(right, width, ' · ')
  let best = ''
  let bestScore = -1
  for (let leftIndex = 0; leftIndex < leftPrefixes.length; leftIndex += 1) {
    const leftValue = leftPrefixes[leftIndex] ?? ''
    for (let rightIndex = 0; rightIndex < rightPrefixes.length; rightIndex += 1) {
      const rightValue = rightPrefixes[rightIndex] ?? ''
      if (!leftValue && !rightValue) continue
      const gap = width - visibleWidth(leftValue) - visibleWidth(rightValue)
      if (leftValue && rightValue && gap < 2) continue
      const candidate =
        leftValue && rightValue
          ? `${leftValue}${' '.repeat(gap)}${rightValue}`
          : leftValue || rightValue
      const score =
        (leftValue && rightValue ? 1_000 : 0) +
        (priority === 'right' ? rightIndex * 10 + leftIndex : leftIndex * 10 + rightIndex)
      if (score > bestScore && visibleWidth(candidate) <= width) {
        best = candidate
        bestScore = score
      }
    }
  }
  return best
}
