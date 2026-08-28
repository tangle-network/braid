import { type Component, sliceByColumn, visibleWidth } from '@earendil-works/pi-tui'
import type { BraidViewModel, EnvironmentView, WorkStripItemView } from '../shared/models.js'
import { sanitizeNotification } from '../shared/sanitize.js'
import type { ComposerMode } from './composer-view.js'
import { type ExecutionTargetView, executionTargetFor } from './execution-target.js'
import {
  fitTerminalAtomic,
  fitTerminalColumns,
  isSyntheticFixture,
  renderTerminalContext,
  terminalContextModeForColumns,
  terminalValuePart,
} from './terminal-identity.js'
import { footerMetricsFor } from './terminal-usage.js'
import type { BraidTheme } from './theme.js'

export interface TerminalChromeState {
  readonly view: BraidViewModel
  readonly quitArmed: boolean
  readonly activityVisible: boolean
  readonly navigationHint: string
  readonly composerMode: ComposerMode
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
    return [...this.renderTop(width), ...this.renderBottom(width)]
  }

  renderTop(_width: number): string[] {
    return []
  }

  renderBottom(width: number): string[] {
    const state = this.#state
    if (!state) return []
    const safeWidth = Math.max(1, Math.floor(width))
    const { view } = state
    const mode = terminalContextModeForColumns(safeWidth)
    const target = executionTargetFor(view)
    const transientNotice = state.quitArmed ? undefined : transientNoticeFor(view)
    const workStrip = renderWorkStrip(this.#theme, view, mode, safeWidth)
    if (mode === 'narrow' && transientNotice !== undefined) {
      return boundedTerminalRows(
        [statusText(this.#theme, view, transientNotice), ...workStrip],
        safeWidth,
      )
    }
    const statusValue = transientNotice ?? conciseStatus(view, state.quitArmed, mode)
    const status = statusText(this.#theme, view, statusValue)
    const navigation =
      mode === 'narrow' || transientNotice !== undefined
        ? ''
        : navigationHint(view, state.navigationHint, state.composerMode, mode)
    const hint = terminalValuePart(this.#theme, navigation)
    const executionFacts = executionFactsFor(target)
    const measured =
      mode === 'wide' && !isSyntheticFixture(target.model)
        ? footerMetricsFor(view).map((metric) => terminalValuePart(this.#theme, metric))
        : []
    const identity = {
      workspace: view.workspace,
      conversationTitle: view.conversationTitle,
      branch: view.branch,
      profileName: target.profileName,
      runner: target.runner,
      model: target.model,
      ...(target.backend === undefined ? {} : { backend: target.backend }),
      connection: target.connection,
      ...(target.effort === undefined ? {} : { effort: target.effort }),
      ...(target.maxVisibleOutputTokens === undefined
        ? {}
        : { maxVisibleOutputTokens: target.maxVisibleOutputTokens }),
      ...(target.maxReasoningTokens === undefined
        ? {}
        : { maxReasoningTokens: target.maxReasoningTokens }),
      ...(target.maxTotalOutputTokens === undefined
        ? {}
        : { maxTotalOutputTokens: target.maxTotalOutputTokens }),
    } as const
    const noticeRow =
      transientNotice === undefined ? undefined : fitTerminalAtomic(status, safeWidth)
    const idleHint = navigation.startsWith('/ commands') ? [] : [hint]
    const right = state.quitArmed
      ? [status]
      : mode === 'standard' && view.activeRunId !== undefined
        ? [status]
        : view.activeRunId !== undefined || status.length > 0
          ? [status, hint]
          : idleHint
    const identityRow = renderTerminalContext(
      this.#theme,
      identity,
      noticeRow === undefined ? right : [],
      safeWidth,
      mode === 'narrow' || state.quitArmed ? 'right' : 'left',
    )
    const identityRows = noticeRow === undefined ? [identityRow] : [identityRow, noticeRow]
    if (mode !== 'wide') return boundedTerminalRows([...identityRows, ...workStrip], safeWidth)
    const detailFacts = executionFacts.map((fact) => terminalValuePart(this.#theme, fact))
    if (detailFacts.length === 0 && measured.length === 0) {
      return boundedTerminalRows([...identityRows, ...workStrip], safeWidth)
    }
    const detailRow = fitTerminalColumns(detailFacts, measured, safeWidth, 'right')
    return boundedTerminalRows(
      [...identityRows, ...workStrip, ...(detailRow ? [detailRow] : [])],
      safeWidth,
    )
  }
}

function renderWorkStrip(
  theme: BraidTheme,
  view: BraidViewModel,
  mode: ReturnType<typeof terminalContextModeForColumns>,
  width: number,
): readonly string[] {
  const items = view.workStrip
  if (items === undefined || items.length < 2) return []
  if (mode === 'narrow') {
    return [fitTerminalAtomic(theme.muted(`work ${items.length} · /activity to switch`), width)]
  }
  const limit = mode === 'wide' ? Math.min(items.length, 8) : Math.min(items.length, 3)
  const rows = items.slice(0, limit).map((item) => workStripItem(theme, item, mode, width))
  if (items.length > limit) {
    rows.push(theme.muted(`work +${items.length - limit} more · /activity to browse`))
  }
  return rows
}

function workStripItem(
  theme: BraidTheme,
  item: WorkStripItemView,
  mode: Exclude<ReturnType<typeof terminalContextModeForColumns>, 'narrow'>,
  width: number,
): string {
  const marker = item.focused ? theme.accent('focus') : theme.muted('work')
  const state = sanitizeNotification(item.state)
  const runner = sanitizeNotification(item.runner ?? '?')
  const model = sanitizeNotification(item.model ?? '?')
  const branchWidth = Math.max(12, Math.min(mode === 'wide' ? 44 : 28, Math.floor(width / 3)))
  const branch = compactWorkIdentity(item.branchId, branchWidth)
  const actionEntries = Object.entries(item.actions)
  const actions = (
    mode === 'wide'
      ? actionEntries.map(([name, available]) => `${available ? '' : '!'}${name}`)
      : actionEntries.flatMap(([name, available]) => (available ? [name] : []))
  ).join('/')
  const waiting =
    item.interactionCount === 0
      ? ''
      : theme.warning(
          `${item.interactionCount} waiting interaction${item.interactionCount === 1 ? '' : 's'}`,
        )
  const actionText = actions.length === 0 ? '' : theme.muted(`actions ${actions}`)
  const left = [`${marker} ${branch}`, theme.muted(state), theme.muted(`${runner}/${model}`)]
  const full = fitTerminalColumns(left, [waiting, actionText], width, 'left')
  if (item.focused && actionText.length > 0 && !full.includes('actions ')) {
    return fitTerminalColumns(left, [actionText], width, 'left')
  }
  return full
}

function compactWorkIdentity(value: string, maxWidth: number): string {
  const safe = sanitizeNotification(value)
  const width = visibleWidth(safe)
  if (width <= maxWidth) return safe
  const contentWidth = Math.max(2, maxWidth - 1)
  const prefixWidth = Math.ceil(contentWidth * 0.65)
  const suffixWidth = contentWidth - prefixWidth
  const prefix = sliceByColumn(safe, 0, prefixWidth, true)
  const suffix = sliceByColumn(safe, Math.max(0, width - suffixWidth), suffixWidth, true)
  return `${prefix}…${suffix}`
}

function boundedTerminalRows(rows: readonly string[], width: number): string[] {
  return rows.map((row) => fitTerminalAtomic(row, width))
}

function executionFactsFor(target: ExecutionTargetView): readonly string[] {
  const environment = target.environment
  if (environment?.kind !== 'sandbox') return []
  const facts: string[] = []
  if (environment.runtimeEndpointHost !== undefined)
    facts.push(`host ${environment.runtimeEndpointHost}`)
  if (environment.machineId !== undefined) facts.push(`machine ${environment.machineId}`)
  if (environment.verifiedRegion !== undefined) facts.push(`region ${environment.verifiedRegion}`)
  const sample = environment.resourceSample
  if (sample !== undefined) {
    const currentMemory = finiteNonNegative(sample.memoryCurrentMb)
    if (currentMemory !== undefined) facts.push(`mem ${currentMemory}MB`)
    const peakMemory = finiteNonNegative(sample.memoryPeakMb)
    if (peakMemory !== undefined) facts.push(`peak ${peakMemory}MB`)
    const memoryLimit = finiteNonNegative(sample.memoryLimitMb)
    if (memoryLimit !== undefined) facts.push(`limit ${memoryLimit}MB`)
    const cpuUsec = finiteNonNegative(sample.cpuUsageUsec)
    if (cpuUsec !== undefined) facts.push(`cpu ${Math.round(cpuUsec / 1_000)}ms`)
  }
  const requested = requestedResourceLabel(environment)
  if (requested !== undefined) facts.push(requested)
  const gpu = environment.gpu
  if (gpu !== undefined) {
    let gpuFact = `gpu ${gpu.count}× ${gpu.accelerator}`
    const measuredCost = finiteNonNegative(gpu.billedCustomerCostUsd)
    if (measuredCost !== undefined) {
      gpuFact += ` $${measuredCost.toFixed(4)}`
    }
    facts.push(gpuFact)
  }
  return facts
}

function requestedResourceLabel(environment: EnvironmentView): string | undefined {
  const resources = environment.requestedResources
  if (resources === undefined) return undefined
  const parts = [
    finitePositive(resources.cpuCores) === undefined ? undefined : `${resources.cpuCores}cpu`,
    memoryLabel(resources.memoryMB),
    finitePositive(resources.diskGB) === undefined ? undefined : `${resources.diskGB}GB`,
    resources.accelerator === undefined
      ? undefined
      : `${resources.accelerator.count}×${resources.accelerator.kind}`,
  ].filter((value): value is string => value !== undefined)
  return parts.length === 0 ? undefined : `size ${parts.join(' · ')}`
}

function memoryLabel(value: number | undefined): string | undefined {
  if (finitePositive(value) === undefined) return undefined
  return value !== undefined && value >= 1024 && value % 1024 === 0
    ? `${value / 1024}GB`
    : `${value}MB`
}

function finitePositive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined
}

function statusText(theme: BraidTheme, view: BraidViewModel, value: string): string {
  const safe = sanitizeNotification(value)
  if (value === 'outcome unverified') return theme.warning(safe)
  if (view.status === 'failed' || view.status === 'storage-failure') return theme.danger(safe)
  if (view.status === 'running' || view.status === 'waiting' || view.status === 'cancelling')
    return theme.warning(safe)
  if (view.status === 'cancelled' || view.status === 'expired') return theme.warning(safe)
  return theme.success(safe)
}

function conciseStatus(
  view: BraidViewModel,
  quitArmed: boolean,
  mode: ReturnType<typeof terminalContextModeForColumns>,
): string {
  if (quitArmed) return 'Ctrl+C again to quit'
  if (terminalOutcomeIsUnknown(view)) return 'outcome unverified'
  const status = view.status
  if (status === 'starting')
    return mode === 'narrow' ? 'starting · Ctrl+C stop' : 'starting · Ctrl+C cancel'
  if (status === 'streaming' || status === 'running')
    return mode === 'narrow' ? 'working · Ctrl+C stop' : 'Ctrl+C cancel'
  if (status === 'waiting') return 'waiting for input'
  if (status === 'detached') return 'running remotely'
  if (status === 'reconnecting') return 'reconnecting'
  if (status === 'cancelling') return 'stopping'
  if (status === 'completed' || status === 'ready' || status === 'empty') return ''
  if (status === 'cancelled') return 'cancelled'
  if (status === 'failed') return 'failed'
  if (status === 'expired') return 'expired'
  if (status === 'unknown') return 'status unavailable'
  if (status === 'storage-failure') return 'storage error'
  const notification = sanitizeNotification(view.notice ?? view.statusText)
  return notification === 'ready for a message' ? '' : notification
}

function navigationHint(
  view: BraidViewModel,
  fallback: string,
  composerMode: ComposerMode,
  mode: ReturnType<typeof terminalContextModeForColumns>,
): string {
  if (view.activeRunId !== undefined) {
    const queue = view.capabilities['run.queue']?.available === true
    const steer = view.capabilities['run.steer']?.available === true
    if (queue && steer)
      return composerMode === 'steer' ? 'Enter steers · Alt+S queue' : 'Enter queues · Alt+S steer'
    if (queue) return 'Enter queues'
    if (steer) return 'Enter steers'
    return 'input unavailable'
  }
  if (terminalOutcomeIsUnknown(view)) return '/activity inspect'
  if (view.status === 'failed' || view.status === 'unknown') {
    return '/activity details · /new'
  }
  return mode === 'standard' ? compactNavigationHint(fallback) : fallback
}

function compactNavigationHint(value: string): string {
  return value.includes('/ commands') ? '/ commands' : value
}

function terminalOutcomeIsUnknown(view: BraidViewModel): boolean {
  if (view.activeRunId !== undefined) return false
  const completeness = view.runs.at(-1)?.completeness
  return (
    completeness === 'incomplete' ||
    completeness === 'missing-history' ||
    completeness === 'unknown'
  )
}

function transientNoticeFor(view: BraidViewModel): string | undefined {
  if (view.status !== 'empty' && view.status !== 'ready' && view.status !== 'completed') {
    return undefined
  }
  const notice = sanitizeNotification(view.notice ?? view.statusText)
  if (!notice || notice === 'ready' || notice === 'completed' || notice === 'ready for a message') {
    return undefined
  }
  return notice
}
