import type { InteractionViewModel } from '../views/shared/interaction.js'
import { buildInteractionViews } from '../views/shared/interaction.js'
import type {
  CancelInteractionInput,
  InteractionControllerPort,
  InteractionReceiveResult,
  InteractionResponseResult,
  InteractionRuntimePort,
  ReceiveInteractionInput,
  RespondInteractionInput,
} from '../ports/interactions.js'
import type { InteractionQueueState } from '../domain/interaction-state.js'
import { InteractionAdmission } from './interaction-admission.js'
import { InteractionAutomationRules } from './interaction-automation-rules.js'
import { InteractionPersistence } from './interaction-persistence.js'
import { InteractionReconciliation } from './interaction-reconciliation.js'
import { InteractionResponse } from './interaction-response.js'
import type {
  AutomationDryRunInput,
  AutomationDryRunResult,
  CreateAutomationRuleInput,
  InteractionControllerOptions,
  InteractionSubscriber,
} from './interaction-controller-types.js'

export { InteractionError } from './interaction-error.js'
export type {
  AutomationCandidate,
  AutomationDryRunInput,
  AutomationDryRunResult,
  CreateAutomationRuleInput,
  InteractionControllerOptions,
  InteractionSubscriber,
} from './interaction-controller-types.js'

export class InteractionController implements InteractionControllerPort {
  readonly #runtime: InteractionRuntimePort
  readonly #clock: InteractionControllerOptions['clock']
  readonly #persistence: InteractionPersistence
  readonly #admission: InteractionAdmission
  readonly #response: InteractionResponse
  readonly #reconciliation: InteractionReconciliation
  readonly #automation: InteractionAutomationRules

  constructor(options: InteractionControllerOptions) {
    this.#runtime = options.runtime
    this.#clock = options.clock
    this.#persistence = new InteractionPersistence({
      clock: options.clock,
      ids: options.ids,
      ...(options.initialState === undefined ? {} : { initialState: options.initialState }),
      ...(options.initialEvents === undefined ? {} : { initialEvents: options.initialEvents }),
    })
    this.#admission = new InteractionAdmission({
      persistence: this.#persistence,
      clock: options.clock,
      ...(options.defaultContext === undefined ? {} : { defaultContext: options.defaultContext }),
    })
    const automationRef: { service?: InteractionAutomationRules } = {}
    this.#response = new InteractionResponse({
      persistence: this.#persistence,
      runtime: options.runtime,
      clock: options.clock,
      ids: options.ids,
      feedbackCapture: options.feedbackCapture !== false,
      automationRuleFor: (key) => automationRef.service?.ruleIdForInteraction(key),
    })
    this.#automation = new InteractionAutomationRules({
      persistence: this.#persistence,
      clock: options.clock,
      ids: options.ids,
      capabilities: options.runtime.capabilities,
      ...(options.defaultContext === undefined ? {} : { defaultContext: options.defaultContext }),
      respond: (input, automated) => this.#response.respond(input, automated),
    })
    automationRef.service = this.#automation
    this.#reconciliation = new InteractionReconciliation({
      persistence: this.#persistence,
      runtime: options.runtime,
    })
  }

  state(): InteractionQueueState {
    return this.#persistence.state()
  }

  events() {
    return this.#persistence.events()
  }

  views(now = this.#clock.now()): readonly InteractionViewModel[] {
    return buildInteractionViews(this.#persistence.state(), now, this.#runtime.capabilities)
  }

  capabilities(): InteractionRuntimePort['capabilities'] {
    return this.#runtime.capabilities
  }

  setFeedbackCapture(enabled: boolean): void {
    this.#response.setFeedbackCapture(enabled)
  }

  subscribe(subscriber: InteractionSubscriber): () => void {
    return this.#persistence.subscribe(subscriber)
  }

  receive(input: ReceiveInteractionInput): InteractionReceiveResult & {
    readonly automation: Promise<InteractionResponseResult | undefined>
  } {
    const admission = this.#admission.receive(input)
    if (!admission.record) {
      return { ...admission, automation: Promise.resolve(undefined) }
    }
    return {
      key: admission.key,
      replayed: admission.replayed,
      queuePosition: admission.queuePosition,
      containsSecret: admission.containsSecret,
      automation: this.#automation.schedule(admission.record),
    }
  }

  queuePosition(key: string): number {
    return this.#admission.queuePosition(key)
  }

  respond(input: RespondInteractionInput): Promise<InteractionResponseResult> {
    return this.#response.respond(input)
  }

  cancel(input: CancelInteractionInput): Promise<InteractionResponseResult> {
    return this.#response.cancel(input)
  }

  reconcile(input: { readonly runId?: string; readonly signal?: AbortSignal } = {}): Promise<void> {
    return this.#reconciliation.reconcile(input)
  }

  tick(now = this.#clock.now()): Promise<void> {
    return this.#response.tick(now)
  }

  waitForAutomation(): Promise<void> {
    return this.#automation.waitForAutomation()
  }

  createAutomationRule(input: CreateAutomationRuleInput) {
    return this.#automation.create(input)
  }

  dryRun(input: AutomationDryRunInput): Promise<AutomationDryRunResult> {
    return this.#automation.dryRun(input)
  }

  disableAutomationRule(operationId: string, ruleId: string): boolean {
    return this.#automation.disable(operationId, ruleId)
  }

  deleteAutomationRule(operationId: string, ruleId: string): boolean {
    return this.#automation.delete(operationId, ruleId)
  }
}
