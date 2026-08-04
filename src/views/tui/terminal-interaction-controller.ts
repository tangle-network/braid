import type { BraidIntent, UiDispatchResult } from '../shared/intents.js'
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
}

/** Owns pending-interaction presentation and replay after a failed response. */
export class TerminalInteractionController {
  readonly #theme: BraidTheme
  readonly #modals: ModalCoordinator
  readonly #nextOperationId: () => string
  readonly #dispatch: TerminalInteractionControllerOptions['dispatch']
  readonly #currentView: () => BraidViewModel
  readonly #isStopped: () => boolean
  #open = false
  #interactionKey: string | undefined
  #pendingInteractionKey: string | undefined

  constructor(options: TerminalInteractionControllerOptions) {
    this.#theme = options.theme
    this.#modals = options.modals
    this.#nextOperationId = options.nextOperationId
    this.#dispatch = options.dispatch
    this.#currentView = options.currentView
    this.#isStopped = options.isStopped
  }

  get isOpen(): boolean {
    return this.#open
  }

  sync(view: BraidViewModel): void {
    const interaction = view.interactions[0]
    const interactionKey = interaction ? keyFor(interaction) : undefined
    if (!interaction) {
      this.#pendingInteractionKey = undefined
      if (this.#open) {
        this.#open = false
        this.#interactionKey = undefined
        this.#modals.closeTop()
      }
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
    const shell = new InteractionShell(interaction, this.#theme, (response) => {
      this.#open = false
      this.#pendingInteractionKey = this.#interactionKey
      this.#interactionKey = undefined
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
    })
    this.#modals.open(shell, { anchor: 'center', width: '90%', maxHeight: '90%' })
  }
}

function keyFor(interaction: InteractionView): string {
  return `${interaction.runId}:${interaction.interactionId}`
}
