import type { Component } from '@earendil-works/pi-tui'
import type { AnalysisRecord } from '../../domain/entities.js'
import type { BraidUiController } from '../shared/intents.js'
import { sanitizeNotification } from '../shared/sanitize.js'
import { ActivityBrowserPanel, type ActivityBrowserScope } from './activity-browser.js'
import { isAnalysisComparisonResult } from './comparison.js'
import { DetailsViewPanel } from './details.js'
import { GraphView } from './graph.js'
import { type HelpViewOptions, HelpViewPanel } from './help.js'
import type { ModalCoordinator } from './modal-coordinator.js'
import { SearchableSelector } from './selector.js'
import { UnavailablePanel } from './terminal-shell.js'
import type { BraidTheme } from './theme.js'

export interface TerminalSurfaceOverlayOptions {
  readonly theme: BraidTheme
  readonly controller: BraidUiController
  readonly modals: ModalCoordinator
  readonly rows: () => number
  readonly requestRender: () => void
  readonly keyboardDiagnostic?: () => string
  readonly keymapDiagnostic?: () => string | undefined
  readonly openProfile: () => void
  readonly openConnection: () => void
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
      openSelected,
    })
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
      footer: 'enter open · esc close',
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
