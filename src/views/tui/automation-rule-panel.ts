import {
  type Component,
  Container,
  type Focusable,
  Input,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
  TruncatedText,
} from '@earendil-works/pi-tui'
import type {
  AutomationRuleScope,
  NonSecretInteractionData,
  NonSecretInteractionValue,
} from '../../domain/entities-interactions.js'
import type { AutomationRuleMatcher } from '../../domain/entities-runtime.js'
import type { InteractionResponseValue } from '../shared/intents.js'
import type { AnswerSpecView, InteractionView } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import { ConversationConfirmation } from './conversation-dialogs.js'
import { isSecretInteraction } from './interaction-presentation.js'
import { SearchableSelector } from './selector.js'
import type { BraidTheme } from './theme.js'

export interface AutomationRuleSummary {
  readonly id: string
  readonly enabled: boolean
  readonly responseScope: AutomationRuleScope
  readonly uses: number
  readonly maximumUses?: number
  readonly matcher?: AutomationRuleMatcher
  readonly answer?: NonSecretInteractionData
}

export interface AutomationRuleCreateIntent {
  readonly interaction: InteractionView
  readonly response: InteractionResponseValue
  readonly responseScope: AutomationRuleScope
  readonly confirmPersistent: boolean
}

export interface AutomationRulePanelOptions {
  readonly theme: BraidTheme
  readonly rules: readonly AutomationRuleSummary[]
  readonly interaction?: InteractionView
  readonly proposedResponse?: InteractionResponseValue
  readonly onSelect?: (ruleId: string) => void
  readonly onCreate?: (intent: AutomationRuleCreateIntent) => void
  readonly onDisable?: (ruleId: string) => void
  readonly onDelete?: (ruleId: string) => void
  readonly onCancel: () => void
}

type PanelLayer = SearchableSelector | RuleResponseEditor | ConversationConfirmation
type ResponseValue = string | number | boolean
type ResponseDataValue = string | number | boolean | readonly string[]

const AUTOMATION_SCOPES: readonly AutomationRuleScope[] = ['once', 'session', 'persistent']

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
    this.#showRules()
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
      footer: 'enter select · ctrl+n new · ctrl+a off · ctrl+d del · esc close',
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
      onSelect: (item) => {
        this.#onSelect?.(item.value)
      },
      onCancel: () => this.#cancel(),
    })
    this.#setContent(before, selector)
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
      response: safeResponse(response),
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

interface RuleResponseEditorOptions {
  readonly interaction: InteractionView
  readonly proposedResponse: InteractionResponseValue
  readonly theme: BraidTheme
  readonly onResponse: (response: InteractionResponseValue) => void
  readonly onCancel: () => void
}

class RuleResponseEditor extends Container implements Focusable {
  readonly #interaction: InteractionView
  readonly #theme: BraidTheme
  readonly #onResponse: (response: InteractionResponseValue) => void
  readonly #onCancel: () => void
  readonly #outcome: string
  readonly #error = new Text('', 0, 0)
  #input: Input | undefined
  #choices: SelectList | undefined
  #focused = false
  #formIndex = 0
  #formValues: Record<string, ResponseDataValue> = {}

  constructor(options: RuleResponseEditorOptions) {
    super()
    this.#interaction = options.interaction
    this.#theme = options.theme
    this.#onResponse = options.onResponse
    this.#onCancel = options.onCancel
    this.#outcome = positiveOutcome(options.interaction, options.proposedResponse)
    if (options.interaction.answerSpec.kind === 'form') {
      this.#formValues = initialFormValues(options.interaction.answerSpec, options.proposedResponse)
      this.#buildFormField()
    } else {
      this.#buildSingle(options.interaction.answerSpec, options.proposedResponse)
    }
  }

  get focused(): boolean {
    return this.#focused
  }

  set focused(value: boolean) {
    this.#focused = value
    if (this.#input) this.#input.focused = value
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.#onCancel()
      return
    }
    if (this.#input !== undefined) {
      this.#input.handleInput(data)
      return
    }
    this.#choices?.handleInput(data)
  }

  #buildSingle(
    spec: Exclude<AnswerSpecView, { readonly kind: 'form' }>,
    response: InteractionResponseValue,
  ): void {
    this.clear()
    this.#input = undefined
    this.#choices = undefined
    this.#addHeader()
    switch (spec.kind) {
      case 'text': {
        const input = new Input()
        const value = responseValue(response)
        input.setValue(typeof value === 'string' ? value : '')
        input.onSubmit = (value) => this.#submitText(value, spec.required, spec.maxLength)
        input.onEscape = () => this.#onCancel()
        this.#input = input
        this.addChild(new TruncatedText('response', 0, 0))
        this.addChild(input)
        break
      }
      case 'number': {
        const input = new Input()
        const value = responseValue(response)
        input.setValue(typeof value === 'number' ? String(value) : '')
        input.onSubmit = (value) =>
          this.#submitNumber(value, spec.required, spec.minimum, spec.maximum)
        input.onEscape = () => this.#onCancel()
        this.#input = input
        this.addChild(new TruncatedText('response · number', 0, 0))
        this.addChild(input)
        break
      }
      case 'boolean': {
        const proposedValue = responseValue(response)
        const value =
          typeof proposedValue === 'boolean' ? proposedValue : (spec.defaultValue ?? true)
        this.#choices = this.#choiceList(
          [
            { value: 'true', label: 'yes' },
            { value: 'false', label: 'no' },
          ],
          String(value),
          (item) => this.#finishResponse({ value: item.value === 'true' }),
        )
        this.addChild(new TruncatedText('response · choose', 0, 0))
        this.addChild(this.#choices)
        break
      }
      case 'select': {
        const proposedValue = responseValue(response)
        const value =
          typeof proposedValue === 'string'
            ? proposedValue
            : sanitizeTerminalText(spec.options[0]?.value ?? '')
        const items = spec.options.map((option) => ({
          value: sanitizeTerminalText(option.value),
          label: sanitizeTerminalText(option.label),
        }))
        this.#choices = this.#choiceList(items, value, (item) =>
          this.#finishResponse({ value: item.value }),
        )
        this.addChild(new TruncatedText('response · choose', 0, 0))
        this.addChild(this.#choices)
        break
      }
      case 'secret':
      case 'unknown':
        this.addChild(new TruncatedText(this.#theme.warning('manual response only'), 0, 0))
        break
    }
    this.#addFooter()
    if (this.#input) this.#input.focused = this.#focused
  }

  #buildFormField(): void {
    const spec = this.#interaction.answerSpec
    if (spec.kind !== 'form') return
    const field = spec.fields[this.#formIndex]
    this.clear()
    this.#input = undefined
    this.#choices = undefined
    this.#addHeader()
    if (field === undefined) {
      this.#finishResponse({ data: this.#formValues })
      return
    }
    this.addChild(
      new TruncatedText(
        `field ${this.#formIndex + 1}/${spec.fields.length} · ${sanitizeTerminalText(field.label)}`,
        0,
        0,
      ),
    )
    const current = this.#formValues[field.name]
    switch (field.type) {
      case 'text': {
        const input = new Input()
        input.setValue(typeof current === 'string' ? current : '')
        input.onSubmit = (value) => this.#submitFormText(value, field.name, field.required)
        input.onEscape = () => this.#onCancel()
        this.#input = input
        this.addChild(input)
        break
      }
      case 'number': {
        const input = new Input()
        input.setValue(typeof current === 'number' ? String(current) : '')
        input.onSubmit = (value) =>
          this.#submitFormNumber(value, field.name, field.required, field.minimum, field.maximum)
        input.onEscape = () => this.#onCancel()
        this.#input = input
        this.addChild(input)
        break
      }
      case 'boolean': {
        const value = typeof current === 'boolean' ? current : false
        this.#choices = this.#choiceList(
          [
            { value: 'true', label: 'yes' },
            { value: 'false', label: 'no' },
          ],
          String(value),
          (item) => this.#commitForm(field.name, item.value === 'true', field.required),
        )
        this.addChild(this.#choices)
        break
      }
      case 'select': {
        const currentValue = Array.isArray(current) ? current[0] : undefined
        const items = (field.options ?? []).map((option) => ({
          value: sanitizeTerminalText(option.value),
          label: sanitizeTerminalText(option.label),
        }))
        this.#choices = this.#choiceList(items, currentValue ?? items[0]?.value, (item) =>
          this.#commitForm(field.name, [item.value], field.required),
        )
        this.addChild(this.#choices)
        break
      }
      case 'secret':
        this.addChild(new TruncatedText(this.#theme.warning('manual response only'), 0, 0))
        break
    }
    this.#addFooter(true)
    if (this.#input) this.#input.focused = this.#focused
  }

  #choiceList(
    items: readonly SelectItem[],
    selectedValue: string | undefined,
    onSelect: (item: SelectItem) => void,
  ): SelectList {
    const list = new SelectList(
      [...items],
      Math.min(4, Math.max(1, items.length)),
      this.#theme.select,
    )
    const selectedIndex = items.findIndex((item) => item.value === selectedValue)
    if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex)
    list.onSelect = onSelect
    list.onCancel = () => this.#onCancel()
    return list
  }

  #submitText(value: string, required: boolean, maxLength: number | undefined): void {
    const safe = sanitizeTerminalText(value)
    if (required && safe.length === 0) {
      this.#setError('a response is required')
      return
    }
    if (maxLength !== undefined && [...safe].length > maxLength) {
      this.#setError(`response is limited to ${maxLength} characters`)
      return
    }
    this.#finishResponse({ value: safe })
  }

  #submitNumber(
    value: string,
    required: boolean,
    minimum: number | undefined,
    maximum: number | undefined,
  ): void {
    const safe = sanitizeTerminalText(value).trim()
    if (safe.length === 0 && !required) {
      this.#finishResponse({})
      return
    }
    const number = Number(safe)
    if (
      !Number.isFinite(number) ||
      (minimum !== undefined && number < minimum) ||
      (maximum !== undefined && number > maximum)
    ) {
      this.#setError('enter a number in the allowed range')
      return
    }
    this.#finishResponse({ value: number })
  }

  #submitFormText(value: string, name: string, required: boolean): void {
    const safe = sanitizeTerminalText(value)
    if (required && safe.length === 0) {
      this.#setError('a response is required')
      return
    }
    this.#commitForm(name, safe, required)
  }

  #submitFormNumber(
    value: string,
    name: string,
    required: boolean,
    minimum: number | undefined,
    maximum: number | undefined,
  ): void {
    const safe = sanitizeTerminalText(value).trim()
    if (safe.length === 0 && !required) {
      this.#commitForm(name, '', required)
      return
    }
    const number = Number(safe)
    if (
      !Number.isFinite(number) ||
      (minimum !== undefined && number < minimum) ||
      (maximum !== undefined && number > maximum)
    ) {
      this.#setError('enter a number in the allowed range')
      return
    }
    this.#commitForm(name, number, required)
  }

  #commitForm(name: string, value: ResponseDataValue, required: boolean): void {
    if (required && (value === '' || (Array.isArray(value) && value.length === 0))) {
      this.#setError('a response is required')
      return
    }
    this.#formValues[sanitizeTerminalText(name)] = value
    const spec = this.#interaction.answerSpec
    if (spec.kind !== 'form') return
    if (this.#formIndex + 1 >= spec.fields.length) {
      this.#finishResponse({ data: this.#formValues })
      return
    }
    this.#formIndex += 1
    this.#buildFormField()
  }

  #finishResponse(response: {
    readonly value?: ResponseValue
    readonly data?: NonSecretInteractionData
  }): void {
    this.#onResponse(
      safeResponse({
        outcome: this.#outcome,
        ...(response.value === undefined ? {} : { value: response.value }),
        ...(response.data === undefined ? {} : { data: response.data }),
      }),
    )
  }

  #addHeader(): void {
    this.addChild(new TruncatedText(this.#theme.brand('new automation rule'), 0, 0))
    this.addChild(new TruncatedText(`on: ${interactionSummary(this.#interaction)}`, 0, 0))
  }

  #addFooter(form = false): void {
    this.addChild(this.#error)
    this.addChild(
      new TruncatedText(form ? 'enter next · esc cancel' : 'enter continue · esc cancel', 0, 0),
    )
  }

  #setError(message: string): void {
    this.#error.setText(this.#theme.danger(sanitizeTerminalText(message)))
    this.invalidate()
  }
}

function ruleItem(rule: AutomationRuleSummary): SelectItem {
  const status = rule.enabled ? 'on' : 'off'
  const uses = `${rule.uses}${rule.maximumUses === undefined ? '' : `/${rule.maximumUses}`}`
  const scope = sanitizeTerminalText(rule.responseScope)
  const id = sanitizeTerminalText(rule.id)
  return {
    value: rule.id,
    label: `${status} ${id} · ${scope} · ${uses}`,
    description: [ruleSummaryAnswer(rule.answer), ruleSummaryMatcher(rule.matcher)]
      .filter((value) => value.length > 0)
      .join(' · '),
  }
}

function scopeItem(scope: AutomationRuleScope): SelectItem {
  return {
    value: scope,
    label: scope,
    description:
      scope === 'once'
        ? 'this interaction only'
        : scope === 'session'
          ? 'this provider session'
          : 'future matching interactions',
  }
}

function ruleSummaryAnswer(answer: NonSecretInteractionData | undefined): string {
  if (answer === undefined) return 'answer unavailable'
  return Object.entries(answer)
    .map(([key, value]) => `${sanitizeTerminalText(key)}=${summaryValue(value)}`)
    .join(', ')
}

function ruleSummaryMatcher(matcher: AutomationRuleMatcher | undefined): string {
  if (matcher === undefined) return 'match: interaction'
  const values = [
    matcher.interactionKind === undefined ? '' : `kind ${matcher.interactionKind}`,
    matcher.subjectType === undefined ? '' : `subject ${matcher.subjectType}`,
    matcher.subjectValue === undefined ? '' : matcher.subjectValue,
    matcher.runner === undefined ? '' : `runner ${matcher.runner}`,
    matcher.connectionId === undefined ? '' : `connection ${matcher.connectionId}`,
    matcher.workspaceId === undefined ? '' : `workspace ${matcher.workspaceId}`,
  ]
    .filter((value) => value.length > 0)
    .map(sanitizeTerminalText)
  return values.length === 0 ? 'match: interaction' : `match: ${values.join(' · ')}`
}

function summaryValue(value: NonSecretInteractionValue): string {
  if (Array.isArray(value)) return value.map(sanitizeTerminalText).join(',')
  return sanitizeTerminalText(String(value))
}

function interactionSummary(interaction: InteractionView): string {
  const kind = sanitizeTerminalText(interaction.kind) || 'interaction'
  const prompt = sanitizeTerminalText(interaction.prompt).replace(/[\r\n]+/gu, ' ')
  return prompt.length === 0 ? kind : `${kind} · ${prompt}`
}

function ruleCreationReason(interaction: InteractionView): string | undefined {
  if (containsSecret(interaction)) return 'manual only · secret responses are never automated'
  if (!interaction.allowedOutcomes.some(isPositiveOutcome))
    return 'manual only · no accepted response is available'
  if (offeredScopes(interaction).length === 0)
    return 'manual only · this interaction offers no reusable response scope'
  if (!supportsResponse(interaction.answerSpec))
    return 'manual only · this response shape is not supported'
  return undefined
}

function containsSecret(interaction: InteractionView): boolean {
  if (isSecretInteraction(interaction)) return true
  const spec = interaction.answerSpec
  return spec.kind === 'form' && spec.fields.some((field) => field.type === 'secret')
}

function supportsResponse(spec: AnswerSpecView): boolean {
  if (spec.kind === 'unknown' || spec.kind === 'secret') return false
  if (spec.kind === 'select') return spec.options.length > 0
  if (spec.kind !== 'form') return true
  return spec.fields.length > 0 && spec.fields.every((field) => field.type !== 'secret')
}

function isPositiveOutcome(outcome: string): boolean {
  return ['accept', 'once', 'session', 'persistent'].includes(outcome)
}

function positiveOutcome(interaction: InteractionView, response: InteractionResponseValue): string {
  return isPositiveOutcome(response.outcome)
    ? response.outcome
    : (interaction.allowedOutcomes.find(isPositiveOutcome) ?? 'accept')
}

function offeredScopes(interaction: InteractionView): readonly AutomationRuleScope[] {
  const explicit = new Set(interaction.allowedOutcomes.filter(isScope))
  if (explicit.size > 0) return AUTOMATION_SCOPES.filter((scope) => explicit.has(scope))
  return interaction.allowedOutcomes.some(isPositiveOutcome) ? ['once'] : []
}

function isScope(value: string): value is AutomationRuleScope {
  return AUTOMATION_SCOPES.includes(value as AutomationRuleScope)
}

function parseScope(value: string): AutomationRuleScope | undefined {
  return isScope(value) ? value : undefined
}

function initialResponse(
  interaction: InteractionView,
  proposed: InteractionResponseValue | undefined,
): InteractionResponseValue {
  const outcome = positiveOutcome(
    interaction,
    proposed ?? { outcome: interaction.allowedOutcomes.find(isPositiveOutcome) ?? 'accept' },
  )
  if (proposed !== undefined && isPositiveOutcome(proposed.outcome)) return safeResponse(proposed)
  const spec = interaction.answerSpec
  if (spec.kind === 'boolean') return { outcome, value: spec.defaultValue ?? true }
  if (spec.kind === 'select')
    return { outcome, value: sanitizeTerminalText(spec.options[0]?.value ?? '') }
  if (spec.kind === 'form') return { outcome, data: {} }
  return { outcome }
}

function initialFormValues(
  spec: Extract<AnswerSpecView, { readonly kind: 'form' }>,
  response: InteractionResponseValue,
): Record<string, ResponseDataValue> {
  const values: Record<string, ResponseDataValue> = {}
  for (const field of spec.fields) {
    const value = response.data?.[field.name]
    if (value !== undefined) values[sanitizeTerminalText(field.name)] = cloneValue(value)
  }
  return values
}

function cloneValue(value: ResponseDataValue): ResponseDataValue {
  return Array.isArray(value) ? value.map(sanitizeTerminalText) : value
}

function safeResponse(response: InteractionResponseValue): InteractionResponseValue {
  const data = response.data
  const safeData: Record<string, ResponseDataValue> = {}
  if (data !== undefined) {
    for (const [key, value] of Object.entries(data)) {
      safeData[sanitizeTerminalText(key)] = cloneValue(value)
    }
  }
  const value = responseValue(response)
  return {
    outcome: sanitizeTerminalText(response.outcome),
    ...(value === undefined
      ? {}
      : { value: typeof value === 'string' ? sanitizeTerminalText(value) : value }),
    ...(data === undefined ? {} : { data: safeData }),
  }
}

function responseValue(response: InteractionResponseValue): ResponseValue | undefined {
  return 'value' in response ? response.value : undefined
}
