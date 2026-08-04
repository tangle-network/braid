import type { BraidUiController } from '../shared/intents.js'
import { ConversationOverlayActions } from './conversation-overlay-actions.js'
import { branchItems, conversationItems } from './conversation-overlay-helpers.js'
import type { ModalCoordinator } from './modal-coordinator.js'
import { SearchableSelector } from './selector.js'
import type { BraidTheme } from './theme.js'

export interface ConversationOverlayOptions {
  readonly theme: BraidTheme
  readonly controller: BraidUiController
  readonly modals: ModalCoordinator
  readonly nextOperationId: () => string
}

export class ConversationOverlayController {
  readonly #controller: BraidUiController
  readonly #modals: ModalCoordinator
  readonly #actions: ConversationOverlayActions

  constructor(options: ConversationOverlayOptions) {
    this.#controller = options.controller
    this.#modals = options.modals
    this.#actions = new ConversationOverlayActions(options)
  }

  openConversationSelector(query = ''): void {
    const view = this.#controller.view()
    let selector: SearchableSelector
    selector = new SearchableSelector({
      title: 'conversations',
      query,
      items: conversationItems(view),
      theme: this.#actions.theme,
      maxVisible: 8,
      footer:
        'type to filter · enter to choose · esc to close · ^R rename · ^A archive · ^D delete',
      onSelect: (item) => void this.#actions.openConversation(selector, item.value),
      onAction: (key, item) => this.#actions.conversationAction(selector, key, item?.value),
      onCancel: () => this.#modals.closeTop(),
    })
    this.#modals.open(selector, { anchor: 'center', width: '92%', minWidth: 32, maxHeight: '90%' })
  }

  openBranchSelector(): void {
    const view = this.#controller.view()
    const items = branchItems(view)
    if (items.length === 0) {
      this.#actions.showUnavailable('branches', 'No branches are available in this conversation')
      return
    }
    let selector: SearchableSelector
    selector = new SearchableSelector({
      title: 'branches',
      items,
      theme: this.#actions.theme,
      maxVisible: 8,
      footer: 'filter · enter switch branch · esc close',
      onSelect: (item) => void this.#actions.openBranch(selector, item.value),
      onCancel: () => this.#modals.closeTop(),
    })
    this.#modals.open(selector, { anchor: 'center', width: '86%', minWidth: 32, maxHeight: '90%' })
  }

  openAdjacentBranch(direction: -1 | 1): void {
    const view = this.#controller.view()
    const items = branchItems(view)
    const current = items.findIndex((item) => item.value === view.branch)
    const next = current < 0 ? undefined : items[current + direction]
    if (next === undefined) {
      this.openBranchSelector()
      return
    }
    void this.#actions.openBranch(undefined, next.value)
  }

  openForkPreview(): void {
    this.#actions.openForkPreview(this.#controller.view())
  }
}
