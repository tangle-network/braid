import type { Component } from '@earendil-works/pi-tui'
import type { AnalysisRecord } from '../../domain/entities.js'
import type { BraidUiController } from '../shared/intents.js'
import { ActivityView } from './activity.js'
import { AnalysisViewPanel } from './analysis.js'
import { ComparisonViewPanel, isAnalysisComparisonResult } from './comparison.js'
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
  readonly keyboardDiagnostic?: () => string
  readonly keymapDiagnostic?: () => string | undefined
  readonly openProfile: () => void
  readonly openConnection: () => void
}

export class TerminalSurfaceOverlays {
  readonly #options: TerminalSurfaceOverlayOptions

  constructor(options: TerminalSurfaceOverlayOptions) {
    this.#options = options
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

  openIntelligenceResult(command: 'ask' | 'analyze' | 'compare', data: unknown): void {
    if (command === 'compare') {
      if (!isAnalysisComparisonResult(data)) {
        this.openUnavailable('/compare', 'The saved comparison result could not be rendered')
        return
      }
      const panel = new ComparisonViewPanel(this.#options.theme)
      panel.setResult(data)
      this.#options.modals.open(panel, {
        anchor: 'center',
        width: '92%',
        minWidth: 36,
        maxHeight: '90%',
      })
      return
    }
    const analysis = analysisRecordFromDispatchData(data)
    if (analysis === undefined) {
      this.openUnavailable(`/${command}`, 'The saved analysis result could not be rendered')
      return
    }
    const panel = new AnalysisViewPanel(this.#options.theme)
    panel.setRecord(analysis)
    this.#options.modals.open(panel, {
      anchor: 'center',
      width: '92%',
      minWidth: 36,
      maxHeight: '90%',
    })
  }

  openSurface(surface: 'activity' | 'graph' | 'details' | 'fork' | 'help' | 'settings'): void {
    const view = this.#options.controller.view()
    let panel: Component
    if (surface === 'activity') {
      const activity = new ActivityView(this.#options.theme)
      activity.setView(view)
      panel = activity
    } else if (surface === 'graph') {
      const graph = new GraphView(this.#options.theme)
      graph.setView(view)
      panel = graph
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
    this.#options.modals.open(panel, { anchor: 'center', width: '90%', maxHeight: '90%' })
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
