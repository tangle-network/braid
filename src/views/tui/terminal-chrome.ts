import { type Component, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import type { BraidViewModel } from '../shared/models.js'
import { sanitizeNotification, sanitizeTerminalText } from '../shared/sanitize.js'
import { type LayoutMode, modeForColumns } from './layout.js'
import type { BraidTheme } from './theme.js'

export interface TerminalChromeState {
  readonly view: BraidViewModel
  readonly quitArmed: boolean
  readonly activityVisible: boolean
  readonly navigationHint: string
}

/** Fixed-height terminal chrome; the transcript never owns these lines. */
export class TerminalChrome implements Component {
  #theme: BraidTheme
  #state: TerminalChromeState | undefined

  constructor(theme: BraidTheme) {
    this.#theme = theme
  }

  setState(state: TerminalChromeState): void {
    this.#state = state
  }

  invalidate(): void {}

  render(width: number): string[] {
    const state = this.#state
    if (!state) return []
    const safeWidth = Math.max(1, Math.floor(width))
    const { view } = state
    const mode = modeForColumns(safeWidth)
    const header = this.#header(view, safeWidth, mode)
    const status = fitAtomic(
      statusText(this.#theme, view, conciseStatus(view, state.quitArmed)),
      safeWidth,
    )
    const profile = valuePart(this.#theme, view.profileName)
    const runner = valuePart(this.#theme, `runner ${view.runner}`)
    const model = valuePart(this.#theme, view.model)
    const effort = view.effort ? valuePart(this.#theme, `thinking ${view.effort}`) : ''
    const connection = valuePart(this.#theme, view.connection)
    const metrics = valuePart(this.#theme, metricsFor(view).join(' · '))
    const hint = valuePart(this.#theme, navigationHint(view, state.navigationHint))

    if (mode === 'narrow') {
      return [header, status, joinPrefix([profile], safeWidth)]
    }

    const statusMetadata = mode === 'wide' ? [model, effort, metrics] : [model, effort]
    return [
      header,
      fitColumns([status], statusMetadata, safeWidth),
      fitColumns([profile, runner, connection], [hint], safeWidth),
    ]
  }

  #header(view: BraidViewModel, width: number, mode: LayoutMode): string {
    const workspace = fieldPart(this.#theme, 'cwd', workspaceBasename(view.workspace))
    const session = fieldPart(
      this.#theme,
      'session',
      cleanField(view.conversationTitle) || 'new conversation',
    )
    const branch = fieldPart(this.#theme, 'branch', view.branch)
    const parts = [this.#theme.brand('braid'), workspace]
    if (mode !== 'narrow') parts.push(session)
    if (mode === 'wide' && branch) parts.push(branch)
    return joinHeader(parts, width)
  }
}

function statusText(theme: BraidTheme, view: BraidViewModel, value: string): string {
  const safe = sanitizeNotification(value)
  if (view.status === 'failed' || view.status === 'storage-failure') return theme.danger(safe)
  if (view.status === 'running' || view.status === 'waiting' || view.status === 'cancelling')
    return theme.warning(safe)
  if (view.status === 'cancelled' || view.status === 'expired') return theme.warning(safe)
  return theme.success(safe)
}

function conciseStatus(view: BraidViewModel, quitArmed: boolean): string {
  if (quitArmed) return 'ctrl+c again to quit'
  const notification = sanitizeNotification(view.notice ?? view.statusText)
  if (
    view.activeRunId !== undefined &&
    (view.status === 'starting' ||
      view.status === 'streaming' ||
      view.status === 'running' ||
      view.status === 'waiting')
  ) {
    return `${notification || view.status} · Ctrl+C cancel`
  }
  if (view.status === 'failed' || view.status === 'unknown') {
    const run = view.runs.at(-1)
    if (run !== undefined) {
      const outcome = run.completeness === 'unknown' ? 'outcome unknown' : 'outcome failed'
      return `${outcome} · operation ${shortIdentifier(run.operationId ?? run.id)}`
    }
  }
  if (notification.length > 0) return notification
  return cleanField(view.status) || 'unknown'
}

function navigationHint(view: BraidViewModel, fallback: string): string {
  if (view.activeRunId !== undefined) return 'Enter queues input'
  if (view.status === 'failed' || view.status === 'unknown') {
    return '/export preserve · /new continue'
  }
  return fallback
}

function shortIdentifier(value: string): string {
  const safe = cleanField(value)
  return safe.length <= 18 ? safe : `${safe.slice(0, 10)}…${safe.slice(-6)}`
}

function cleanField(value: string | null | undefined): string {
  return value === undefined || value === null
    ? ''
    : sanitizeTerminalText(value)
        .replace(/[\n\t]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim()
}

function workspaceBasename(workspace: string | null | undefined): string {
  const safe = cleanField(workspace)
  if (!safe) return 'workspace'
  const trimmed = safe.replace(/[\\/]+$/gu, '')
  if (!trimmed) return 'workspace'
  const pieces = trimmed.split(/[\\/]/u).filter((piece) => piece.length > 0)
  if (pieces.length <= 1) return safe
  return pieces.at(-1) ?? 'workspace'
}

function valuePart(theme: BraidTheme, value: string): string {
  const safe = cleanField(value)
  return safe ? theme.text(safe) : ''
}

function fieldPart(theme: BraidTheme, label: string, value: string | null | undefined): string {
  const safeLabel = cleanField(label)
  const safeValue = cleanField(value)
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

function fitAtomic(value: string, width: number): string {
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

export function metricsFor(view: BraidViewModel): string[] {
  const input = sumKnown(view.runs.map((run) => run.usage?.input))
  const output = sumKnown(view.runs.map((run) => run.usage?.output))
  const cost = sumKnown(view.runs.map((run) => run.usage?.costUsd))
  const metrics: string[] = []
  if (input !== undefined) metrics.push(`in ${compactNumber(input)}`)
  if (output !== undefined) metrics.push(`out ${compactNumber(output)}`)
  if (cost !== undefined && Number.isFinite(cost)) metrics.push(`$${cost.toFixed(4)}`)
  return metrics
}

function sumKnown(values: readonly (number | undefined)[]): number | undefined {
  let total = 0
  let known = false
  for (const value of values) {
    if (value === undefined || !Number.isFinite(value)) continue
    total += value
    known = true
  }
  return known ? total : undefined
}

function compactNumber(value: number): string {
  if (value < 1_000) return String(Math.round(value))
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}m`
}

function fitColumns(left: readonly string[], right: readonly string[], width: number): string {
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
