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
  /** True while the composer holds an unsent draft or was typed into moments ago. */
  readonly composerBusy: () => boolean
  /** Shows or clears the status-line notice for an interaction held back from the composer. */
  readonly setDeferred: (notice: string | undefined) => void
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
  readonly #composerBusy: () => boolean
  readonly #setDeferred: (notice: string | undefined) => void
  readonly #openAutomation: TerminalInteractionControllerOptions['openAutomation']
  #open = false
  #interactionKey: string | undefined
  #pendingInteractionKey: string | undefined
  #shell: InteractionShell | undefined
  #refresh: ReturnType<typeof setInterval> | undefined
  #deferredKey: string | undefined
  #recheck: ReturnType<typeof setTimeout> | undefined
  /** A form another overlay closed; it waits behind Alt+P instead of taking that overlay back. */
  #dismissedKey: string | undefined

  constructor(options: TerminalInteractionControllerOptions) {
    this.#theme = options.theme
    this.#modals = options.modals
    this.#nextOperationId = options.nextOperationId
    this.#dispatch = options.dispatch
    this.#currentView = options.currentView
    this.#isStopped = options.isStopped
    this.#requestRender = options.requestRender
    this.#rows = options.rows
    this.#composerBusy = options.composerBusy
    this.#setDeferred = options.setDeferred
    this.#openAutomation = options.openAutomation
  }

  get isOpen(): boolean {
    return this.#open
  }

  sync(view: BraidViewModel): void {
    const interaction = focused(view)
    const interactionKey = interaction ? keyFor(interaction) : undefined
    if (!interaction) {
      this.#clearDeferred()
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
      // LIVE-07 lost 547 typed characters to a form that opened mid-prompt: a request that arrives
      // while the user is composing waits in the status line until they ask for it or go idle.
      // A request from another conversation waits too; it took branch B's prompt right after /new.
      const held = foreign(view, interaction) || interactionKey === this.#dismissedKey
      if (this.#composerBusy() || held) this.#defer(interaction, !held)
      else this.#openInteraction(interaction)
    }
  }

  /** Opens the interaction held back from the composer; false when none is waiting. */
  openDeferred(): boolean {
    const interaction = focused(this.#currentView())
    if (this.#open || this.#deferredKey === undefined || interaction === undefined) return false
    this.#openInteraction(interaction)
    return true
  }

  /** Rechecks while the composer is busy; a switch back to the request's conversation re-syncs. */
  #defer(interaction: InteractionView, recheck: boolean): void {
    const notice = `${interaction.kind} waiting · alt+p`
    if (this.#deferredKey !== keyFor(interaction)) {
      this.#deferredKey = keyFor(interaction)
      this.#setDeferred(notice)
    }
    if (!recheck || this.#recheck !== undefined) return
    this.#recheck = setTimeout(() => {
      this.#recheck = undefined
      if (this.#isStopped()) return
      this.sync(this.#currentView())
      this.#requestRender()
    }, 250)
    this.#recheck.unref?.()
  }

  #clearDeferred(): void {
    if (this.#recheck !== undefined) clearTimeout(this.#recheck)
    this.#recheck = undefined
    if (this.#deferredKey === undefined) return
    this.#deferredKey = undefined
    this.#setDeferred(undefined)
  }

  #openInteraction(interaction: InteractionView): void {
    this.#clearDeferred()
    this.#dismissedKey = undefined
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
          const current = focused(this.#currentView())
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
      // LIVE-07 opened the activity browser over B's form; the form vanished unanswered and unlisted.
      onClose: () => {
        if (this.#shell !== shell) return
        this.#open = false
        this.#interactionKey = undefined
        this.#shell = undefined
        this.#stopRefresh()
        this.#dismissedKey = keyFor(interaction)
        this.sync(this.#currentView())
      },
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
    const current = focused(this.#currentView())
    if (current !== undefined && keyFor(current) === keyFor(previous))
      this.#openInteraction(current)
  }

  dispose(): void {
    this.#clearDeferred()
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

/** A request for the conversation on screen comes first; another conversation's waits. */
function focused(view: BraidViewModel): InteractionView | undefined {
  return (
    view.interactions.find((interaction) => !foreign(view, interaction)) ?? view.interactions[0]
  )
}

function foreign(view: BraidViewModel, interaction: InteractionView): boolean {
  const owner = view.runs.find((run) => run.id === interaction.runId)?.conversationId
  return owner !== undefined && owner !== view.conversationId
}
