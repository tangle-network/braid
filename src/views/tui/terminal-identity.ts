import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import { type LayoutMode, modeForColumns } from './layout.js'
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
  const safeWidth = Math.max(1, Math.floor(width))
  const mode = modeForColumns(safeWidth)
  const header = identityHeader(theme, identity, safeWidth, mode)
  const profile = terminalValuePart(theme, `AgentProfile ${identity.profileName}`)
  const route = terminalValuePart(
    theme,
    mode === 'wide'
      ? `runner ${identity.runner} · model ${identity.model}`
      : `${identity.runner} / ${compactModelName(identity.model)}`,
  )
  const effort = identity.effort ? terminalValuePart(theme, `thinking ${identity.effort}`) : ''
  const outputLimit =
    identity.maxOutputTokens === undefined
      ? ''
      : terminalValuePart(theme, `output ≤${compactTerminalNumber(identity.maxOutputTokens)}`)
  const connection = terminalValuePart(
    theme,
    mode === 'narrow' ? compactConnectionName(identity.connection) : identity.connection,
  )
  const execution = terminalValuePart(theme, identity.execution ?? '')

  if (mode === 'narrow') {
    return [
      header,
      fitTerminalAtomic(joinPrefix([route, connection, effort, outputLimit], safeWidth), safeWidth),
    ]
  }

  return [
    header,
    fitTerminalColumns([profile, route], [connection, effort, outputLimit, execution], safeWidth),
  ]
}

function identityHeader(
  theme: BraidTheme,
  identity: TerminalIdentityView,
  width: number,
  mode: LayoutMode,
): string {
  if (mode === 'narrow') {
    return fitTerminalAtomic(
      `${theme.brand('braid')}  ${terminalValuePart(theme, `AgentProfile ${identity.profileName}`)}`,
      width,
    )
  }
  const workspace = fieldPart(theme, 'cwd', workspaceBasename(identity.workspace))
  const session = fieldPart(
    theme,
    'session',
    cleanTerminalField(identity.conversationTitle) || 'new conversation',
  )
  const branch = fieldPart(theme, 'branch', identity.branch)
  const parts = [theme.brand('braid'), workspace, session]
  if (mode === 'wide' && branch) parts.push(branch)
  return joinHeader(parts, width)
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

function workspaceBasename(workspace: string | null | undefined): string {
  const safe = cleanTerminalField(workspace)
  if (!safe) return 'workspace'
  const trimmed = safe.replace(/[\\/]+$/gu, '')
  if (!trimmed) return 'workspace'
  const pieces = trimmed.split(/[\\/]/u).filter((piece) => piece.length > 0)
  if (pieces.length <= 1) return safe
  return pieces.at(-1) ?? 'workspace'
}

export function terminalValuePart(theme: BraidTheme, value: string): string {
  const safe = cleanTerminalField(value)
  return safe ? theme.text(safe) : ''
}

function fieldPart(theme: BraidTheme, label: string, value: string | null | undefined): string {
  const safeLabel = cleanTerminalField(label)
  const safeValue = cleanTerminalField(value)
  if (!safeLabel || !safeValue) return ''
  return `${theme.muted(safeLabel)}  ${theme.text(safeValue)}`
}

function joinHeader(parts: readonly string[], width: number): string {
  const present = parts.filter((part) => part.length > 0)
  if (present.length === 0) return ''
  const base = joinPrefix(present.slice(0, 2), width, '  ')
  if (present.length <= 2 || !base) return base
  let result = base
  for (const part of present.slice(2)) {
    const candidate = `${result}  ·  ${part}`
    if (visibleWidth(candidate) > width) break
    result = candidate
  }
  return result
}

function joinPrefix(parts: readonly string[], width: number, separator = ' · '): string {
  const present = parts.filter((part) => part.length > 0)
  let result = ''
  for (const part of present) {
    const candidate = result ? `${result}${separator}${part}` : part
    if (visibleWidth(candidate) > width) break
    result = candidate
  }
  return result
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
      const score = (leftValue && rightValue ? 1_000 : 0) + leftIndex * 10 + rightIndex
      if (score > bestScore && visibleWidth(candidate) <= width) {
        best = candidate
        bestScore = score
      }
    }
  }
  return best
}
