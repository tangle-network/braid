import type {
  AutomationRuleScope,
  NonSecretInteractionData,
  NonSecretInteractionValue,
} from '../../domain/entities-interactions.js'
import type { AutomationRuleMatcher } from '../../domain/entities-runtime.js'
import type { InteractionResponseValue } from '../shared/intents.js'
import type { AnswerSpecView, InteractionView } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import { isSecretInteraction } from './interaction-presentation.js'
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
  readonly notice?: string
  readonly startCreate?: boolean
  readonly onSelect?: (ruleId: string) => void
  readonly onCreate?: (intent: AutomationRuleCreateIntent) => void
  readonly onDisable?: (ruleId: string) => void
  readonly onDelete?: (ruleId: string) => void
  readonly onCancel: () => void
}

const AUTOMATION_SCOPES: readonly AutomationRuleScope[] = ['once', 'session', 'persistent']
type ResponseDataValue = string | number | boolean | readonly string[]
type ResponseValue = string | number | boolean

export function ruleItem(rule: AutomationRuleSummary): {
  readonly value: string
  readonly label: string
  readonly description: string
} {
  const status = rule.enabled ? 'on' : 'off'
  const uses = String(rule.uses) + (rule.maximumUses === undefined ? '' : `/${rule.maximumUses}`)
  return {
    value: rule.id,
    label:
      status +
      ' ' +
      sanitizeTerminalText(rule.id) +
      ' · ' +
      sanitizeTerminalText(rule.responseScope) +
      ' · ' +
      uses,
    description: [ruleSummaryAnswer(rule.answer), ruleSummaryMatcher(rule.matcher)]
      .filter((value) => value.length > 0)
      .join(' · '),
  }
}

export function scopeItem(scope: AutomationRuleScope): {
  readonly value: string
  readonly label: string
  readonly description: string
} {
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

export function interactionSummary(interaction: InteractionView): string {
  const kind = sanitizeTerminalText(interaction.kind) || 'interaction'
  const prompt = sanitizeTerminalText(interaction.prompt).replace(/[\r\n]+/gu, ' ')
  return prompt.length === 0 ? kind : `${kind} · ${prompt}`
}

export function ruleCreationReason(interaction: InteractionView): string | undefined {
  if (containsSecret(interaction)) return 'manual only · secret responses are never automated'
  if (!interaction.allowedOutcomes.some(isPositiveOutcome))
    return 'manual only · no accepted response is available'
  if (offeredScopes(interaction).length === 0)
    return 'manual only · this interaction offers no reusable response scope'
  if (!supportsResponse(interaction.answerSpec))
    return 'manual only · this response shape is not supported'
  return undefined
}

export function offeredScopes(interaction: InteractionView): readonly AutomationRuleScope[] {
  const explicit = new Set(interaction.responseScopes)
  return AUTOMATION_SCOPES.filter((scope) => explicit.has(scope))
}

export function parseScope(value: string): AutomationRuleScope | undefined {
  return isScope(value) ? value : undefined
}

export function positiveOutcome(
  interaction: InteractionView,
  response: InteractionResponseValue,
): string {
  return isPositiveOutcome(response.outcome)
    ? response.outcome
    : (interaction.allowedOutcomes.find(isPositiveOutcome) ?? 'accept')
}

export function initialResponse(
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
  return { outcome }
}

export function safeResponse(response: InteractionResponseValue): InteractionResponseValue {
  const data = response.data
  const safeData: Record<string, ResponseDataValue> = {}
  if (data !== undefined) {
    for (const [key, value] of Object.entries(data))
      safeData[sanitizeTerminalText(key)] = cloneValue(value)
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

export function scopedResponse(
  interaction: InteractionView,
  response: InteractionResponseValue,
  responseScope: AutomationRuleScope,
): InteractionResponseValue {
  const safe = safeResponse(response)
  return interaction.kind === 'permission' ? { ...safe, outcome: responseScope } : safe
}

export function responseValue(response: InteractionResponseValue): ResponseValue | undefined {
  return 'value' in response ? response.value : undefined
}

export function isPositiveOutcome(outcome: string): boolean {
  return ['accept', 'once', 'session', 'persistent'].includes(outcome)
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

function containsSecret(interaction: InteractionView): boolean {
  if (isSecretInteraction(interaction)) return true
  const spec = interaction.answerSpec
  return spec.kind === 'form' && spec.fields.some((field) => field.type === 'secret')
}

function supportsResponse(spec: AnswerSpecView): boolean {
  if (spec.kind === 'unknown' || spec.kind === 'secret' || spec.kind === 'form') return false
  return spec.kind !== 'select' || spec.options.length > 0
}

function isScope(value: string): value is AutomationRuleScope {
  return AUTOMATION_SCOPES.includes(value as AutomationRuleScope)
}

function cloneValue(value: ResponseDataValue): ResponseDataValue {
  return Array.isArray(value) ? value.map(sanitizeTerminalText) : value
}
