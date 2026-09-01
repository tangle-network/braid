import type { Component } from '@earendil-works/pi-tui'
import type { AnalysisRecord } from '../../domain/entities.js'
import type { BraidIntent, BraidUiController } from '../shared/intents.js'
import type { ActivityItemView } from '../shared/models.js'
import type { NativeInteractiveUiActions } from '../shared/native-interactive-actions.js'
import { sanitizeNotification } from '../shared/sanitize.js'
import {
  type ActivityBrowserAction,
  ActivityBrowserPanel,
  type ActivityBrowserScope,
} from './activity-browser.js'
import { isAnalysisComparisonResult } from './comparison.js'
import { ConversationConfirmation } from './conversation-dialogs.js'
import { DetailsViewPanel } from './details.js'
import type { EntityBrowserRow } from './entity-browser.js'
import { GraphView } from './graph.js'
import { type HelpViewOptions, HelpViewPanel } from './help.js'
import type { ModalCoordinator } from './modal-coordinator.js'
import { SearchableSelector } from './selector.js'
import { createWorkerSteerPrompt } from './supervisor-actions.js'
import { UnavailablePanel } from './terminal-shell.js'
import type { BraidTheme } from './theme.js'

export interface TerminalSurfaceOverlayOptions {
  readonly theme: BraidTheme
  readonly controller: BraidUiController
  readonly modals: ModalCoordinator
  readonly rows: () => number
  readonly requestRender: () => void
  readonly nextOperationId: () => string
  readonly keyboardDiagnostic?: () => string
  readonly keymapDiagnostic?: () => string | undefined
  readonly openProfile: () => void
  readonly openConnection: () => void
  readonly focusRun?: (runId: string) => void
  readonly nativeInteractive?: NativeInteractiveUiActions
}

export interface IntelligenceProgressHandle {
  complete(data: unknown): void
}

export class TerminalSurfaceOverlays {
  readonly #options: TerminalSurfaceOverlayOptions
  #supervisionRefresh: ReturnType<typeof setInterval> | undefined
  #supervisionRefreshGeneration = 0
  #supervisionRefreshInFlightGeneration: number | undefined
  #supervisionStatus: string | undefined
  #disposed = false

  constructor(options: TerminalSurfaceOverlayOptions) {
    this.#options = options
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#stopSupervisionRefresh(false)
  }

  openHelp(query: string): void {
    const help = new HelpViewPanel(this.#options.theme, this.#helpOptions())
    help.setQuery(query)
    this.#options.modals.open(help, {
      anchor: 'center',
      width: '86%',
      maxHeight: '90%',
    })
  }

  openIntelligenceResult(
    command: 'ask' | 'analyze' | 'compare',
    data: unknown,
    sourceContext?: string,
  ): void {
    if (command === 'compare') {
      if (!isAnalysisComparisonResult(data)) {
        this.openUnavailable('/compare', 'The saved comparison result could not be rendered')
        return
      }
      const selectedId = comparisonActivityId(data)
      if (selectedId === undefined) {
        this.openUnavailable('/compare', 'The saved comparison has no stable analysis id')
        return
      }
      if (!this.#hasActivity(selectedId)) {
        this.openUnavailable('/compare', 'The saved comparison is missing from activity')
        return
      }
      this.#openActivity('analyses', selectedId, true, sourceContext)
      return
    }
    const analysis = analysisRecordFromDispatchData(data)
    if (analysis === undefined) {
      this.openUnavailable(`/${command}`, 'The saved analysis result could not be rendered')
      return
    }
    const selectedId = `analysis:${String(analysis.id)}`
    if (!this.#hasActivity(selectedId)) {
      this.openUnavailable(`/${command}`, 'The saved analysis is missing from activity')
      return
    }
    this.#openActivity('analyses', selectedId, true, sourceContext)
  }

  openIntelligenceProgress(
    command: 'ask' | 'analyze' | 'compare',
    sourceContext?: string,
  ): IntelligenceProgressHandle {
    let active = true
    const panel = this.#activityPanel(
      'analyses',
      undefined,
      false,
      `Starting /${command}\u2026`,
      sourceContext,
    )
    this.#openBrowser(panel, false, () => {
      active = false
    })
    return {
      complete: (data) => {
        if (!active) return
        this.openIntelligenceResult(command, data, sourceContext)
      },
    }
  }

  openSurface(surface: 'activity' | 'graph' | 'details' | 'fork' | 'help' | 'settings'): void {
    const view = this.#options.controller.view()
    let panel: Component
    if (surface === 'activity') {
      panel = this.#activityPanel('all')
    } else if (surface === 'graph') {
      panel = new GraphView(this.#options.theme, {
        view: () => this.#options.controller.view(),
        rows: this.#options.rows,
        onClose: () => this.#options.modals.closeTop(),
        selectedId: `branch:${view.branch}`,
        notice: () => this.#supervisionStatus,
      })
    } else if (surface === 'details') {
      const details = new DetailsViewPanel(this.#options.theme)
      details.setView(view)
      panel = details
    } else if (surface === 'settings') {
      panel = this.#settings()
    } else if (surface === 'help') {
      const help = new HelpViewPanel(this.#options.theme, this.#helpOptions())
      help.setQuery('')
      panel = help
    } else {
      panel = new UnavailablePanel(
        this.#options.theme,
        'surface unavailable',
        surface === 'fork'
          ? 'Open the fork command to preview a branch boundary'
          : 'This surface is not available',
      )
    }
    if (surface === 'activity' || surface === 'graph') {
      this.#openBrowser(panel, true)
      return
    }
    this.#options.modals.open(panel, { anchor: 'center', width: '90%', maxHeight: '90%' })
  }

  #openActivity(
    scope: ActivityBrowserScope,
    selectedId?: string,
    openSelected = false,
    pinned?: string,
  ): void {
    const panel = this.#activityPanel(scope, selectedId, openSelected, undefined, pinned)
    this.#openBrowser(panel)
  }

  #activityPanel(
    scope: ActivityBrowserScope,
    selectedId?: string,
    openSelected = false,
    emptyMessage?: string,
    pinned?: string,
  ): ActivityBrowserPanel {
    return new ActivityBrowserPanel(this.#options.theme, {
      view: () => this.#options.controller.view(),
      rows: this.#options.rows,
      onClose: () => this.#options.modals.closeTop(),
      scope,
      ...(scope === 'analyses' ? {} : { notice: () => this.#supervisionStatus }),
      ...(selectedId === undefined ? {} : { selectedId }),
      ...(emptyMessage === undefined ? {} : { emptyMessage }),
      ...(pinned === undefined ? {} : { pinned }),
      onOpenSelected: (row) => this.#focusSelectedRun(row),
      onAction: (action, actionSelectedId) => this.#handleActivityAction(action, actionSelectedId),
      ...(this.#options.nativeInteractive === undefined
        ? {}
        : {
            workerAttachAvailable: () =>
              this.#options.nativeInteractive?.workerAvailability?.().available === true,
          }),
      openSelected,
    })
  }

  #focusSelectedRun(row: EntityBrowserRow): void {
    if (row.kind !== 'run' || row.runId === undefined) return
    this.#options.focusRun?.(row.runId)
  }

  #handleActivityAction(action: ActivityBrowserAction, selectedId: string | undefined): void {
    if (action === 'refresh') {
      void this.#manualRefresh()
      return
    }
    const selected = this.#options.controller.view().activity.find((item) => item.id === selectedId)
    if (selected === undefined) {
      this.openUnavailable('activity action unavailable', 'Select an activity row first')
      return
    }
    if (action === 'steer') {
      this.#openWorkerSteer(selected)
      return
    }
    if (action === 'cancel') {
      this.#openActivityCancel(selected)
      return
    }
    if (action === 'attach') {
      void this.#attachWorker(selected)
      return
    }
    this.#openAnalysisPromotion(selected)
  }

  async #manualRefresh(): Promise<void> {
    const result = await this.#options.controller.dispatch({ type: 'refresh-supervision' })
    if (result.kind === 'accepted') {
      this.#setSupervisionStatus('runtime activity refreshed')
      return
    }
    this.#setSupervisionStatus(
      result.kind === 'unavailable' ? result.reason : `refresh failed: ${result.message}`,
    )
  }

  #openWorkerSteer(selected: ActivityItemView): void {
    if (
      selected.kind !== 'worker' ||
      selected.entityId === undefined ||
      selected.supervisorId === undefined
    ) {
      this.openUnavailable('steer unavailable', 'Select a runtime worker before steering')
      return
    }
    const capability = this.#options.controller.view().capabilities['supervisor.worker.steer']
    if (capability?.available !== true) {
      this.openUnavailable(
        'steer unavailable',
        capability?.reason ?? 'Runtime did not report retry-safe worker steering',
      )
      return
    }
    const prompt = createWorkerSteerPrompt({
      theme: this.#options.theme,
      worker: selected.title,
      onCancel: () => this.#options.modals.closeTop(),
      onSubmit: (message) => {
        void this.#options.controller
          .dispatch({
            type: 'headless-command',
            command: 'steer_worker',
            operationId: this.#options.nextOperationId(),
            params: {
              supervisorId: selected.supervisorId,
              workerId: selected.entityId,
              text: message,
            },
          })
          .then((result) => {
            if (result.kind !== 'accepted') {
              prompt.setError(result.kind === 'unavailable' ? result.reason : result.message)
              return
            }
            this.#options.modals.closeTop()
            this.#setSupervisionStatus(`steer queued for ${selected.title}`)
          })
          .catch((error: unknown) => {
            prompt.setError(error instanceof Error ? error.message : 'Worker steering failed')
          })
      },
    })
    this.#options.modals.open(prompt, { anchor: 'center', width: '72%', maxHeight: 10 }, false)
  }

  #openActivityCancel(selected: ActivityItemView): void {
    const command = cancelCommand(selected, this.#options.nextOperationId())
    if (command === undefined) {
      this.openUnavailable(
        'cancel unavailable',
        'Select a running analysis, worker, or supervisor before cancelling',
      )
      return
    }
    const descendants = descendantCount(this.#options.controller.view().activity, selected)
    const detail =
      descendants === 0
        ? `cancel this ${selected.kind}; the result waits for an exact acknowledgement`
        : `cancel this ${selected.kind} and ${descendants} descendant(s); the result waits for exact acknowledgements`
    let confirmation: ConversationConfirmation
    confirmation = new ConversationConfirmation({
      theme: this.#options.theme,
      title: `cancel ${selected.kind}`,
      target: selected.title,
      detail,
      confirmLabel: 'request cancellation',
      onCancel: () => this.#options.modals.closeTop(),
      onConfirm: () => {
        void this.#options.controller
          .dispatch(command)
          .then((result) => {
            if (result.kind !== 'accepted') {
              confirmation.setError(result.kind === 'unavailable' ? result.reason : result.message)
              return
            }
            this.#options.modals.closeTop()
            this.#setSupervisionStatus(`cancellation requested for ${selected.title}`)
          })
          .catch((error: unknown) => {
            confirmation.setError(
              error instanceof Error ? error.message : 'Cancellation request failed',
            )
          })
      },
    })
    this.#options.modals.open(
      confirmation,
      { anchor: 'center', width: '78%', maxHeight: 10 },
      false,
    )
  }

  async #attachWorker(selected: ActivityItemView): Promise<void> {
    if (
      selected.kind !== 'worker' ||
      selected.entityId === undefined ||
      selected.supervisorId === undefined
    ) {
      this.openUnavailable('attach unavailable', 'Select a runtime worker before attaching')
      return
    }
    const actions = this.#options.nativeInteractive
    if (actions?.workerAvailability === undefined || actions.attachWorker === undefined) {
      this.openUnavailable('attach unavailable', 'Worker terminals require an interactive TUI')
      return
    }
    const availability = actions.workerAvailability(selected.entityId)
    if (!availability.available) {
      this.openUnavailable(
        'attach unavailable',
        availability.reason ?? 'Worker terminal unavailable',
      )
      return
    }
    const result = await actions.attachWorker({
      operationId: this.#options.nextOperationId(),
      supervisorId: selected.supervisorId,
      workerId: selected.entityId,
    })
    if (result.kind !== 'returned') {
      this.openUnavailable(
        'attach unavailable',
        result.kind === 'unavailable' ? result.reason : result.message,
      )
      return
    }
    this.#setSupervisionStatus(`worker terminal ${result.outcome}: ${selected.title}`)
  }

  #openAnalysisPromotion(selected: ActivityItemView): void {
    if (selected.kind !== 'analysis' || selected.entityId === undefined) {
      this.openUnavailable('promotion unavailable', 'Select a completed analysis first')
      return
    }
    const findings = (selected.analysisFindings ?? []).filter((finding) => finding.supported)
    if (findings.length === 0) {
      this.openUnavailable(
        'promotion unavailable',
        'This analysis has no cited finding that can be sent to the branch',
      )
      return
    }
    const selector = new SearchableSelector({
      title: 'send cited finding to branch',
      items: findings.map((finding) => ({
        value: finding.id,
        label: finding.title,
        description: 'cited finding',
      })),
      theme: this.#options.theme,
      footer: 'enter send · esc cancel',
      onCancel: () => this.#options.modals.closeTop(),
      onSelect: (item) => {
        void this.#options.controller
          .dispatch({
            type: 'headless-command',
            command: 'promote_analysis',
            operationId: this.#options.nextOperationId(),
            params: { analysisId: selected.entityId, findingIds: [item.value] },
          })
          .then((result) => {
            this.#options.modals.closeTop()
            if (result.kind !== 'accepted') {
              this.openUnavailable(
                'promotion unavailable',
                result.kind === 'unavailable' ? result.reason : result.message,
              )
              return
            }
            this.#options.requestRender()
          })
      },
    })
    this.#options.modals.open(selector, { anchor: 'center', width: '84%', maxHeight: '80%' }, false)
  }

  #hasActivity(id: string): boolean {
    return this.#options.controller.view().activity.some((item) => item.id === id)
  }

  #openBrowser(panel: Component, refreshSupervision = false, onClose?: () => void): void {
    const close =
      refreshSupervision || onClose !== undefined
        ? () => {
            if (refreshSupervision) this.#stopSupervisionRefresh()
            onClose?.()
          }
        : undefined
    this.#options.modals.open(panel, {
      anchor: 'top-left',
      width: '100%',
      maxHeight: '100%',
      margin: 0,
      fullScreenBelow: Number.MAX_SAFE_INTEGER,
      ...(close === undefined ? {} : { onClose: close }),
    })
    if (refreshSupervision) this.#startSupervisionRefresh()
  }

  #startSupervisionRefresh(): void {
    if (this.#disposed) return
    this.#stopSupervisionRefresh()
    const generation = ++this.#supervisionRefreshGeneration
    void this.#refreshSupervision(generation)
    this.#supervisionRefresh = setInterval(() => {
      if (generation !== this.#supervisionRefreshGeneration) return
      void this.#refreshSupervision(generation)
    }, 250)
    this.#supervisionRefresh.unref?.()
  }

  #stopSupervisionRefresh(requestRender = true): void {
    this.#supervisionRefreshGeneration += 1
    if (this.#supervisionRefresh !== undefined) clearInterval(this.#supervisionRefresh)
    this.#supervisionRefresh = undefined
    this.#supervisionRefreshInFlightGeneration = undefined
    if (requestRender) this.#setSupervisionStatus(undefined)
    else this.#supervisionStatus = undefined
  }

  async #refreshSupervision(generation: number): Promise<void> {
    if (generation !== this.#supervisionRefreshGeneration) return
    if (this.#supervisionRefreshInFlightGeneration === generation) return
    this.#supervisionRefreshInFlightGeneration = generation
    try {
      const result = await this.#options.controller.dispatch({ type: 'refresh-supervision' })
      if (generation !== this.#supervisionRefreshGeneration) return
      if (
        result.kind === 'accepted' &&
        this.#options.controller
          .view()
          .activity.some(
            (item) =>
              (item.kind === 'worker' || item.kind === 'supervisor') &&
              (item.status === 'running' || item.status === 'starting'),
          )
      ) {
        this.#options.requestRender()
      }
      this.#setSupervisionStatus(
        result.kind === 'accepted'
          ? undefined
          : result.kind === 'unavailable'
            ? `runtime activity unavailable; showing last saved state: ${result.reason}`
            : `runtime activity refresh failed; showing last saved state: ${result.message}`,
      )
    } catch (error) {
      if (generation !== this.#supervisionRefreshGeneration) return
      this.#setSupervisionStatus(
        `runtime activity refresh failed; showing last saved state: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      )
    } finally {
      if (this.#supervisionRefreshInFlightGeneration === generation) {
        this.#supervisionRefreshInFlightGeneration = undefined
      }
    }
  }

  #setSupervisionStatus(value: string | undefined): void {
    const next = value === undefined ? undefined : sanitizeNotification(value)
    if (next === this.#supervisionStatus) return
    this.#supervisionStatus = next
    this.#options.requestRender()
  }

  openUnavailable(title: string, reason: string): void {
    this.#options.modals.open(new UnavailablePanel(this.#options.theme, title, reason), {
      anchor: 'center',
      width: '80%',
      maxHeight: 8,
    })
  }

  #settings(): SearchableSelector {
    return new SearchableSelector({
      title: 'settings',
      items: [
        { value: 'profile', label: 'Profiles', description: 'list, validate, select, and save' },
        {
          value: 'connection',
          label: 'Connections',
          description: 'create, test, select, and remove',
        },
      ],
      theme: this.#options.theme,
      footer: 'enter open · ←/esc close',
      onSelect: (item) => {
        this.#options.modals.closeTop()
        if (item.value === 'profile') this.#options.openProfile()
        if (item.value === 'connection') this.#options.openConnection()
      },
      onCancel: () => this.#options.modals.closeTop(),
    })
  }

  #helpOptions(): HelpViewOptions {
    const keyboardDiagnostic = this.#options.keyboardDiagnostic?.()
    const keymapDiagnostic = this.#options.keymapDiagnostic?.()
    return {
      ...(keyboardDiagnostic === undefined ? {} : { keyboardDiagnostic }),
      ...(keymapDiagnostic === undefined ? {} : { keymapDiagnostic }),
    }
  }
}

function analysisRecordFromDispatchData(data: unknown): AnalysisRecord | undefined {
  if (!isRecord(data) || !isRecord(data.analysis)) return undefined
  const analysis = data.analysis
  if (
    typeof analysis.id !== 'string' ||
    typeof analysis.status !== 'string' ||
    !Array.isArray(analysis.findings) ||
    !isRecord(analysis.source) ||
    typeof analysis.source.digest !== 'string' ||
    typeof analysis.source.complete !== 'boolean'
  ) {
    return undefined
  }
  return analysis as unknown as AnalysisRecord
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function comparisonActivityId(value: unknown): string | undefined {
  return isRecord(value) && typeof value.analysisId === 'string'
    ? `analysis:${value.analysisId}`
    : undefined
}

function cancelCommand(
  selected: ActivityItemView,
  operationId: string,
): Extract<BraidIntent, { type: 'headless-command' }> | undefined {
  if (selected.status !== 'running' && selected.status !== 'starting') return undefined
  if (selected.kind === 'analysis' && selected.entityId !== undefined) {
    return {
      type: 'headless-command',
      command: 'cancel_analysis',
      operationId,
      params: { analysisId: selected.entityId },
    }
  }
  if (
    selected.kind === 'worker' &&
    selected.entityId !== undefined &&
    selected.supervisorId !== undefined
  ) {
    return {
      type: 'headless-command',
      command: 'cancel_worker',
      operationId,
      params: { supervisorId: selected.supervisorId, workerId: selected.entityId },
    }
  }
  if (selected.kind === 'supervisor' && selected.entityId !== undefined) {
    return {
      type: 'headless-command',
      command: 'cancel_supervisor',
      operationId,
      params: { supervisorId: selected.entityId },
    }
  }
  return undefined
}

function descendantCount(
  activity: readonly ActivityItemView[],
  selected: ActivityItemView,
): number {
  if (selected.entityId === undefined) return 0
  const queue = [selected.entityId]
  const descendants = new Set<string>()
  while (queue.length > 0) {
    const parent = queue.shift()
    if (parent === undefined) break
    for (const item of activity) {
      if (item.parentId !== parent || item.entityId === undefined || descendants.has(item.entityId))
        continue
      descendants.add(item.entityId)
      queue.push(item.entityId)
    }
  }
  return descendants.size
}
