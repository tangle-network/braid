import type { HeadlessCommandName } from '../shared/headless-commands.js'
import type { BraidUiController, UiDispatchResult } from '../shared/intents.js'
import type { BraidViewModel } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import { ConversationConfirmation, ConversationRename } from './conversation-dialogs.js'
import {
  type ConversationItem,
  findConversation,
  resultMessage,
  unique,
} from './conversation-overlay-helpers.js'
import { ForkPreviewPanel } from './fork-preview.js'
import type { ModalCoordinator } from './modal-coordinator.js'
import type { SearchableSelector } from './selector.js'
import { UnavailablePanel } from './terminal-shell.js'
import type { BraidTheme } from './theme.js'

export interface ConversationOverlayActionOptions {
  readonly theme: BraidTheme
  readonly controller: BraidUiController
  readonly modals: ModalCoordinator
  readonly nextOperationId: () => string
  readonly rows: () => number
}

export class ConversationOverlayActions {
  readonly #theme: BraidTheme
  readonly #controller: BraidUiController
  readonly #modals: ModalCoordinator
  readonly #nextOperationId: () => string
  readonly #rows: () => number

  constructor(options: ConversationOverlayActionOptions) {
    this.#theme = options.theme
    this.#controller = options.controller
    this.#modals = options.modals
    this.#nextOperationId = options.nextOperationId
    this.#rows = options.rows
  }

  conversationAction(
    selector: SearchableSelector,
    action: string,
    conversationId: string | undefined,
  ): void {
    if (conversationId === undefined) {
      selector.setFooter('select a conversation first · esc close')
      return
    }
    const conversation = this.#conversation(conversationId)
    if (conversation === undefined) {
      selector.setFooter('selected conversation disappeared · refresh with esc and ctrl+o')
      return
    }
    if (action === 'rename') this.#openRename(selector, conversation)
    else if (action === 'archive') this.#openArchive(selector, conversation)
    else if (action === 'delete') this.#openDelete(selector, conversation)
  }

  async openConversation(selector: SearchableSelector, conversationId: string): Promise<void> {
    const conversation = this.#conversation(conversationId)
    if (conversation === undefined) {
      selector.setFooter('conversation is no longer available · esc close')
      return
    }
    selector.setFooter('opening conversation…')
    const result = await this.#headless('open_conversation', {
      conversationId: conversation.id,
      branchId: conversation.branchId,
    })
    if (result.kind === 'accepted') this.#modals.closeTop()
    else {
      selector.setFooter('open failed · query and selection preserved · esc close')
      this.#showResultError('Open failed', result, false)
    }
  }

  async openBranch(selector: SearchableSelector | undefined, branchId: string): Promise<void> {
    const result = await this.#headless('open_conversation', {
      conversationId: this.#controller.view().conversationId,
      branchId,
    })
    if (result.kind === 'accepted') {
      if (selector !== undefined) this.#modals.closeTop()
    } else this.#showResultError('Branch switch failed', result, selector === undefined)
  }

  openForkPreview(view: BraidViewModel): void {
    let panel: ForkPreviewPanel
    panel = new ForkPreviewPanel(this.#theme, {
      onConfirm: () => void this.#executeFork(panel, view),
      onCancel: () => this.#modals.closeTop(),
      rows: this.#rows,
    })
    panel.setView(view)
    this.#modals.open(panel, {
      anchor: 'top-left',
      width: '100%',
      maxHeight: '100%',
      margin: 0,
    })
  }

  get theme(): BraidTheme {
    return this.#theme
  }

  #openRename(selector: SearchableSelector, conversation: ConversationItem): void {
    let dialog: ConversationRename
    dialog = new ConversationRename({
      theme: this.#theme,
      currentTitle: conversation.title,
      onSubmit: (title) => void this.#rename(selector, dialog, conversation, title),
      onCancel: () => this.#modals.closeTop(),
    })
    this.#modals.open(
      dialog,
      { anchor: 'center', width: '80%', minWidth: 32, maxHeight: 12 },
      false,
    )
  }

  async #rename(
    selector: SearchableSelector,
    dialog: ConversationRename,
    conversation: ConversationItem,
    title: string,
  ): Promise<void> {
    const result = await this.#headless('rename_conversation', {
      conversationId: conversation.id,
      title,
    })
    if (result.kind === 'accepted') {
      this.#closeConversationFlow(selector)
      return
    }
    dialog.setError(resultMessage(result, 'Rename failed'))
  }

  #openArchive(selector: SearchableSelector, conversation: ConversationItem): void {
    const archived = !conversation.archived
    let dialog: ConversationConfirmation
    dialog = new ConversationConfirmation({
      theme: this.#theme,
      title: archived ? 'archive conversation' : 'restore conversation',
      target: conversation.title,
      detail: archived
        ? 'Runs remain untouched. The conversation will stay available through the archived filter.'
        : 'The conversation will return to the active list.',
      confirmLabel: archived ? 'archive' : 'restore',
      onConfirm: () => void this.#archive(selector, dialog, conversation, archived),
      onCancel: () => this.#modals.closeTop(),
    })
    this.#modals.open(
      dialog,
      { anchor: 'center', width: '84%', minWidth: 32, maxHeight: 12 },
      false,
    )
  }

  async #archive(
    selector: SearchableSelector,
    dialog: ConversationConfirmation,
    conversation: ConversationItem,
    archived: boolean,
  ): Promise<void> {
    const result = await this.#headless('archive_conversation', {
      conversationId: conversation.id,
      archived,
    })
    if (result.kind === 'accepted') {
      this.#closeConversationFlow(selector)
      return
    }
    dialog.setError(resultMessage(result, archived ? 'Archive failed' : 'Restore failed'))
  }

  #openDelete(selector: SearchableSelector, conversation: ConversationItem): void {
    const environments = unique(
      this.#controller
        .view()
        .runs.map((run) => run.environmentId)
        .filter((value): value is string => value !== undefined),
    )
    const detail =
      environments.length === 0
        ? 'This removes the local conversation history. No external environment reference is visible here.'
        : `External environment references remain: ${environments.join(', ')}`
    let dialog: ConversationConfirmation
    dialog = new ConversationConfirmation({
      theme: this.#theme,
      title: 'delete conversation',
      target: conversation.title,
      detail,
      confirmLabel: 'delete permanently',
      onConfirm: () => void this.#delete(selector, dialog, conversation),
      onCancel: () => this.#modals.closeTop(),
    })
    this.#modals.open(
      dialog,
      { anchor: 'center', width: '88%', minWidth: 32, maxHeight: 12 },
      false,
    )
  }

  async #delete(
    selector: SearchableSelector,
    dialog: ConversationConfirmation,
    conversation: ConversationItem,
  ): Promise<void> {
    const result = await this.#headless('delete_conversation', {
      conversationId: conversation.id,
    })
    if (result.kind === 'accepted') {
      this.#closeConversationFlow(selector)
      return
    }
    dialog.setError(resultMessage(result, 'Delete failed'))
  }

  async #executeFork(panel: ForkPreviewPanel, view: BraidViewModel): Promise<void> {
    const preview = view.forkPreview
    const plan = preview?.plan
    if (!preview?.allowed || plan === undefined || !plan.allowed) {
      panel.setError('The fork plan is not executable; create a fresh preview')
      return
    }
    const result = await this.#controller.dispatch({
      type: 'headless-command',
      command: 'execute_fork',
      operationId: plan.operationId,
      params: {
        planDigest: plan.digest,
        conversationId: plan.sourceConversationId,
        branchId: plan.sourceBranchId,
        ...(plan.throughMessageId === undefined ? {} : { messageId: plan.throughMessageId }),
        workspace: plan.kind === 'workspace',
        ...(plan.context.destinationRunner === undefined
          ? {}
          : { runner: plan.context.destinationRunner }),
      },
    })
    if (result.kind === 'accepted') this.#modals.closeTop()
    else panel.setError(resultMessage(result, 'Fork failed; review the plan and retry'))
  }

  #closeConversationFlow(selector: SearchableSelector): void {
    this.#modals.closeTop()
    if (this.#modals.hasOpen()) this.#modals.closeTop()
    selector.setFooter('conversation list updated')
  }

  #conversation(conversationId: string): ConversationItem | undefined {
    return findConversation(this.#controller.view(), conversationId)
  }

  #headless(
    command: HeadlessCommandName,
    params: Readonly<Record<string, unknown>>,
  ): Promise<UiDispatchResult> {
    return this.#controller.dispatch({
      type: 'headless-command',
      command,
      operationId: this.#nextOperationId(),
      params,
    })
  }

  #showResultError(title: string, result: UiDispatchResult, preempt: boolean): void {
    this.showUnavailable(title, resultMessage(result, 'The operation failed'), preempt)
  }

  showUnavailable(title: string, reason: string, preempt = true): void {
    this.#modals.open(
      new UnavailablePanel(this.#theme, sanitizeTerminalText(title), sanitizeTerminalText(reason)),
      { anchor: 'center', width: '82%', maxHeight: 8 },
      preempt,
    )
  }
}
