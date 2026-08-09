import { type Component, Container, type Focusable, TruncatedText } from '@earendil-works/pi-tui'
import type { AutomationRuleScope } from '../../domain/entities-interactions.js'
import type { InteractionResponseValue } from '../shared/intents.js'
import type { InteractionView } from '../shared/models.js'
import type {
  AutomationRulePanelOptions,
  AutomationRuleSummary,
} from './automation-rule-presentation.js'
import {
  initialResponse,
  interactionSummary,
  offeredScopes,
  parseScope,
  ruleCreationReason,
  ruleItem,
  scopedResponse,
  scopeItem,
} from './automation-rule-presentation.js'
import { RuleResponseEditor } from './automation-rule-response-editor.js'
import { ConversationConfirmation } from './conversation-dialogs.js'
import { SearchableSelector } from './selector.js'
import type { BraidTheme } from './theme.js'

export type {
  AutomationRuleCreateIntent,
  AutomationRulePanelOptions,
  AutomationRuleSummary,
} from './automation-rule-presentation.js'

type PanelLayer = SearchableSelector | RuleResponseEditor | ConversationConfirmation

export class AutomationRulePanel extends Container implements Focusable {
  readonly #theme: BraidTheme
  readonly #onSelect: AutomationRulePanelOptions['onSelect']
  readonly #onCreate: AutomationRulePanelOptions['onCreate']
  readonly #onDisable: AutomationRulePanelOptions['onDisable']
  readonly #onDelete: AutomationRulePanelOptions['onDelete']
  readonly #onCancel: () => void
  #rules: readonly AutomationRuleSummary[]
  #interaction: InteractionView | undefined
  #proposedResponse: InteractionResponseValue | undefined
  #active: PanelLayer | undefined
  #focused = false
  #finished = false

  constructor(options: AutomationRulePanelOptions) {
    super()
    this.#theme = options.theme
    this.#rules = [...options.rules]
    this.#interaction = options.interaction
    this.#proposedResponse = options.proposedResponse
    this.#onSelect = options.onSelect
    this.#onCreate = options.onCreate
    this.#onDisable = options.onDisable
    this.#onDelete = options.onDelete
    this.#onCancel = options.onCancel
    this.#showRules(options.notice)
    if (options.startCreate) this.#beginCreate()
  }

  get focused(): boolean {
    return this.#focused
  }

  set focused(value: boolean) {
    this.#focused = value
    if (this.#active) this.#active.focused = value
  }

  handleInput(data: string): void {
    if (this.#finished) return
    this.#active?.handleInput(data)
  }

  #showRules(notice?: string): void {
    const before: Component[] = []
    const interaction = this.#interaction
    if (interaction !== undefined) {
      before.push(new TruncatedText(`current: ${interactionSummary(interaction)}`, 0, 0))
      const reason = notice ?? ruleCreationReason(interaction)
      if (reason !== undefined) before.push(new TruncatedText(this.#theme.warning(reason), 0, 0))
    } else if (notice !== undefined) {
      before.push(new TruncatedText(this.#theme.warning(notice), 0, 0))
    }

    const selector = new SearchableSelector({
      title: 'automation rules',
      items: this.#rules.map(ruleItem),
      theme: this.#theme,
      maxVisible: 3,
      emptyText: 'No saved automation rules',
      noMatchText: 'No matching automation rules',
      hideInputWhenEmpty: true,
      footer: this.#ruleListFooter(),
      onAction: (action, item) => {
        if (action === 'new') {
          this.#beginCreate()
          return
        }
        if ((action === 'archive' || action === 'delete') && item !== null) {
          const rule = this.#rules.find((candidate) => candidate.id === item.value)
          if (rule !== undefined)
            this.#showMutation(action === 'archive' ? 'disable' : 'delete', rule)
        }
      },
      onSelect: (item) => this.#onSelect?.(item.value),
      onCancel: () => this.#cancel(),
    })
    this.#setContent(before, selector)
  }

  #ruleListFooter(): string {
    const canCreate =
      this.#interaction !== undefined && ruleCreationReason(this.#interaction) === undefined
    if (this.#rules.length === 0 && !canCreate)
      return this.#interaction === undefined
        ? 'create from a pending request with Alt+A · esc close'
        : 'this request stays manual · esc close'
    return [
      'type to filter',
      ...(this.#onSelect === undefined ? [] : ['enter select']),
      ...(canCreate ? ['ctrl+n new'] : []),
      ...(this.#rules.length === 0 ? [] : ['ctrl+a off', 'ctrl+d del']),
      'esc close',
    ].join(' · ')
  }

  #beginCreate(): void {
    const interaction = this.#interaction
    if (interaction === undefined) {
      this.#showRules('create requires a current interaction')
      return
    }
    const reason = ruleCreationReason(interaction)
    if (reason !== undefined) {
      this.#showRules(reason)
      return
    }
    this.#showEditor(initialResponse(interaction, this.#proposedResponse))
  }

  #showEditor(proposedResponse: InteractionResponseValue): void {
    const interaction = this.#interaction
    if (interaction === undefined) return
    const editor = new RuleResponseEditor({
      interaction,
      proposedResponse,
      theme: this.#theme,
      onResponse: (response) => {
        this.#proposedResponse = response
        this.#showScope(response)
      },
      onCancel: () => this.#cancel(),
    })
    this.#setContent([], editor)
  }

  #showScope(response: InteractionResponseValue): void {
    const interaction = this.#interaction
    if (interaction === undefined) return
    const scopes = offeredScopes(interaction)
    if (scopes.length === 0) {
      this.#showRules('this interaction offers no reusable response scope')
      return
    }
    const selector = new SearchableSelector({
      title: 'rule scope',
      items: scopes.map(scopeItem),
      theme: this.#theme,
      maxVisible: 3,
      footer: 'type to filter · enter choose · esc back',
      onSelect: (item) => {
        const scope = parseScope(item.value)
        if (scope === undefined) return
        if (scope === 'persistent') {
          this.#showPersistentConfirmation(response)
          return
        }
        this.#emitCreate(response, scope, false)
      },
      onCancel: () => this.#showEditor(response),
    })
    this.#setContent([], selector)
  }

  #showPersistentConfirmation(response: InteractionResponseValue): void {
    const interaction = this.#interaction
    if (interaction === undefined) return
    const confirmation = new ConversationConfirmation({
      theme: this.#theme,
      title: 'save persistent rule?',
      target: interactionSummary(interaction),
      detail: 'future matching interactions will use this response',
      confirmLabel: 'save persistent rule',
      onConfirm: () => this.#emitCreate(response, 'persistent', true),
      onCancel: () => this.#showScope(response),
    })
    this.#setContent([], confirmation)
  }

  #showMutation(action: 'disable' | 'delete', rule: AutomationRuleSummary): void {
    const confirmation = new ConversationConfirmation({
      theme: this.#theme,
      title: `${action} automation rule?`,
      target: rule.id,
      detail:
        action === 'disable'
          ? 'matching responses will stop using this rule'
          : 'this rule and its future matches will be removed',
      confirmLabel: action,
      onConfirm: () => {
        if (action === 'disable') this.#onDisable?.(rule.id)
        else this.#onDelete?.(rule.id)
        this.#showRules()
      },
      onCancel: () => this.#showRules(),
    })
    this.#setContent([], confirmation)
  }

  #emitCreate(
    response: InteractionResponseValue,
    responseScope: AutomationRuleScope,
    confirmPersistent: boolean,
  ): void {
    const interaction = this.#interaction
    if (interaction === undefined || ruleCreationReason(interaction) !== undefined) return
    this.#finished = true
    this.#onCreate?.({
      interaction,
      response: scopedResponse(interaction, response, responseScope),
      responseScope,
      confirmPersistent,
    })
  }

  #cancel(): void {
    if (this.#finished) return
    this.#finished = true
    this.#onCancel()
  }

  #setContent(before: readonly Component[], active: PanelLayer): void {
    this.clear()
    for (const child of before) this.addChild(child)
    this.#active = active
    this.addChild(active)
    active.focused = this.#focused
  }
}
