import type { Component, Editor, SelectItem } from '@earendil-works/pi-tui'
import type { BraidUiController } from '../shared/intents.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import { commandItems, type CommandName } from '../shared/command-registry.js'
import { ActivityView } from './activity.js'
import { DetailsViewPanel } from './details.js'
import { ForkPreviewPanel } from './fork-preview.js'
import { GraphView } from './graph.js'
import { HelpViewPanel } from './help.js'
import type { ModalCoordinator } from './modal-coordinator.js'
import { SearchableSelector } from './selector.js'
import type { BraidTheme } from './theme.js'
import { UnavailablePanel } from './terminal-shell.js'

export interface TerminalOverlayOptions {
  readonly theme: BraidTheme
  readonly controller: BraidUiController
  readonly modals: ModalCoordinator
  readonly editor: Editor
  readonly dispatchCommand: (command: CommandName, args: readonly string[]) => void
  readonly openSurface: (
    surface: 'activity' | 'graph' | 'details' | 'fork' | 'help' | 'settings',
  ) => void
  readonly openHelp: (query: string) => void
}

export class TerminalOverlayController {
  readonly #theme: BraidTheme
  readonly #controller: BraidUiController
  readonly #modals: ModalCoordinator
  readonly #editor: Editor
  readonly #dispatchCommand: TerminalOverlayOptions['dispatchCommand']
  readonly #openSurfaceCallback: TerminalOverlayOptions['openSurface']
  readonly #openHelpCallback: TerminalOverlayOptions['openHelp']

  constructor(options: TerminalOverlayOptions) {
    this.#theme = options.theme
    this.#controller = options.controller
    this.#modals = options.modals
    this.#editor = options.editor
    this.#dispatchCommand = options.dispatchCommand
    this.#openSurfaceCallback = options.openSurface
    this.#openHelpCallback = options.openHelp
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
      | 'profile'
      | 'connection'
      | 'runner'
      | 'model'
      | 'effort'
      | 'graph'
      | 'help',
  ): void {
    const view = this.#controller.view()
    const items: SelectItem[] =
      kind === 'graph'
        ? view.graph.map((node) => ({ value: node.id, label: node.title, description: node.type }))
        : kind === 'conversation'
          ? [{ value: view.branch, label: view.branch, description: 'active branch' }]
          : kind === 'profile'
            ? [
                {
                  value: view.profileName,
                  label: view.profileName,
                  description: view.profileDigest ?? '',
                },
              ]
            : kind === 'connection'
              ? [
                  {
                    value: view.connection,
                    label: view.connection,
                    description: 'active connection',
                  },
                ]
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
        else if (kind === 'conversation') this.#dispatchCommand('open', [item.value])
        else if (kind === 'profile' || kind === 'connection')
          this.#dispatchCommand(kind, [item.value])
        else if (kind === 'runner' || kind === 'model' || kind === 'effort')
          this.#dispatchCommand(kind, [item.value])
      },
      onCancel: () => this.#modals.closeTop(),
    })
    this.#modals.open(selector, { anchor: 'center', width: '70%', minWidth: 32, maxHeight: 14 })
  }

  openHelp(query: string): void {
    const help = new HelpViewPanel(this.#theme)
    help.setQuery(query)
    this.#modals.open(help, { anchor: 'center', width: '86%', maxHeight: '90%' })
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
      panel = new UnavailablePanel(
        this.#theme,
        'settings unavailable',
        'Settings persistence is not exposed by the current application core',
      )
    } else if (surface === 'fork') {
      const fork = new ForkPreviewPanel(this.#theme)
      fork.setView(view)
      panel = fork
    } else if (surface === 'help') {
      const help = new HelpViewPanel(this.#theme)
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
}
