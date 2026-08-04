import type { Component, Editor, SelectItem } from '@earendil-works/pi-tui'
import type { AnalysisRecord } from '../../domain/entities.js'
import { type CommandName, commandItems } from '../shared/command-registry.js'
import type { BraidUiController } from '../shared/intents.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import { ActivityView } from './activity.js'
import { AnalysisViewPanel } from './analysis.js'
import { ComparisonViewPanel, isAnalysisComparisonResult } from './comparison.js'
import type { TerminalConfigurationOptions } from './configuration-wizard.js'
import { ConnectionSetupViewPanel } from './connection-setup.js'
import { ConversationOverlayController } from './conversation-overlays.js'
import { DetailsViewPanel } from './details.js'
import { GraphView } from './graph.js'
import { type HelpViewOptions, HelpViewPanel } from './help.js'
import type { ModalCoordinator } from './modal-coordinator.js'
import { ProfileEditorViewPanel } from './profile-editor.js'
import { SearchableSelector } from './selector.js'
import { UnavailablePanel } from './terminal-shell.js'
import type { BraidTheme } from './theme.js'

export interface TerminalOverlayOptions {
  readonly theme: BraidTheme
  readonly controller: BraidUiController
  readonly modals: ModalCoordinator
  readonly editor: Editor
  readonly nextOperationId: () => string
  readonly keyboardDiagnostic?: () => string
  readonly keymapDiagnostic?: () => string | undefined
  readonly configuration?: TerminalConfigurationOptions
  readonly dispatchCommand: (command: CommandName, args: readonly string[]) => void
  readonly openSurface: (
    surface: 'activity' | 'graph' | 'details' | 'fork' | 'help' | 'settings',
  ) => void
  readonly openHelp: (query: string) => void
  readonly requestRender: () => void
}

export class TerminalOverlayController {
  readonly #theme: BraidTheme
  readonly #controller: BraidUiController
  readonly #modals: ModalCoordinator
  readonly #editor: Editor
  readonly #nextOperationId: () => string
  readonly #dispatchCommand: TerminalOverlayOptions['dispatchCommand']
  readonly #openSurfaceCallback: TerminalOverlayOptions['openSurface']
  readonly #openHelpCallback: TerminalOverlayOptions['openHelp']
  readonly #configuration: TerminalOverlayOptions['configuration']
  readonly #keyboardDiagnostic: TerminalOverlayOptions['keyboardDiagnostic']
  readonly #keymapDiagnostic: TerminalOverlayOptions['keymapDiagnostic']
  readonly #requestRender: TerminalOverlayOptions['requestRender']
  readonly #conversations: ConversationOverlayController

  constructor(options: TerminalOverlayOptions) {
    this.#theme = options.theme
    this.#controller = options.controller
    this.#modals = options.modals
    this.#editor = options.editor
    this.#nextOperationId = options.nextOperationId
    this.#conversations = new ConversationOverlayController({
      theme: this.#theme,
      controller: this.#controller,
      modals: this.#modals,
      nextOperationId: options.nextOperationId,
    })
    this.#dispatchCommand = options.dispatchCommand
    this.#openSurfaceCallback = options.openSurface
    this.#openHelpCallback = options.openHelp
    this.#configuration = options.configuration
    this.#keyboardDiagnostic = options.keyboardDiagnostic
    this.#keymapDiagnostic = options.keymapDiagnostic
    this.#requestRender = options.requestRender
  }

  hasConfiguration(): boolean {
    return this.#configuration !== undefined
  }

  openProfile(query = ''): void {
    const panel = new ProfileEditorViewPanel(this.#theme, {
      controller: this.#controller,
      nextOperationId: this.#nextOperationId,
      query,
      onCancel: () => this.#modals.closeTop(),
    })
    this.#modals.open(panel, { anchor: 'center', width: '88%', minWidth: 44, maxHeight: '90%' })
  }

  openConnection(query = ''): void {
    const panel = new ConnectionSetupViewPanel(this.#theme, {
      controller: this.#controller,
      nextOperationId: this.#nextOperationId,
      query,
      onCancel: () => this.#modals.closeTop(),
    })
    this.#modals.open(panel, { anchor: 'center', width: '88%', minWidth: 44, maxHeight: '90%' })
  }

  openConfiguration(): void {
    void this.#openConfiguration().catch((error: unknown) => {
      this.openUnavailable(
        'configuration unavailable',
        error instanceof Error ? error.message : 'The configuration view could not be loaded',
      )
    })
  }

  async #openConfiguration(): Promise<void> {
    const configuration = this.#configuration
    if (configuration === undefined) {
      this.openUnavailable(
        'configuration unavailable',
        'No profile and connection catalog was provided by the product integration',
      )
      return
    }
    const { ConfigurationWizard } = await import('./configuration-wizard.js')
    const { confirmation, ...configurationWithoutConfirmation } = configuration
    const wizard = new ConfigurationWizard({
      ...configurationWithoutConfirmation,
      ...(confirmation === undefined ? {} : { confirmation }),
      theme: this.#theme,
      requestRender: this.#requestRender,
      onComplete: () => {},
      onCancel: () => this.#modals.closeTop(),
    })
    this.#modals.open(wizard, { anchor: 'center', width: '82%', minWidth: 36, maxHeight: '90%' })
  }

  openCommandPalette(): void {
    const view = this.#controller.view()
    const palette = new SearchableSelector({
      title: 'Commands',
      items: commandItems(view.capabilities),
      theme: this.#theme,
      onSelect: (item) => {
        this.#modals.closeTop()
        this.#dispatchCommand(item.value as CommandName, [])
      },
      onCancel: () => this.#modals.closeTop(),
    })
    this.#modals.open(palette, { anchor: 'center', width: '70%', minWidth: 32, maxHeight: 14 })
  }

  openCorrection(name: string, suggestions: readonly CommandName[]): void {
    const items = suggestions.map((suggestion) => ({
      value: suggestion,
      label: `/${suggestion}`,
      description: 'choose to edit the draft; nothing executes yet',
    }))
    const selector = new SearchableSelector({
      title: `unknown command /${sanitizeTerminalText(name)}`,
      items,
      theme: this.#theme,
      onSelect: (item) => {
        this.#editor.setText(`/${item.value} `)
        this.#modals.closeTop()
      },
      onCancel: () => this.#modals.closeTop(),
    })
    this.#modals.open(selector, { anchor: 'center', width: '70%', minWidth: 32, maxHeight: 12 })
  }

  openSelector(
    kind:
      | 'conversation'
      | 'branch'
      | 'profile'
      | 'connection'
      | 'runner'
      | 'model'
      | 'effort'
      | 'graph'
      | 'help',
  ): void {
    if (kind === 'profile') {
      this.openProfile()
      return
    }
    if (kind === 'connection') {
      this.openConnection()
      return
    }
    if (kind === 'conversation') {
      this.#conversations.openConversationSelector()
      return
    }
    if (kind === 'branch') {
      this.#conversations.openBranchSelector()
      return
    }
    const view = this.#controller.view()
    const items: SelectItem[] =
      kind === 'graph'
        ? view.graph.map((node) => ({ value: node.id, label: node.title, description: node.type }))
        : kind === 'runner'
          ? [{ value: view.runner, label: view.runner, description: 'active runner' }]
          : kind === 'model'
            ? [{ value: view.model, label: view.model, description: 'active model' }]
            : kind === 'effort'
              ? [
                  {
                    value: view.effort ?? 'default',
                    label: view.effort ?? 'default',
                    description: 'active effort',
                  },
                ]
              : commandItems(view.capabilities)
    const selector = new SearchableSelector({
      title: kind,
      items,
      theme: this.#theme,
      onSelect: (item) => {
        this.#modals.closeTop()
        if (kind === 'graph') this.#openSurfaceCallback('graph')
        else if (kind === 'help') this.#openHelpCallback(item.value)
        else if (kind === 'runner' || kind === 'model' || kind === 'effort')
          this.#dispatchCommand(kind, [item.value])
      },
      onCancel: () => this.#modals.closeTop(),
    })
    this.#modals.open(selector, { anchor: 'center', width: '70%', minWidth: 32, maxHeight: 14 })
  }

  openConversationSelector(query = ''): void {
    this.#conversations.openConversationSelector(query)
  }

  openAdjacentBranch(direction: -1 | 1): void {
    this.#conversations.openAdjacentBranch(direction)
  }

  openHelp(query: string): void {
    const help = new HelpViewPanel(this.#theme, this.#helpOptions())
    help.setQuery(query)
    this.#modals.open(help, { anchor: 'center', width: '86%', maxHeight: '90%' })
  }

  openIntelligenceResult(command: 'ask' | 'analyze' | 'compare', data: unknown): void {
    if (command === 'compare') {
      if (!isAnalysisComparisonResult(data)) {
        this.openUnavailable('/compare', 'The saved comparison result could not be rendered')
        return
      }
      const panel = new ComparisonViewPanel(this.#theme)
      panel.setResult(data)
      this.#modals.open(panel, { anchor: 'center', width: '92%', minWidth: 36, maxHeight: '90%' })
      return
    }

    const analysis = analysisRecordFromDispatchData(data)
    if (analysis === undefined) {
      this.openUnavailable(`/${command}`, 'The saved analysis result could not be rendered')
      return
    }
    const panel = new AnalysisViewPanel(this.#theme)
    panel.setRecord(analysis)
    this.#modals.open(panel, { anchor: 'center', width: '92%', minWidth: 36, maxHeight: '90%' })
  }

  openSurface(surface: 'activity' | 'graph' | 'details' | 'fork' | 'help' | 'settings'): void {
    const view = this.#controller.view()
    let panel: Component
    if (surface === 'activity') {
      const activity = new ActivityView(this.#theme)
      activity.setView(view)
      panel = activity
    } else if (surface === 'graph') {
      const graph = new GraphView(this.#theme)
      graph.setView(view)
      panel = graph
    } else if (surface === 'details') {
      const details = new DetailsViewPanel(this.#theme)
      details.setView(view)
      panel = details
    } else if (surface === 'settings') {
      panel = new SearchableSelector({
        title: 'settings',
        items: [
          { value: 'profile', label: 'Profiles', description: 'list, validate, select, and save' },
          { value: 'connection', label: 'Connections', description: 'list, test, and select' },
        ],
        theme: this.#theme,
        footer: 'enter open · esc close',
        onSelect: (item) => {
          this.#modals.closeTop()
          if (item.value === 'profile') this.openProfile()
          if (item.value === 'connection') this.openConnection()
        },
        onCancel: () => this.#modals.closeTop(),
      })
    } else if (surface === 'fork') {
      this.#conversations.openForkPreview()
      return
    } else if (surface === 'help') {
      const help = new HelpViewPanel(this.#theme, this.#helpOptions())
      help.setQuery('')
      panel = help
    } else {
      panel = new UnavailablePanel(
        this.#theme,
        'surface unavailable',
        'This surface is not available',
      )
    }
    this.#modals.open(panel, { anchor: 'center', width: '90%', maxHeight: '90%' })
  }

  openUnavailable(title: string, reason: string): void {
    this.#modals.open(new UnavailablePanel(this.#theme, title, reason), {
      anchor: 'center',
      width: '80%',
      maxHeight: 8,
    })
  }

  #helpOptions(): HelpViewOptions {
    const keyboardDiagnostic = this.#keyboardDiagnostic?.()
    const keymapDiagnostic = this.#keymapDiagnostic?.()
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
