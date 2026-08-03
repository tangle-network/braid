import {
  CombinedAutocompleteProvider,
  type Editor,
  matchesKey,
  type TUI,
} from '@earendil-works/pi-tui'
import type { BraidIntent, BraidUiController, UiDispatchResult } from '../shared/intents.js'
import {
  commandAvailability,
  commandIntent,
  commandItems,
  isMutatingCommand,
  parseCommandInput,
  type CommandName,
} from '../shared/command-registry.js'
import type { BraidViewModel, InteractionView } from '../shared/models.js'
import { sanitizeTitle } from '../shared/sanitize.js'
import { ModalCoordinator } from './modal-coordinator.js'
import { BraidShell } from './terminal-shell.js'
import { TerminalOverlayController } from './terminal-overlays.js'
import type { BraidTheme } from './theme.js'
import { InteractionShell } from './interaction.js'

export interface BraidTerminalOptions {
  readonly controller: BraidUiController
  readonly tui: TUI
  readonly theme: BraidTheme
  readonly workspace: string
  readonly nextOperationId: () => string
  readonly startupMessages?: readonly { readonly title: string; readonly reason: string }[]
}

export class BraidTerminalApp {
  readonly #controller: BraidUiController
  readonly #tui: TUI
  readonly #theme: BraidTheme
  readonly #workspace: string
  readonly #nextOperationId: () => string
  readonly #shell: BraidShell
  readonly #modals: ModalCoordinator
  readonly #overlays: TerminalOverlayController
  readonly #done: Promise<void>
  readonly #resolveDone: () => void
  readonly #unsubscribe: () => void
  readonly #removeInputListener: () => void
  #quitTimer: ReturnType<typeof setTimeout> | undefined
  #quitArmed = false
  #stopped = false
  #activityVisible = true
  #interactionOpen = false
  #interactionKey: string | undefined
  #pendingInteractionKey: string | undefined

  constructor(options: BraidTerminalOptions) {
    this.#controller = options.controller
    this.#tui = options.tui
    this.#theme = options.theme
    this.#workspace = options.workspace
    this.#nextOperationId = options.nextOperationId
    this.#modals = new ModalCoordinator(options.tui)
    let resolveDone: () => void = () => {}
    this.#done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    this.#resolveDone = resolveDone

    this.#shell = new BraidShell(
      options.tui,
      options.theme,
      () => options.tui.terminal.rows,
      (text) => this.#submit(text),
      () => this.#tui.requestRender(),
    )
    this.#overlays = new TerminalOverlayController({
      theme: options.theme,
      controller: options.controller,
      modals: this.#modals,
      editor: this.#shell.editor,
      dispatchCommand: (command, args) => this.#dispatchCommand(command, args),
      openSurface: (surface) => this.#overlays.openSurface(surface),
      openHelp: (query) => this.#overlays.openHelp(query),
    })
    this.#shell.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(
        commandItems(this.#controller.view().capabilities).map((item) => ({
          name: item.value,
          description: item.description ?? '',
        })),
        options.workspace,
        null,
      ),
    )
    options.tui.addChild(this.#shell)
    this.#unsubscribe = this.#controller.subscribe((view) => this.#render(view))
    this.#removeInputListener = this.#tui.addInputListener((data) => this.#handleGlobalInput(data))
    this.#render(this.#controller.view())
    for (const message of options.startupMessages ?? [])
      this.#overlays.openUnavailable(message.title, message.reason)
  }

  get editor(): Editor {
    return this.#shell.editor
  }

  start(): Promise<void> {
    this.#tui.terminal.setTitle(sanitizeTitle(`Braid — ${this.#workspace}`))
    this.#tui.start()
    if (this.#modals.hasOpen()) this.#modals.focusTop()
    else this.#tui.setFocus(this.#shell.editor)
    return this.#done
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    if (this.#quitTimer) clearTimeout(this.#quitTimer)
    this.#modals.closeAll()
    this.#removeInputListener()
    this.#unsubscribe()
    this.#tui.stop()
    this.#resolveDone()
  }

  #render(view: BraidViewModel): void {
    this.#shell.setView(view, this.#quitArmed)
    this.#shell.setActivityVisible(this.#activityVisible)
    const interaction = view.interactions[0]
    const interactionKey = interaction
      ? `${interaction.runId}:${interaction.interactionId}`
      : undefined
    if (!interaction) {
      this.#pendingInteractionKey = undefined
      if (this.#interactionOpen) {
        this.#interactionOpen = false
        this.#interactionKey = undefined
        this.#modals.closeTop()
      }
    } else if (
      interactionKey &&
      interactionKey !== this.#pendingInteractionKey &&
      (!this.#interactionOpen || interactionKey !== this.#interactionKey)
    ) {
      this.openInteraction(interaction)
    }
    this.#tui.requestRender()
  }

  #submit(rawText: string): void {
    if (!rawText.trim()) return
    const parsed = parseCommandInput(rawText)
    if (parsed.kind === 'unknown') {
      this.#overlays.openCorrection(parsed.name, parsed.suggestions)
      return
    }
    if (parsed.kind === 'invalid') {
      this.#overlays.openUnavailable('Invalid command', parsed.message)
      return
    }
    if (parsed.kind === 'command') {
      this.#shell.editor.addToHistory(rawText)
      this.#shell.editor.setText('')
      this.#dispatchCommand(parsed.name, parsed.args)
      return
    }

    const view = this.#controller.view()
    const capability = view.activeRunId
      ? view.capabilities['run.queue']
      : view.capabilities['run.send']
    if (!capability?.available) {
      this.#shell.editor.setText(rawText)
      this.#overlays.openUnavailable(
        view.activeRunId ? 'Queue unavailable' : 'Send unavailable',
        capability?.reason ?? 'The current connection cannot accept this message',
      )
      return
    }
    this.#shell.editor.addToHistory(rawText)
    this.#shell.editor.setText('')
    const operationId = this.#nextOperationId()
    const intent: BraidIntent = view.activeRunId
      ? { type: 'queue', operationId, text: parsed.text }
      : { type: 'send', operationId, text: parsed.text }
    void this.#dispatch(intent, rawText)
  }

  #dispatchCommand(command: CommandName, args: readonly string[]): void {
    const availability = commandAvailability(command, this.#controller.view().capabilities)
    if (!availability.available) {
      this.#overlays.openUnavailable(
        `/${command}`,
        availability.reason ?? 'Capability is unavailable',
      )
      return
    }
    const operationId = isMutatingCommand(command) ? this.#nextOperationId() : undefined
    const intent = commandIntent(command, args, operationId)
    if (intent.type === 'open-surface') {
      if (intent.surface === 'activity') this.#activityVisible = true
      void this.#dispatch(intent).then((result) => {
        if (result.kind !== 'accepted' || this.#stopped) return
        if (intent.surface === 'help') this.#overlays.openHelp(intent.query ?? '')
        else this.#overlays.openSurface(intent.surface)
      })
      return
    }
    if (intent.type === 'shutdown') {
      void this.#dispatch(intent).then((result) => {
        if (result.kind === 'accepted') this.stop()
      })
      return
    }
    void this.#dispatch(intent).then((result) => {
      if (result.kind === 'accepted' && command === 'fork') this.#overlays.openSurface('fork')
    })
  }

  #dispatch(intent: BraidIntent, restoreText?: string): Promise<UiDispatchResult> {
    return this.#controller.dispatch(intent).then((result) => {
      if (this.#stopped) return result
      if (result.kind === 'unavailable') {
        this.#overlays.openUnavailable('Unavailable', result.reason)
        if (restoreText) this.#shell.editor.setText(restoreText)
      } else if (result.kind === 'error') {
        this.#overlays.openUnavailable(result.code, result.message)
        if (restoreText) this.#shell.editor.setText(restoreText)
      }
      this.#tui.requestRender()
      return result
    })
  }

  #handleGlobalInput(data: string): { consume?: boolean } | undefined {
    if (matchesKey(data, 'escape') && this.#tui.hasOverlay()) {
      if (this.#interactionOpen) return undefined
      this.#modals.closeTop()
      return { consume: true }
    }
    if (this.#interactionOpen) return undefined
    if (!matchesKey(data, 'ctrl+c')) this.#disarmQuit()
    if (matchesKey(data, 'ctrl+p')) {
      this.#overlays.openCommandPalette()
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+o')) {
      const availability = commandAvailability('open', this.#controller.view().capabilities)
      if (availability.available) this.#overlays.openSelector('conversation')
      else
        this.#overlays.openUnavailable(
          '/open',
          availability.reason ?? 'Conversation search is unavailable',
        )
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+g')) {
      this.#overlays.openSurface('graph')
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+k')) {
      this.#overlays.openSelector('profile')
      return { consume: true }
    }
    if (matchesKey(data, 'f2')) {
      this.#activityVisible = !this.#activityVisible
      this.#render(this.#controller.view())
      return { consume: true }
    }
    if (matchesKey(data, '?') && this.#shell.editor.getText().length === 0) {
      this.#overlays.openHelp('')
      return { consume: true }
    }
    if (
      matchesKey(data, 'ctrl+d') &&
      !this.#tui.hasOverlay() &&
      !this.#shell.editor.getText() &&
      !this.#controller.view().activeRunId
    ) {
      this.#requestShutdown()
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+c') && !this.#tui.hasOverlay()) {
      if (this.#shell.editor.getText()) {
        this.#shell.editor.setText('')
        return { consume: true }
      }
      if (this.#controller.view().activeRunId) {
        void this.#dispatch({ type: 'cancel-run', operationId: this.#nextOperationId() })
        return { consume: true }
      }
      if (this.#quitArmed) {
        this.#requestShutdown()
      } else {
        this.#armQuit()
      }
      return { consume: true }
    }
    return undefined
  }

  #requestShutdown(): void {
    void this.#dispatch({ type: 'shutdown', operationId: this.#nextOperationId() }).then(
      (result) => {
        if (result.kind === 'accepted') this.stop()
      },
    )
  }

  #armQuit(): void {
    this.#quitArmed = true
    if (this.#quitTimer) clearTimeout(this.#quitTimer)
    this.#quitTimer = setTimeout(() => {
      this.#quitTimer = undefined
      this.#quitArmed = false
      this.#render(this.#controller.view())
    }, 2_000)
    this.#render(this.#controller.view())
  }

  #disarmQuit(): void {
    if (!this.#quitArmed) return
    this.#quitArmed = false
    if (this.#quitTimer) clearTimeout(this.#quitTimer)
    this.#quitTimer = undefined
    this.#render(this.#controller.view())
  }

  openInteraction(interaction: InteractionView): void {
    this.#interactionOpen = true
    this.#interactionKey = `${interaction.runId}:${interaction.interactionId}`
    const shell = new InteractionShell(interaction, this.#theme, (response) => {
      this.#interactionOpen = false
      this.#pendingInteractionKey = this.#interactionKey
      this.#interactionKey = undefined
      this.#modals.closeTop()
      const key = this.#pendingInteractionKey
      void this.#dispatch({
        type: 'respond-interaction',
        operationId: this.#nextOperationId(),
        runId: interaction.runId,
        interactionId: interaction.interactionId,
        response,
      }).then((result) => {
        if (this.#stopped) return
        const current = this.#controller.view().interactions[0]
        const currentKey = current ? `${current.runId}:${current.interactionId}` : undefined
        if (result.kind !== 'accepted' && current && currentKey === key) {
          this.#pendingInteractionKey = undefined
          this.openInteraction(current)
        }
      })
    })
    this.#modals.open(shell, { anchor: 'center', width: '90%', maxHeight: '90%' })
  }
}
