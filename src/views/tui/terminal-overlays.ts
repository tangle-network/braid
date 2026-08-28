import type { Editor, SelectItem } from '@earendil-works/pi-tui'
import type { ConnectionSummary } from '../../app/connection-action-types.js'
import { type CommandName, commandItems } from '../shared/command-registry.js'
import type { UiConnectionLifecycle } from '../shared/connection-lifecycle.js'
import type { BraidUiController } from '../shared/intents.js'
import type { ActivityItemView } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import {
  type AutomationOverlayOpenOptions,
  AutomationOverlayWorkflow,
} from './automation-overlay-workflow.js'
import type { TerminalConfigurationOptions } from './configuration-wizard.js'
import { ConnectionOverlayWorkflow } from './connection-overlay-workflow.js'
import { ConnectionSetupViewPanel } from './connection-setup.js'
import { ConversationOverlayController } from './conversation-overlays.js'
import { executionTargetFor } from './execution-target.js'
import type { ModalCoordinator } from './modal-coordinator.js'
import { ProfileEditorViewPanel } from './profile-editor.js'
import { SearchableSelector } from './selector.js'
import {
  type IntelligenceProgressHandle,
  TerminalSurfaceOverlays,
} from './terminal-surface-overlays.js'
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
  readonly connectionLifecycle?: UiConnectionLifecycle
  readonly dispatchCommand: (command: CommandName, args: readonly string[]) => void
  readonly requestRender: () => void
  readonly columns: () => number
  readonly rows: () => number
}

export class TerminalOverlayController {
  readonly #theme: BraidTheme
  readonly #controller: BraidUiController
  readonly #modals: ModalCoordinator
  readonly #editor: Editor
  readonly #nextOperationId: () => string
  readonly #rows: () => number
  readonly #dispatchCommand: TerminalOverlayOptions['dispatchCommand']
  readonly #configuration: TerminalOverlayOptions['configuration']
  readonly #requestRender: TerminalOverlayOptions['requestRender']
  readonly #columns: () => number
  readonly #conversations: ConversationOverlayController
  readonly #connectionWorkflow: ConnectionOverlayWorkflow | undefined
  readonly #surfaces: TerminalSurfaceOverlays
  readonly #automation: AutomationOverlayWorkflow

  constructor(options: TerminalOverlayOptions) {
    this.#theme = options.theme
    this.#controller = options.controller
    this.#modals = options.modals
    this.#editor = options.editor
    this.#nextOperationId = options.nextOperationId
    this.#rows = options.rows
    this.#columns = options.columns
    this.#conversations = new ConversationOverlayController({
      theme: this.#theme,
      controller: this.#controller,
      modals: this.#modals,
      nextOperationId: options.nextOperationId,
      rows: options.rows,
    })
    this.#dispatchCommand = options.dispatchCommand
    this.#configuration = options.configuration
    this.#requestRender = options.requestRender
    this.#connectionWorkflow =
      options.connectionLifecycle === undefined
        ? undefined
        : new ConnectionOverlayWorkflow({
            theme: this.#theme,
            modals: this.#modals,
            lifecycle: options.connectionLifecycle,
            nextOperationId: this.#nextOperationId,
            revision: () => this.#controller.view().revision,
            openPicker: () => this.openConnection(),
            showBlocked: (title, reason) => this.openUnavailable(title, reason),
            requestRender: this.#requestRender,
          })
    this.#surfaces = new TerminalSurfaceOverlays({
      theme: this.#theme,
      controller: this.#controller,
      modals: this.#modals,
      rows: options.rows,
      requestRender: options.requestRender,
      nextOperationId: options.nextOperationId,
      ...(options.keyboardDiagnostic === undefined
        ? {}
        : { keyboardDiagnostic: options.keyboardDiagnostic }),
      ...(options.keymapDiagnostic === undefined
        ? {}
        : { keymapDiagnostic: options.keymapDiagnostic }),
      openProfile: () => this.openProfile(),
      openConnection: () => this.openConnection(),
      focusRun: (runId) => {
        void this.#controller.dispatch({
          type: 'focus-run',
          operationId: this.#nextOperationId(),
          runId,
        })
      },
    })
    this.#automation = new AutomationOverlayWorkflow({
      theme: this.#theme,
      controller: this.#controller,
      modals: this.#modals,
      nextOperationId: this.#nextOperationId,
      requestRender: this.#requestRender,
      showError: (title, reason) => this.openUnavailable(title, reason),
    })
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
      rows: this.#rows,
    })
    this.#modals.open(panel, {
      anchor: 'top-left',
      width: '100%',
      maxHeight: '100%',
      margin: 0,
      fullScreenBelow: Number.MAX_SAFE_INTEGER,
    })
  }

  openConnectionEditor(): void {
    if (this.#connectionWorkflow === undefined) {
      this.openUnavailable(
        'connection creation unavailable',
        'Production connection storage is not configured',
      )
      return
    }
    this.#connectionWorkflow.openEditor()
  }

  openConnection(query = ''): void {
    const panel = new ConnectionSetupViewPanel(this.#theme, {
      controller: this.#controller,
      nextOperationId: this.#nextOperationId,
      query,
      ...(this.#connectionWorkflow === undefined
        ? {}
        : {
            onCreate: () => this.#connectionWorkflow?.openEditor(),
            onRemove: (connection: ConnectionSummary) =>
              this.#connectionWorkflow?.openRemoval(connection),
          }),
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
    const { confirmation, requiresCredential, ...configurationWithoutConfirmation } = configuration
    const wizard = new ConfigurationWizard({
      ...configurationWithoutConfirmation,
      ...(confirmation === undefined ? {} : { confirmation }),
      ...(requiresCredential === undefined ? {} : { requiresCredential }),
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
      markDescriptionOverflow: true,
      maxVisible: Math.max(1, Math.min(8, this.#rows() - 6)),
      footer:
        this.#columns() < 60
          ? 'enter choose · ←/esc close'
          : 'type to filter · enter to choose · ←/esc close',
      onSelect: (item) => {
        this.#modals.closeTop()
        this.#dispatchCommand(item.value as CommandName, [])
      },
      onCancel: () => this.#modals.closeTop(),
    })
    this.#modals.open(palette, {
      anchor: 'top-left',
      width: '100%',
      maxHeight: '100%',
      margin: 0,
      fullScreenBelow: Number.MAX_SAFE_INTEGER,
    })
  }

  openSwitcher(): void {
    const view = this.#controller.view()
    const items: SelectItem[] = [
      {
        value: 'profile',
        label: 'Profile',
        description: `${view.profileName} · selected agent`,
      },
      {
        value: 'connection',
        label: 'Connection',
        description: `${view.connection} · execution route`,
      },
      {
        value: 'runner',
        label: 'Runner',
        description: `${view.runner} · ${view.runOverrides?.runner === undefined ? 'from profile' : 'branch override'}`,
      },
      {
        value: 'model',
        label: 'Model',
        description: `${view.model} · ${view.runOverrides?.model === undefined ? 'from profile' : 'branch override'}`,
      },
      {
        value: 'effort',
        label: 'Thinking',
        description: `${view.effort ?? 'runner default'} · ${view.runOverrides?.effort === undefined ? 'from profile' : 'branch override'}`,
      },
    ]
    const selector = new SearchableSelector({
      title: 'Run configuration',
      items,
      maxVisible: 5,
      theme: this.#theme,
      footer: 'enter to change · ←/esc close',
      onSelect: (item) => {
        this.#modals.closeTop()
        if (item.value === 'profile') this.openProfile()
        else if (item.value === 'connection') this.openConnection()
        else this.#startOverrideEntry(item.value as 'runner' | 'model' | 'effort')
      },
      onCancel: () => this.#modals.closeTop(),
    })
    this.#modals.open(selector, { anchor: 'center', width: '72%', minWidth: 34, maxHeight: 14 })
  }

  openAnalysisSource(question: readonly string[], sources: readonly ActivityItemView[]): void {
    const view = this.#controller.view()
    const selector = new SearchableSelector({
      title: 'Ask about a run',
      items: [...sources].reverse().map((source) => {
        const runId = source.entityId ?? source.runId ?? source.id
        const target = executionTargetFor(view, runId)
        return {
          value: runId,
          label: source.title,
          description: [
            source.status,
            target.runner,
            target.model,
            target.connection,
            source.occurredAt,
          ]
            .filter((value): value is string => value !== undefined && value.length > 0)
            .join(' · '),
        }
      }),
      theme: this.#theme,
      onSelect: (item) => {
        this.#modals.closeTop()
        this.#dispatchCommand('ask', [`run:${item.value}`, ...question])
      },
      onCancel: () => this.#modals.closeTop(),
    })
    this.#modals.open(selector, { anchor: 'center', width: '78%', minWidth: 36, maxHeight: '80%' })
  }

  openAutomation(options: AutomationOverlayOpenOptions = {}): void {
    this.#automation.open(options)
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
    if (kind === 'runner' || kind === 'model' || kind === 'effort') {
      this.#startOverrideEntry(kind)
      return
    }
    const view = this.#controller.view()
    const items: SelectItem[] =
      kind === 'graph'
        ? view.graph.map((node) => ({ value: node.id, label: node.title, description: node.type }))
        : commandItems(view.capabilities)
    const selector = new SearchableSelector({
      title: kind,
      items,
      theme: this.#theme,
      onSelect: (item) => {
        this.#modals.closeTop()
        if (kind === 'graph') this.openSurface('graph')
        else if (kind === 'help') this.openHelp(item.value)
      },
      onCancel: () => this.#modals.closeTop(),
    })
    this.#modals.open(selector, { anchor: 'center', width: '70%', minWidth: 32, maxHeight: 14 })
  }

  #startOverrideEntry(kind: 'runner' | 'model' | 'effort'): void {
    this.#editor.setText(`/${kind} `)
    this.#requestRender()
  }

  openConversationSelector(query = ''): void {
    this.#conversations.openConversationSelector(query)
  }

  openAdjacentBranch(direction: -1 | 1): void {
    this.#conversations.openAdjacentBranch(direction)
  }

  openHelp(query: string): void {
    this.#surfaces.openHelp(query)
  }

  dispose(): void {
    this.#surfaces.dispose()
  }

  openIntelligenceResult(command: 'ask' | 'analyze' | 'compare', data: unknown): void {
    this.#surfaces.openIntelligenceResult(command, data)
  }

  openIntelligenceProgress(
    command: 'ask' | 'analyze' | 'compare',
    sourceContext?: string,
  ): IntelligenceProgressHandle {
    return this.#surfaces.openIntelligenceProgress(command, sourceContext)
  }

  openSurface(surface: 'activity' | 'graph' | 'details' | 'fork' | 'help' | 'settings'): void {
    if (surface === 'fork') {
      this.#conversations.openForkPreview()
      return
    }
    this.#surfaces.openSurface(surface)
  }

  openUnavailable(title: string, reason: string): void {
    this.#surfaces.openUnavailable(title, reason)
  }
}
