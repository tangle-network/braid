import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import type { BraidTheme } from './theme.js'

export interface TerminalIdentityView {
  readonly workspace?: string | null
  readonly conversationTitle?: string | null
  readonly branch?: string | null
  readonly profileName: string
  readonly runner: string
  readonly model: string
  readonly backend?: string
  readonly connection: string
  readonly effort?: string
  readonly maxVisibleOutputTokens?: number
  readonly maxReasoningTokens?: number
  readonly maxTotalOutputTokens?: number
  readonly execution?: string
  readonly executionFacts?: readonly string[]
}

export function terminalContextModeForColumns(columns: number): 'narrow' | 'standard' | 'wide' {
  const safeColumns = Math.max(1, Math.floor(columns))
  if (safeColumns < 60) return 'narrow'
  if (safeColumns >= 100) return 'wide'
  return 'standard'
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
  const mode = terminalContextModeForColumns(safeWidth)
  const synthetic = isSyntheticFixture(identity.model)
  const model = synthetic
    ? ''
    : mode === 'wide'
      ? cleanTerminalField(identity.model)
      : compactModelName(identity.model)
  const profile = terminalValuePart(
    theme,
    mode === 'narrow' ? identity.profileName : `profile ${identity.profileName}`,
  )
  const route =
    mode === 'wide'
      ? terminalValuePart(
          theme,
          [identity.runner, model].filter((part) => part.length > 0).join(' / '),
        )
      : terminalValuePart(theme, model ? `${identity.runner} / ${model}` : identity.runner)
  const connection = terminalValuePart(
    theme,
    mode === 'standard'
      ? `via ${executionConnectionLabel(identity.backend, identity.connection)}`
      : executionConnectionLabel(identity.backend, identity.connection),
  )
  const effortValue = synthetic ? '' : cleanTerminalField(identity.effort)
  const effort = mode === 'wide' && effortValue ? terminalValuePart(theme, effortValue) : ''
  const configuredLimits = synthetic
    ? ''
    : mode === 'wide'
      ? configuredLimitGroup(theme, identity)
      : ''
  const execution = terminalValuePart(theme, identity.execution ?? '')
  const executionFacts =
    mode === 'wide'
      ? (identity.executionFacts ?? []).map((fact) => terminalValuePart(theme, fact))
      : []
  const branchValue = cleanTerminalField(identity.branch)
  const branch =
    mode === 'wide' && branchValue && branchValue !== 'main' && branchValue !== 'branch-1'
      ? terminalValuePart(theme, branchValue)
      : ''
  return fitTerminalColumns(
    mode === 'wide'
      ? [profile, route, connection, effort, configuredLimits, execution, ...executionFacts, branch]
      : mode === 'narrow'
        ? [profile]
        : [profile, route, connection, effort, execution, branch],
    right,
    safeWidth,
    priority,
  )
}

export function isSyntheticFixture(value: string | null | undefined): boolean {
  return cleanTerminalField(value).toLocaleLowerCase() === 'fixture/deterministic'
}

function configuredLimitGroup(theme: BraidTheme, identity: TerminalIdentityView): string {
  const limits = [
    identity.maxVisibleOutputTokens === undefined
      ? undefined
      : `vis ${compactTerminalNumber(identity.maxVisibleOutputTokens)}`,
    identity.maxReasoningTokens === undefined
      ? undefined
      : `reas ${compactTerminalNumber(identity.maxReasoningTokens)}`,
    identity.maxTotalOutputTokens === undefined
      ? undefined
      : `total ${compactTerminalNumber(identity.maxTotalOutputTokens)}`,
  ].filter((value): value is string => value !== undefined)
  return limits.length === 0 ? '' : terminalValuePart(theme, `caps ${limits.join(' · ')}`)
}

function compactModelName(value: string): string {
  const safe = cleanTerminalField(value)
  const segments = safe.split('/').filter((segment) => segment.length > 0)
  return segments.at(-1) ?? safe
}

function executionConnectionLabel(backend: string | undefined, connection: string): string {
  const provider = cleanTerminalField(backend).toLocaleLowerCase()
  const human = cleanTerminalField(connection)
  const normalizedHuman = human.toLocaleLowerCase()
  if (
    provider === 'fixture' ||
    provider === 'deterministic' ||
    provider === 'deterministic fixture' ||
    normalizedHuman === 'deterministic fixture'
  )
    return 'local'
  if (provider === 'cli-bridge' || /cli bridge/iu.test(human)) return human || 'CLI Bridge'
  if (provider === 'tangle-sandbox' || /tangle sandbox/iu.test(human)) return 'Sandbox'
  if (provider === 'tangle-inference' || /tangle inference/iu.test(human)) return 'Tangle inference'
  return human || cleanTerminalField(backend) || 'local'
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
