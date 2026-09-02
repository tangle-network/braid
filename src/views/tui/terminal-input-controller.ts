import { matchesKey, type TUI } from '@earendil-works/pi-tui'
import { commandAvailability, parseCommandInput } from '../shared/command-registry.js'
import type { BraidIntent, BraidUiController, UiDispatchResult } from '../shared/intents.js'
import { liveRunId } from '../shared/run-selection.js'
import type { ComposerMode } from './composer-view.js'
import { type BraidKeymap, isTextInputSequence, matchesKeyAction } from './keyboard.js'
import type { ModalCoordinator } from './modal-coordinator.js'
import type { TerminalDraftController } from './terminal-drafts.js'
import type { TerminalOverlayController } from './terminal-overlays.js'
import type { BraidShell } from './terminal-shell.js'

export interface TerminalInputControllerOptions {
  readonly tui: TUI
  readonly keymap: BraidKeymap
  readonly controller: BraidUiController
  readonly shell: BraidShell
  readonly drafts: TerminalDraftController
  readonly overlays: TerminalOverlayController
  readonly modals: ModalCoordinator
  readonly nextOperationId: () => string
  readonly dispatch: (intent: BraidIntent) => Promise<UiDispatchResult>
  readonly interactionOpen: () => boolean
  readonly stop: () => void
  readonly stateChanged: () => void
}

/** Routes non-text terminal keys and owns the short-lived quit/activity state. */
export class TerminalInputController {
  readonly #tui: TUI
  readonly #keymap: BraidKeymap
  readonly #controller: BraidUiController
  readonly #shell: BraidShell
  readonly #drafts: TerminalDraftController
  readonly #overlays: TerminalOverlayController
  readonly #modals: ModalCoordinator
  readonly #nextOperationId: () => string
  readonly #dispatch: TerminalInputControllerOptions['dispatch']
  readonly #interactionOpen: () => boolean
  readonly #stop: () => void
  readonly #stateChanged: () => void
  #quitTimer: ReturnType<typeof setTimeout> | undefined
  #quitArmed = false
  #composerMode: ComposerMode = 'queue'

  constructor(options: TerminalInputControllerOptions) {
    this.#tui = options.tui
    this.#keymap = options.keymap
    this.#controller = options.controller
    this.#shell = options.shell
    this.#drafts = options.drafts
    this.#overlays = options.overlays
    this.#modals = options.modals
    this.#nextOperationId = options.nextOperationId
    this.#dispatch = options.dispatch
    this.#interactionOpen = options.interactionOpen
    this.#stop = options.stop
    this.#stateChanged = options.stateChanged
  }

  get quitArmed(): boolean {
    return this.#quitArmed
  }

  get composerMode(): ComposerMode {
    return this.#composerMode
  }

  close(): void {
    if (this.#quitTimer) clearTimeout(this.#quitTimer)
    this.#quitTimer = undefined
  }

  handle(data: string): { consume?: boolean } | undefined {
    if (matchesKeyAction(data, this.#keymap, 'toggleSteer')) {
      if (this.#tui.hasOverlay() || this.#interactionOpen()) return undefined
      this.#toggleComposerMode()
      return { consume: true }
    }
    if (this.#shouldSubmitBareCommand(data)) {
      this.#shell.editor.handleInput('\u001b')
      this.#shell.editor.handleInput(data)
      return { consume: true }
    }
    if (isTextInputSequence(data)) return undefined
    if (matchesKeyAction(data, this.#keymap, 'closeOverlay') && this.#tui.hasOverlay()) {
      if (
        matchesKey(data, 'left') &&
        !this.#interactionOpen() &&
        this.#modals.backOrCloseIfFullScreen()
      ) {
        return { consume: true }
      }
      if (this.#interactionOpen()) return undefined
      if (matchesKey(data, 'left')) {
        if (!this.#modals.backOrCloseIfPassive()) return undefined
        return { consume: true }
      }
      this.#modals.backOrClose()
      return { consume: true }
    }
    if (this.#interactionOpen()) return undefined
    if (this.#tui.hasOverlay()) return undefined
    if (!this.#tui.hasOverlay() && this.#shell.handleTranscriptInput(data)) {
      this.#tui.requestRender()
      return { consume: true }
    }
    if (!matchesKeyAction(data, this.#keymap, 'clearCancelQuit')) this.#disarmQuit()
    if (matchesKeyAction(data, this.#keymap, 'commandPalette')) {
      this.#overlays.openCommandPalette()
      return { consume: true }
    }
    if (matchesKeyAction(data, this.#keymap, 'conversationSelector')) {
      const availability = commandAvailability('open', this.#controller.view().capabilities)
      if (availability.available) {
        void this.#drafts.flush().then(() => this.#overlays.openSelector('conversation'))
      } else {
        this.#overlays.openUnavailable(
          '/open',
          availability.reason ?? 'Conversation search is unavailable',
        )
      }
      return { consume: true }
    }
    if (!this.#tui.hasOverlay() && matchesKeyAction(data, this.#keymap, 'previousBranch')) {
      void this.#drafts.flush().then(() => this.#overlays.openAdjacentBranch(-1))
      return { consume: true }
    }
    if (!this.#tui.hasOverlay() && matchesKeyAction(data, this.#keymap, 'nextBranch')) {
      void this.#drafts.flush().then(() => this.#overlays.openAdjacentBranch(1))
      return { consume: true }
    }
    if (matchesKeyAction(data, this.#keymap, 'graph')) {
      void this.#dispatch({ type: 'open-surface', surface: 'graph', query: '' }).then((result) => {
        if (result.kind === 'accepted') this.#overlays.openSurface('graph')
      })
      return { consume: true }
    }
    if (matchesKeyAction(data, this.#keymap, 'switcher')) {
      this.#overlays.openSwitcher()
      return { consume: true }
    }
    if (matchesKeyAction(data, this.#keymap, 'activity')) {
      this.#overlays.openSurface('activity')
      return { consume: true }
    }
    if (
      !this.#tui.hasOverlay() &&
      matchesKeyAction(data, this.#keymap, 'toggleDetails') &&
      this.#shell.toggleDetails()
    ) {
      return { consume: true }
    }
    if (matchesKeyAction(data, this.#keymap, 'help') && !this.#shell.editor.focused) {
      this.#overlays.openHelp('')
      return { consume: true }
    }
    if (
      matchesKeyAction(data, this.#keymap, 'exit') &&
      !this.#tui.hasOverlay() &&
      !this.#shell.editor.getText() &&
      liveRunId(this.#controller.view()) === undefined
    ) {
      this.#requestShutdown()
      return { consume: true }
    }
    if (matchesKeyAction(data, this.#keymap, 'clearCancelQuit') && !this.#tui.hasOverlay()) {
      if (this.#shell.editor.getText()) {
        this.#shell.editor.setText('')
        return { consume: true }
      }
      const view = this.#controller.view()
      const runId = liveRunId(view)
      if (runId) {
        void this.#dispatch({
          type: 'cancel-run',
          operationId: this.#nextOperationId(),
          runId,
        })
        return { consume: true }
      }
      if (this.#quitArmed) this.#requestShutdown()
      else this.#armQuit()
      return { consume: true }
    }
    return undefined
  }

  #shouldSubmitBareCommand(data: string): boolean {
    if (
      !matchesKey(data, 'enter') ||
      !this.#shell.editor.focused ||
      this.#tui.hasOverlay() ||
      this.#interactionOpen()
    )
      return false
    const input = this.#shell.editor.getText()
    const parsed = parseCommandInput(input)
    return parsed.kind === 'command' && parsed.args.length === 0 && !/\s/u.test(input)
  }

  #toggleComposerMode(): void {
    const view = this.#controller.view()
    const queue =
      view.activeRunId !== undefined && view.capabilities['run.queue']?.available === true
    const steer =
      view.activeRunId !== undefined && view.capabilities['run.steer']?.available === true
    if (!steer) {
      this.#overlays.openUnavailable(
        'Steering unavailable',
        'The active run does not advertise live steering.',
      )
      return
    }
    this.#composerMode = queue && this.#composerMode === 'steer' ? 'queue' : 'steer'
    this.#shell.setComposerMode(this.#composerMode)
    this.#stateChanged()
  }

  #requestShutdown(): void {
    void this.#drafts.flush().then(() =>
      this.#dispatch({ type: 'shutdown', operationId: this.#nextOperationId() }).then((result) => {
        if (result.kind === 'accepted') this.#stop()
      }),
    )
  }

  #armQuit(): void {
    this.#quitArmed = true
    if (this.#quitTimer) clearTimeout(this.#quitTimer)
    this.#quitTimer = setTimeout(() => {
      this.#quitTimer = undefined
      this.#quitArmed = false
      this.#stateChanged()
    }, 2_000)
    this.#stateChanged()
  }

  #disarmQuit(): void {
    if (!this.#quitArmed) return
    this.#quitArmed = false
    if (this.#quitTimer) clearTimeout(this.#quitTimer)
    this.#quitTimer = undefined
    this.#stateChanged()
  }
}
