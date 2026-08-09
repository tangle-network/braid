import type { Editor } from '@earendil-works/pi-tui'
import {
  type CommandName,
  commandAvailability,
  commandIntent,
  isMutatingCommand,
  parseCommandInput,
} from '../shared/command-registry.js'
import type { BraidIntent, BraidUiController, UiDispatchResult } from '../shared/intents.js'
import type { TerminalDraftController } from './terminal-drafts.js'
import type { TerminalOverlayController } from './terminal-overlays.js'

export interface TerminalCommandControllerOptions {
  readonly controller: BraidUiController
  readonly editor: Editor
  readonly drafts: TerminalDraftController
  readonly overlays: TerminalOverlayController
  readonly nextOperationId: () => string
  readonly dispatch: (intent: BraidIntent, restoreText?: string) => Promise<UiDispatchResult>
  readonly isStopped: () => boolean
  readonly stop: () => void
  readonly showActivity: () => void
}

/** Owns prompt parsing and command routing; it never owns terminal layout. */
export class TerminalCommandController {
  readonly #controller: BraidUiController
  readonly #editor: Editor
  readonly #drafts: TerminalDraftController
  readonly #overlays: TerminalOverlayController
  readonly #nextOperationId: () => string
  readonly #dispatch: TerminalCommandControllerOptions['dispatch']
  readonly #isStopped: () => boolean
  readonly #stop: () => void
  readonly #showActivity: () => void

  constructor(options: TerminalCommandControllerOptions) {
    this.#controller = options.controller
    this.#editor = options.editor
    this.#drafts = options.drafts
    this.#overlays = options.overlays
    this.#nextOperationId = options.nextOperationId
    this.#dispatch = options.dispatch
    this.#isStopped = options.isStopped
    this.#stop = options.stop
    this.#showActivity = options.showActivity
  }

  submit(rawText: string): void {
    void this.#submitValue(rawText)
  }

  dispatchCommand(command: CommandName, args: readonly string[]): void {
    void this.#dispatchCommandValue(command, args)
  }

  async #submitValue(rawText: string): Promise<void> {
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
      this.#editor.addToHistory(rawText)
      this.#drafts.setText('')
      await this.#drafts.flush('')
      this.dispatchCommand(parsed.name, parsed.args)
      return
    }

    const view = this.#controller.view()
    const capability = view.activeRunId
      ? view.capabilities['run.queue']
      : view.capabilities['run.send']
    if (!capability?.available) {
      this.#editor.setText(rawText)
      this.#overlays.openUnavailable(
        view.activeRunId ? 'Queue unavailable' : 'Send unavailable',
        capability?.reason ?? 'The current connection cannot accept this message',
      )
      return
    }
    this.#editor.addToHistory(rawText)
    await this.#drafts.flush(rawText)
    this.#drafts.setText('')
    const operationId = this.#nextOperationId()
    const intent: BraidIntent = view.activeRunId
      ? { type: 'queue', operationId, text: parsed.text }
      : { type: 'send', operationId, text: parsed.text }
    void this.#dispatch(intent, rawText)
  }

  async #dispatchCommandValue(command: CommandName, args: readonly string[]): Promise<void> {
    if (command === 'profile' && args.length === 0) {
      this.#overlays.openProfile()
      return
    }
    if (command === 'connection' && args.length === 0) {
      this.#overlays.openConnection()
      return
    }
    if (command === 'connection' && args[0] === 'create') {
      this.#overlays.openConnectionEditor()
      return
    }
    if (command !== 'approve' && command !== 'reject') {
      const availability = commandAvailability(command, this.#controller.view().capabilities)
      if (!availability.available) {
        this.#overlays.openUnavailable(
          `/${command}`,
          availability.reason ?? 'Capability is unavailable',
        )
        return
      }
    }
    if (['new', 'open', 'branch', 'clone', 'fork'].includes(command)) await this.#drafts.flush()
    if (command === 'open') {
      this.#overlays.openConversationSelector(args.join(' ').trim())
      return
    }
    const operationId = isMutatingCommand(command) ? this.#nextOperationId() : undefined
    const intent = commandIntent(command, args, operationId)
    if (intent.type === 'open-surface') {
      if (intent.surface === 'activity') this.#showActivity()
      void this.#dispatch(intent).then((result) => {
        if (result.kind !== 'accepted' || this.#isStopped()) return
        if (intent.surface === 'help') this.#overlays.openHelp(intent.query ?? '')
        else this.#overlays.openSurface(intent.surface)
      })
      return
    }
    if (intent.type === 'shutdown') {
      void this.#dispatch(intent).then((result) => {
        if (result.kind === 'accepted') this.#stop()
      })
      return
    }
    void this.#dispatch(intent).then((result) => {
      if (result.kind !== 'accepted' || this.#isStopped()) return
      if (command === 'fork') this.#overlays.openSurface('fork')
      else if (command === 'ask' || command === 'analyze' || command === 'compare') {
        this.#overlays.openIntelligenceResult(command, result.data)
      }
    })
  }
}
