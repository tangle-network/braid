import type {
  AutomationRuleScope,
  NonSecretInteractionData,
} from '../../domain/entities-interactions.js'
import type { AutomationRuleMatcher } from '../../domain/entities-runtime.js'
import type { BraidUiController, InteractionResponseValue } from '../shared/intents.js'
import type { InteractionView } from '../shared/models.js'
import { AutomationRulePanel, type AutomationRuleSummary } from './automation-rule-panel.js'
import type { ModalCoordinator } from './modal-coordinator.js'
import type { BraidTheme } from './theme.js'

export interface AutomationOverlayOpenOptions {
  readonly interaction?: InteractionView
  readonly proposedResponse?: InteractionResponseValue
  readonly onClose?: () => void
  readonly notice?: string
}

export interface AutomationOverlayWorkflowOptions {
  readonly theme: BraidTheme
  readonly controller: BraidUiController
  readonly modals: ModalCoordinator
  readonly nextOperationId: () => string
  readonly requestRender: () => void
  readonly showError: (title: string, reason: string) => void
}

/** Owns terminal rule-panel effects while the panel emits only typed choices. */
export class AutomationOverlayWorkflow {
  readonly #options: AutomationOverlayWorkflowOptions
  #generation = 0

  constructor(options: AutomationOverlayWorkflowOptions) {
    this.#options = options
  }

  open(options: AutomationOverlayOpenOptions = {}): void {
    const generation = ++this.#generation
    void this.#loadRules().then((rules) => {
      if (generation !== this.#generation || rules === undefined) return
      const panel = new AutomationRulePanel({
        theme: this.#options.theme,
        rules,
        ...(options.interaction === undefined ? {} : { interaction: options.interaction }),
        ...(options.proposedResponse === undefined
          ? {}
          : { proposedResponse: options.proposedResponse }),
        ...(options.notice === undefined ? {} : { notice: options.notice }),
        startCreate: options.interaction !== undefined,
        onCreate: (intent) => void this.#create(intent, options),
        onDisable: (ruleId) => void this.#mutate('automation_disable', ruleId, options),
        onDelete: (ruleId) => void this.#mutate('automation_delete', ruleId, options),
        onCancel: () => this.#close(options),
      })
      this.#options.modals.open(panel, {
        anchor: 'center',
        width: '88%',
        minWidth: 40,
        maxHeight: '90%',
      })
      this.#options.requestRender()
    })
  }

  async #loadRules(): Promise<readonly AutomationRuleSummary[] | undefined> {
    const result = await this.#options.controller.dispatch({
      type: 'headless-command',
      command: 'automation_list',
      params: {},
    })
    if (result.kind !== 'accepted') {
      this.#showResultError('Automation unavailable', result)
      return undefined
    }
    const rules = automationRuleSummaries(result.data)
    if (rules === undefined) {
      this.#options.showError('Automation unavailable', 'The rule list returned invalid data')
      return undefined
    }
    return rules
  }

  async #create(
    intent: {
      readonly interaction: InteractionView
      readonly response: InteractionResponseValue
      readonly responseScope: AutomationRuleScope
      readonly confirmPersistent: boolean
    },
    options: AutomationOverlayOpenOptions,
  ): Promise<void> {
    const operationId = this.#options.nextOperationId()
    const result = await this.#options.controller.dispatch({
      type: 'create-interaction-automation',
      operationId,
      ruleId: ruleIdFor(operationId),
      runId: intent.interaction.runId,
      interactionId: intent.interaction.interactionId,
      response: intent.response,
      responseScope: intent.responseScope,
      confirmPersistent: intent.confirmPersistent,
    })
    if (result.kind !== 'accepted') {
      this.open({ ...options, notice: resultReason(result) })
      return
    }
    this.#close(options)
  }

  async #mutate(
    command: 'automation_disable' | 'automation_delete',
    ruleId: string,
    options: AutomationOverlayOpenOptions,
  ): Promise<void> {
    const result = await this.#options.controller.dispatch({
      type: 'headless-command',
      command,
      operationId: this.#options.nextOperationId(),
      params: { ruleId },
    })
    if (result.kind !== 'accepted') {
      this.open({ ...options, notice: resultReason(result) })
      return
    }
    this.open(options)
  }

  #close(options: AutomationOverlayOpenOptions): void {
    this.#generation += 1
    this.#options.modals.closeTop()
    options.onClose?.()
    this.#options.requestRender()
  }

  #showResultError(
    title: string,
    result: Exclude<
      Awaited<ReturnType<BraidUiController['dispatch']>>,
      { readonly kind: 'accepted' }
    >,
  ): void {
    this.#options.showError(title, result.kind === 'unavailable' ? result.reason : result.message)
  }
}

function resultReason(
  result: Exclude<
    Awaited<ReturnType<BraidUiController['dispatch']>>,
    { readonly kind: 'accepted' }
  >,
): string {
  return result.kind === 'unavailable' ? result.reason : result.message
}

function ruleIdFor(operationId: string): string {
  const suffix = operationId
    .replace(/^operation-/u, '')
    .replace(/[^A-Za-z0-9._-]/gu, '-')
    .slice(0, 48)
  return `rule-${suffix || 'automation'}`
}

function automationRuleSummaries(value: unknown): readonly AutomationRuleSummary[] | undefined {
  if (!Array.isArray(value)) return undefined
  const rules: AutomationRuleSummary[] = []
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== 'object') return undefined
    const rule = candidate as Readonly<Record<string, unknown>>
    if (
      typeof rule.id !== 'string' ||
      typeof rule.enabled !== 'boolean' ||
      !isScope(rule.responseScope) ||
      typeof rule.uses !== 'number'
    )
      return undefined
    if (rule.maximumUses !== undefined && typeof rule.maximumUses !== 'number') return undefined
    rules.push({
      id: rule.id,
      enabled: rule.enabled,
      responseScope: rule.responseScope,
      uses: rule.uses,
      ...(rule.maximumUses === undefined ? {} : { maximumUses: rule.maximumUses }),
      ...(isRecord(rule.matcher) ? { matcher: rule.matcher as AutomationRuleMatcher } : {}),
      ...(isRecord(rule.answer) ? { answer: rule.answer as NonSecretInteractionData } : {}),
    })
  }
  return rules
}

function isScope(value: unknown): value is AutomationRuleScope {
  return value === 'once' || value === 'session' || value === 'persistent'
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
