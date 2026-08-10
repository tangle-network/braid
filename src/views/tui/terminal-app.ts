import type { Editor, TUI } from '@earendil-works/pi-tui'
import { commandItems } from '../shared/command-registry.js'
import type {
  BraidIntent,
  BraidUiController,
  UiDispatchResult,
  UiFrameTiming,
} from '../shared/intents.js'
import type { BraidViewModel } from '../shared/models.js'
import type { UiConnectionLifecycle } from '../shared/connection-lifecycle.js'
import { sanitizeTitle } from '../shared/sanitize.js'
import { GuardedAutocompleteProvider } from './autocomplete-guard.js'
import { DynamicAutocompleteProvider } from './dynamic-autocomplete.js'
import type { TerminalConfigurationOptions } from './configuration-wizard.js'
import { type BraidKeymap, resolveKeymap } from './keyboard.js'
import { ModalCoordinator } from './modal-coordinator.js'
import { TerminalCommandController } from './terminal-command-controller.js'
import { installTerminalOutputPolicy, keyboardCompatibility } from './terminal-compatibility.js'
import { TerminalDraftController } from './terminal-drafts.js'
import { TerminalInputController } from './terminal-input-controller.js'
import { TerminalInteractionController } from './terminal-interaction-controller.js'
import { TerminalOverlayController } from './terminal-overlays.js'
import { BraidShell } from './terminal-shell.js'
import type { BraidTheme } from './theme.js'

export interface BraidTerminalOptions {
  readonly controller: BraidUiController
  readonly tui: TUI
  readonly theme: BraidTheme
  readonly workspace: string
  readonly nextOperationId: () => string
  readonly keymap?: BraidKeymap
  readonly configuration?: TerminalConfigurationOptions
  readonly connectionLifecycle?: UiConnectionLifecycle
  readonly startupMessages?: readonly { readonly title: string; readonly reason: string }[]
  readonly onFrameTiming?: (timing: UiFrameTiming) => void
}

export class BraidTerminalApp {
  readonly #controller: BraidUiController
  readonly #tui: TUI
  readonly #theme: BraidTheme
  readonly #workspace: string
  readonly #nextOperationId: () => string
  readonly #shell: BraidShell
  readonly #drafts: TerminalDraftController
  readonly #commands: TerminalCommandController
  readonly #input: TerminalInputController
  readonly #interactions: TerminalInteractionController
  readonly #modals: ModalCoordinator
  readonly #overlays: TerminalOverlayController
  readonly #done: Promise<void>
  readonly #resolveDone: () => void
  readonly #unsubscribe: () => void
  readonly #removeInputListener: () => void
  #stopped = false
  #openConfigurationOnStart = false
  readonly #restoreTerminalOutputPolicy: () => void

  constructor(options: BraidTerminalOptions) {
    this.#controller = options.controller
    this.#tui = options.tui
    this.#theme = options.theme
    this.#workspace = options.workspace
    this.#nextOperationId = options.nextOperationId
    this.#restoreTerminalOutputPolicy = installTerminalOutputPolicy(
      options.tui.terminal,
      !options.theme.terminalMetadata,
    )
    const keymapResolution = options.keymap
      ? { keymap: options.keymap, valid: true, diagnostics: Object.freeze([]) }
      : resolveKeymap()
    const keymapDiagnostic = keymapResolution.valid
      ? undefined
      : keymapResolution.diagnostics.join('; ')
    this.#openConfigurationOnStart = options.configuration?.openOnStart === true
    this.#modals = new ModalCoordinator(options.tui)
    let resolveDone: () => void = () => {}
    this.#done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    this.#resolveDone = resolveDone

    const autocomplete = new GuardedAutocompleteProvider(
      new DynamicAutocompleteProvider({
        commands: () =>
          commandItems(this.#controller.view().capabilities).map((item) => ({
            name: item.value,
            description: item.description ?? '',
          })),
        basePath: options.workspace,
      }),
    )
    this.#shell = new BraidShell(
      options.tui,
      options.theme,
      () => options.tui.terminal.rows,
      (text) => this.#submit(text),
      (text) => {
        autocomplete.inputChanged()
        this.#drafts.changed(text)
      },
    )
    this.#drafts = new TerminalDraftController({
      editor: this.#shell.editor,
      dispatch: (intent) => this.#dispatch(intent),
      nextOperationId: this.#nextOperationId,
      requestRender: () => this.#tui.requestRender(),
    })
    this.#overlays = new TerminalOverlayController({
      theme: options.theme,
      controller: options.controller,
      modals: this.#modals,
      editor: this.#shell.editor,
      nextOperationId: this.#nextOperationId,
      keyboardDiagnostic: () => keyboardCompatibility(options.tui.terminal).message,
      keymapDiagnostic: () => keymapDiagnostic,
      ...(options.configuration === undefined ? {} : { configuration: options.configuration }),
      ...(options.connectionLifecycle === undefined
        ? {}
        : { connectionLifecycle: options.connectionLifecycle }),
      dispatchCommand: (command, args) => this.#commands.dispatchCommand(command, args),
      requestRender: () => this.#tui.requestRender(),
    })
    this.#interactions = new TerminalInteractionController({
      theme: this.#theme,
      modals: this.#modals,
      nextOperationId: this.#nextOperationId,
      dispatch: (intent) => this.#dispatch(intent),
      currentView: () => this.#controller.view(),
      isStopped: () => this.#stopped,
      openAutomation: (input) => this.#overlays.openAutomation(input),
    })
    this.#input = new TerminalInputController({
      tui: this.#tui,
      keymap: keymapResolution.keymap,
      controller: this.#controller,
      shell: this.#shell,
      drafts: this.#drafts,
      overlays: this.#overlays,
      modals: this.#modals,
      nextOperationId: this.#nextOperationId,
      dispatch: (intent) => this.#dispatch(intent),
      interactionOpen: () => this.#interactions.isOpen,
      stop: () => this.stop(),
      stateChanged: () => this.#render(this.#controller.view()),
    })
    this.#commands = new TerminalCommandController({
      controller: this.#controller,
      editor: this.#shell.editor,
      drafts: this.#drafts,
      overlays: this.#overlays,
      nextOperationId: this.#nextOperationId,
      dispatch: (intent, restoreText) => this.#dispatch(intent, restoreText),
      isStopped: () => this.#stopped,
      stop: () => this.stop(),
      showActivity: () => this.#input.showActivity(),
    })
    this.#shell.editor.setAutocompleteProvider(autocomplete)
    options.tui.addChild(this.#shell)
    this.#unsubscribe = this.#controller.subscribe((view) => this.#render(view), {
      delivery: 'frame',
      ...(options.onFrameTiming === undefined ? {} : { onFrameTiming: options.onFrameTiming }),
    })
    this.#removeInputListener = this.#tui.addInputListener((data) => this.#input.handle(data))
    this.#render(this.#controller.view())
    if (keymapDiagnostic) {
      this.#overlays.openUnavailable('key mappings unavailable', keymapDiagnostic)
    }
    for (const message of options.startupMessages ?? [])
      this.#overlays.openUnavailable(message.title, message.reason)
  }

  get editor(): Editor {
    return this.#shell.editor
  }

  start(): Promise<void> {
    if (this.#theme.terminalMetadata)
      this.#tui.terminal.setTitle(sanitizeTitle(`Braid — ${this.#workspace}`))
    this.#tui.start()
    if (this.#modals.hasOpen()) this.#modals.focusTop()
    else this.#tui.setFocus(this.#shell.editor)
    if (this.#openConfigurationOnStart) {
      this.#openConfigurationOnStart = false
      this.#overlays.openConfiguration()
    }
    return this.#done
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    this.#input.close()
    this.#drafts.close()
    this.#modals.closeAll()
    this.#removeInputListener()
    this.#unsubscribe()
    this.#tui.stop()
    this.#restoreTerminalOutputPolicy()
    this.#resolveDone()
  }

  #render(view: BraidViewModel): void {
    this.#drafts.restore(view)
    this.#shell.setView(view, this.#input.quitArmed)
    this.#shell.setActivityVisible(this.#input.activityVisible)
    this.#interactions.sync(view)
    this.#tui.requestRender()
  }

  #submit(rawText: string): void {
    this.#commands.submit(rawText)
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
}
