import type { BraidIntent, InteractionResponseValue, UiDispatchResult } from '../shared/intents.js'
import type { BraidViewModel, InteractionView } from '../shared/models.js'
import { InteractionShell } from './interaction.js'
import type { ModalCoordinator } from './modal-coordinator.js'
import type { BraidTheme } from './theme.js'

export interface TerminalInteractionControllerOptions {
  readonly theme: BraidTheme
  readonly modals: ModalCoordinator
  readonly nextOperationId: () => string
  readonly dispatch: (intent: BraidIntent) => Promise<UiDispatchResult>
  readonly currentView: () => BraidViewModel
  readonly isStopped: () => boolean
  readonly requestRender: () => void
  readonly rows: () => number
  readonly openAutomation: (input: {
    readonly interaction: InteractionView
    readonly proposedResponse: InteractionResponseValue
    readonly onClose: () => void
  }) => void
}

/** Owns pending-interaction presentation and replay after a failed response. */
export class TerminalInteractionController {
  readonly #theme: BraidTheme
  readonly #modals: ModalCoordinator
  readonly #nextOperationId: () => string
  readonly #dispatch: TerminalInteractionControllerOptions['dispatch']
  readonly #currentView: () => BraidViewModel
  readonly #isStopped: () => boolean
  readonly #requestRender: () => void
  readonly #rows: () => number
  readonly #openAutomation: TerminalInteractionControllerOptions['openAutomation']
  #open = false
  #interactionKey: string | undefined
  #pendingInteractionKey: string | undefined
  #shell: InteractionShell | undefined
  #refresh: ReturnType<typeof setInterval> | undefined

  constructor(options: TerminalInteractionControllerOptions) {
    this.#theme = options.theme
    this.#modals = options.modals
    this.#nextOperationId = options.nextOperationId
    this.#dispatch = options.dispatch
    this.#currentView = options.currentView
    this.#isStopped = options.isStopped
    this.#requestRender = options.requestRender
    this.#rows = options.rows
    this.#openAutomation = options.openAutomation
  }

  get isOpen(): boolean {
    return this.#open
  }

  sync(view: BraidViewModel): void {
    const interaction = view.interactions[0]
    const interactionKey = interaction ? keyFor(interaction) : undefined
    if (!interaction) {
      this.#pendingInteractionKey = undefined
      this.#stopRefresh()
      if (this.#open) {
        this.#open = false
        this.#interactionKey = undefined
        this.#shell = undefined
        this.#modals.closeTop()
      }
      return
    }
    if (this.#open && interactionKey === this.#interactionKey) {
      this.#shell?.setInteraction(interaction)
      this.#syncRefresh(interaction)
      return
    }
    if (
      interactionKey !== this.#pendingInteractionKey &&
      (!this.#open || interactionKey !== this.#interactionKey)
    ) {
      this.#openInteraction(interaction)
    }
  }

  #openInteraction(interaction: InteractionView): void {
    this.#open = true
    this.#interactionKey = keyFor(interaction)
    const shell = new InteractionShell(
      interaction,
      this.#theme,
      (response) => {
        this.#open = false
        this.#pendingInteractionKey = this.#interactionKey
        this.#interactionKey = undefined
        this.#shell = undefined
        this.#stopRefresh()
        this.#modals.closeTop()
        const pendingKey = this.#pendingInteractionKey
        void this.#dispatch({
          type: 'respond-interaction',
          operationId: this.#nextOperationId(),
          runId: interaction.runId,
          interactionId: interaction.interactionId,
          response,
        }).then((result) => {
          if (this.#isStopped()) return
          const current = this.#currentView().interactions[0]
          if (result.kind !== 'accepted' && current && keyFor(current) === pendingKey) {
            this.#pendingInteractionKey = undefined
            this.#openInteraction(current)
          }
        })
      },
      (proposedResponse) =>
        this.#openAutomation({
          interaction,
          proposedResponse,
          onClose: () => this.#resumeInteraction(interaction),
        }),
      this.#rows,
    )
    this.#shell = shell
    this.#modals.open(shell, {
      anchor: 'top-left',
      width: '100%',
      maxHeight: '100%',
      margin: 0,
      fullScreenBelow: Number.MAX_SAFE_INTEGER,
    })
    this.#syncRefresh(interaction)
  }

  #resumeInteraction(previous: InteractionView): void {
    if (this.#isStopped()) return
    this.#open = false
    this.#interactionKey = undefined
    this.#pendingInteractionKey = undefined
    this.#shell = undefined
    this.#stopRefresh()
    const current = this.#currentView().interactions[0]
    if (current !== undefined && keyFor(current) === keyFor(previous))
      this.#openInteraction(current)
  }

  dispose(): void {
    this.#stopRefresh()
    this.#shell = undefined
  }

  #syncRefresh(interaction: InteractionView): void {
    if (interaction.remainingMs === undefined || interaction.remainingMs <= 0) {
      this.#stopRefresh()
      return
    }
    if (this.#refresh !== undefined) return
    this.#refresh = setInterval(() => {
      if (this.#isStopped()) {
        this.#stopRefresh()
        return
      }
      this.sync(this.#currentView())
      this.#requestRender()
    }, 250)
    this.#refresh.unref?.()
  }

  #stopRefresh(): void {
    if (this.#refresh !== undefined) clearInterval(this.#refresh)
    this.#refresh = undefined
  }
}

function keyFor(interaction: InteractionView): string {
  return `${interaction.runId}:${interaction.interactionId}`
}
