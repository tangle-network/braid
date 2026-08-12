import type { Component } from '@earendil-works/pi-tui'
import type { BraidViewModel } from '../shared/models.js'
import { sanitizeNotification } from '../shared/sanitize.js'
import { executionTargetFor, type ExecutionTargetView } from './execution-target.js'
import { fitTerminalAtomic, renderTerminalContext, terminalValuePart } from './terminal-identity.js'
import { modeForColumns } from './layout.js'
import type { BraidTheme } from './theme.js'
import { metricsFor } from './terminal-usage.js'
import type { ComposerMode } from './composer-view.js'

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
    const mode = modeForColumns(safeWidth)
    const target = executionTargetFor(view)
    const transientNotice = state.quitArmed ? undefined : transientNoticeFor(view)
    if (transientNotice !== undefined) {
      return [fitTerminalAtomic(statusText(this.#theme, view, transientNotice), safeWidth)]
    }
    const status = statusText(this.#theme, view, conciseStatus(view, state.quitArmed, mode))
    const hint = terminalValuePart(
      this.#theme,
      navigationHint(view, state.navigationHint, state.composerMode),
    )
    const metrics =
      mode === 'wide'
        ? metricsFor(view).map((metric) => terminalValuePart(this.#theme, metric))
        : []
    const prioritizesAction = state.quitArmed || view.activeRunId !== undefined || status.length > 0
    const right = state.quitArmed
      ? [status]
      : view.activeRunId !== undefined
        ? [status, hint]
        : status.length > 0
          ? [status, hint]
          : metrics.length > 0
            ? metrics
            : [status, hint]
    return [
      renderTerminalContext(
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
        right,
        safeWidth,
        prioritizesAction ? 'right' : 'left',
      ),
    ]
  }
}

function executionLabel(target: ExecutionTargetView): string {
  const environment = target.environment
  if (environment === undefined) return ''
  if (environment.location === 'local' && environment.provider === 'cli-bridge') return ''
  const location = environment.location === 'unknown' ? undefined : environment.location
  const executionKind = environment.kind === 'sandbox' ? 'sandbox' : environment.provider
  const lifecycle =
    environment.lifecycle === 'active' || environment.lifecycle === 'ready'
      ? undefined
      : environment.lifecycle
  return [location, executionKind, lifecycle].filter(Boolean).join(' ')
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
  mode: ReturnType<typeof modeForColumns>,
): string {
  if (quitArmed) return 'Ctrl+C again to quit'
  if (terminalOutcomeIsUnknown(view)) return 'outcome unknown'
  const status = view.status
  if (status === 'starting')
    return mode === 'narrow' ? 'starting · Ctrl+C stop' : 'starting · Ctrl+C cancel'
  if (status === 'streaming' || status === 'running')
    return mode === 'narrow' ? 'working · Ctrl+C stop' : 'working · Ctrl+C cancel'
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
  return fallback
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
