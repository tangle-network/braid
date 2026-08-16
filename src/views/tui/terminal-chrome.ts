import type { Component } from '@earendil-works/pi-tui'
import type { BraidViewModel, EnvironmentView } from '../shared/models.js'
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
    if (transientNotice !== undefined) {
      return [fitTerminalAtomic(statusText(this.#theme, view, transientNotice), safeWidth)]
    }
    const statusValue = conciseStatus(view, state.quitArmed, mode)
    const status = statusText(this.#theme, view, statusValue)
    const navigation =
      mode === 'narrow' ? '' : navigationHint(view, state.navigationHint, state.composerMode, mode)
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
    const measuredOnRow1 =
      mode === 'wide' &&
      measured.length > 0 &&
      view.activeRunId === undefined &&
      status.length === 0
    const idleHint = navigation.startsWith('/ commands') ? [] : [hint]
    const right = state.quitArmed
      ? [status]
      : measuredOnRow1
        ? measured
        : mode === 'standard' && view.activeRunId !== undefined
          ? [status]
          : view.activeRunId !== undefined || status.length > 0
            ? [status, hint]
            : idleHint
    const row1 = renderTerminalContext(
      this.#theme,
      identity,
      right,
      safeWidth,
      mode === 'narrow' || state.quitArmed ? 'right' : 'left',
    )
    if (mode !== 'wide') return [row1]
    const row2Facts = executionFacts.map((fact) => terminalValuePart(this.#theme, fact))
    const row2Measured = measuredOnRow1 ? [] : measured
    if (row2Facts.length === 0 && row2Measured.length === 0) return [row1]
    const row2 = fitTerminalColumns(row2Facts, row2Measured, safeWidth, 'right')
    return row2.length === 0 ? [row1] : [row1, row2]
  }
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
    if (currentMemory !== undefined) facts.push(`sample mem ${currentMemory}MB`)
    const peakMemory = finiteNonNegative(sample.memoryPeakMb)
    if (peakMemory !== undefined) facts.push(`peak ${peakMemory}MB`)
    const memoryLimit = finiteNonNegative(sample.memoryLimitMb)
    if (memoryLimit !== undefined) facts.push(`sample limit ${memoryLimit}MB`)
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
  return parts.length === 0 ? undefined : `requested ${parts.join(' · ')}`
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
  if (value === 'outcome unknown') return theme.warning(safe)
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
  if (terminalOutcomeIsUnknown(view)) return 'outcome unknown'
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
