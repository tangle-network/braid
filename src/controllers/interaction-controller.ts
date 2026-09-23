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
import { randomBytes } from 'node:crypto'
import type { Scheduler } from '../ports/scheduler.js'
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
  UpdateAutomationRuleInput,
} from './interaction-controller-types.js'
import { SystemScheduler } from '../ports/scheduler.js'
import { OperationAuthority } from '../domain/operation-authority.js'

const DEFAULT_SECRET_RESPONSE_KEY = randomBytes(32)

export { InteractionError } from './interaction-error.js'
export type {
  AutomationCandidate,
  AutomationDryRunInput,
  AutomationDryRunResult,
  CreateAutomationRuleInput,
  InteractionControllerOptions,
  InteractionSubscriber,
  UpdateAutomationRuleInput,
} from './interaction-controller-types.js'

export class InteractionController implements InteractionControllerPort {
  readonly #runtime: InteractionRuntimePort
  readonly #clock: InteractionControllerOptions['clock']
  readonly #persistence: InteractionPersistence
  readonly #admission: InteractionAdmission
  readonly #response: InteractionResponse
  readonly #reconciliation: InteractionReconciliation
  readonly #automation: InteractionAutomationRules
  readonly #scheduler: Scheduler

  constructor(options: InteractionControllerOptions) {
    this.#runtime = options.runtime
    this.#clock = options.clock
    this.#scheduler = options.scheduler ?? new SystemScheduler()
    const operationAuthority = options.operationAuthority ?? new OperationAuthority()
    this.#persistence = new InteractionPersistence({
      clock: options.clock,
      ids: options.ids,
      ...(options.initialState === undefined ? {} : { initialState: options.initialState }),
      ...(options.initialEvents === undefined ? {} : { initialEvents: options.initialEvents }),
      ...(options.applicationState === undefined
        ? {}
        : { applicationState: options.applicationState }),
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
      scheduler: this.#scheduler,
      secretKey: options.secretResponseKey ?? DEFAULT_SECRET_RESPONSE_KEY,
      operationAuthority,
      automationRuleFor: (key) => automationRef.service?.ruleIdForInteraction(key),
    })
    this.#automation = new InteractionAutomationRules({
      persistence: this.#persistence,
      clock: options.clock,
      ids: options.ids,
      capabilities: options.runtime.capabilities,
      ...(options.defaultContext === undefined ? {} : { defaultContext: options.defaultContext }),
      operationAuthority,
      respond: (input, automated) => this.#respondWithReconciliation(input, automated),
    })
    automationRef.service = this.#automation
    this.#reconciliation = new InteractionReconciliation({
      persistence: this.#persistence,
      runtime: options.runtime,
      clock: options.clock,
    })
    for (const interaction of this.#persistence.state().interactions) {
      this.#response.schedule(interaction)
    }
    if ((options.initialEvents?.length ?? 0) > 0) {
      queueMicrotask(() => void this.reconcile().then(() => this.#scheduleAutomation()))
    } else {
      this.#scheduleAutomation()
    }
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
    this.#response.schedule(admission.record)
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
    return this.#respondWithReconciliation(input, false)
  }

  cancel(input: CancelInteractionInput): Promise<InteractionResponseResult> {
    return this.#response.cancel(input)
  }

  async reconcile(
    input: { readonly runId?: string; readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.#reconciliation.reconcile(input)
    this.#automation.reconcileOutcomes()
  }

  tick(now = this.#clock.now()): Promise<void> {
    return this.#response.tick(now)
  }

  dispose(): void {
    this.#response.dispose()
  }

  waitForAutomation(): Promise<void> {
    return this.#automation.waitForAutomation()
  }

  createAutomationRule(input: CreateAutomationRuleInput) {
    return this.#automation.commands.create(input)
  }

  updateAutomationRule(input: UpdateAutomationRuleInput) {
    return this.#automation.commands.update(input)
  }

  dryRun(input: AutomationDryRunInput): Promise<AutomationDryRunResult> {
    return this.#automation.commands.dryRun(input)
  }

  disableAutomationRule(operationId: string, ruleId: string): boolean {
    return this.#automation.commands.disable(operationId, ruleId)
  }

  deleteAutomationRule(operationId: string, ruleId: string): boolean {
    return this.#automation.commands.delete(operationId, ruleId)
  }

  #scheduleAutomation(): void {
    for (const interaction of this.#persistence.state().interactions) {
      if (interaction.status === 'pending') this.#automation.schedule(interaction)
    }
  }

  async #respondWithReconciliation(
    input: RespondInteractionInput,
    automated: boolean,
  ): Promise<InteractionResponseResult> {
    const result = await this.#response.respond(input, automated)
    if (
      result.status === 'transport_error' ||
      result.status === 'unknown' ||
      result.status === 'unknown_interaction' ||
      result.status === 'unknown_run'
    ) {
      await this.#reconciliation.reconcile({ runId: input.runId })
    }
    this.#automation.reconcileOutcomes()
    return result
  }
}
