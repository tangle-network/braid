import type { Component } from '@earendil-works/pi-tui'
import type { BraidViewModel } from '../shared/models.js'
import { sanitizeNotification } from '../shared/sanitize.js'
import { executionTargetFor, type ExecutionTargetView } from './execution-target.js'
import {
  cleanTerminalField,
  fitTerminalAtomic,
  fitTerminalColumns,
  renderTerminalIdentity,
  terminalValuePart,
} from './terminal-identity.js'
import { modeForColumns } from './layout.js'
import type { BraidTheme } from './theme.js'
import { metricsFor } from './terminal-usage.js'

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
    return [...this.renderTop(width), ...this.renderBottom(width)]
  }

  renderTop(width: number): string[] {
    const state = this.#state
    if (!state) return []
    const { view } = state
    const target = executionTargetFor(view)
    return renderTerminalIdentity(
      this.#theme,
      {
        workspace: view.workspace,
        conversationTitle: view.conversationTitle,
        branch: view.branch,
        profileName: target.profileName,
        runner: target.runner,
        model: target.model,
        connection: target.connection,
        ...(target.effort === undefined ? {} : { effort: target.effort }),
        ...(target.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: target.maxOutputTokens }),
        execution: executionLabel(target),
      },
      width,
    )
  }

  renderBottom(width: number): string[] {
    const state = this.#state
    if (!state) return []
    const safeWidth = Math.max(1, Math.floor(width))
    const { view } = state
    const mode = modeForColumns(safeWidth)
    const execution = terminalValuePart(this.#theme, executionLabel(executionTargetFor(view)))
    const status = fitTerminalAtomic(
      statusText(this.#theme, view, conciseStatus(view, state.quitArmed)),
      safeWidth,
    )
    const hint = terminalValuePart(this.#theme, navigationHint(view, state.navigationHint))
    const metrics =
      mode === 'wide'
        ? metricsFor(view).map((metric) => terminalValuePart(this.#theme, metric))
        : []
    return [fitTerminalColumns([status, execution], [hint, ...metrics], safeWidth)]
  }
}

function executionLabel(target: ExecutionTargetView): string {
  const environment = target.environment
  if (environment === undefined) return ''
  const location = environment.location === 'local' ? 'local' : environment.location
  const executionKind =
    environment.kind === 'sandbox'
      ? 'sandbox'
      : environment.provider === 'cli-bridge'
        ? 'CLI'
        : environment.provider
  return `exec ${location ?? 'unknown'} ${executionKind} · ${environment.lifecycle}`
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
  return cleanTerminalField(view.status) || 'unknown'
}

function navigationHint(view: BraidViewModel, fallback: string): string {
  if (view.activeRunId !== undefined) return 'Enter queues input'
  if (view.status === 'failed' || view.status === 'unknown') {
    return '/export preserve · /new continue'
  }
  return fallback
}

function shortIdentifier(value: string): string {
  const safe = cleanTerminalField(value)
  return safe.length <= 18 ? safe : `${safe.slice(0, 10)}…${safe.slice(-6)}`
}
