import type { InteractionResponse } from '@tangle-network/agent-interface'
import type { AutomationRuleRecord } from '../domain/entities-runtime.js'
import type { BraidEvent, BraidEventEnvelope } from '../domain/events.js'
import { localInteractionId } from '../domain/interaction-identity.js'
import { DomainInvariantError } from '../domain/invariants-base.js'
import { assertAutomationRuleRecord } from '../domain/invariants-runtime.js'
import type { BraidState } from '../domain/state.js'
import { type ExecutionPort, supportsInteractionResponse } from '../ports/execution.js'
import { KeyedActionQueue } from './action-serialization.js'
import { operationId } from './application-guards.js'
import type { PortViews } from './application-port-builder.js'
import type { RuntimeEventEnvelopeLike, RuntimeEventIngestionResult } from './application-ports.js'
import type { InteractionReceipt } from './application-types.js'
import {
  type AutomationActions,
  type AutomationApplyOptions,
  createAutomationActions,
} from './automation-actions.js'
import type { SerializedEffectCoordinator } from './effect-coordinator.js'
import { AppError } from './errors.js'
import { InteractionAutomationCoordinator } from './interaction-automation-coordinator.js'
import { respondInteraction as respondInteractionController } from './interaction-controller.js'
import type { RunLedger } from './run-ledger.js'

const DEFAULT_INTERACTION_RESPONSE_TIMEOUT_MS = 5_000

export interface ApplicationInteractionActionsOptions {
  readonly state: () => BraidState
  readonly events: () => readonly BraidEventEnvelope[]
  readonly commitAndWait: (event: BraidEvent) => void | Promise<void>
  readonly now: () => string
  readonly execution: ExecutionPort
  readonly ledger: RunLedger
  readonly effects: SerializedEffectCoordinator
  readonly owner: string
  readonly ports: () => Pick<PortViews, 'state' | 'journal'>
  readonly whenDurable: () => Promise<void>
  readonly startupReconciliation?: Promise<void>
  readonly responseTimeoutMs?: number
}

export interface ApplicationInteractionResponseInput {
  readonly operationId: string
  readonly runId: string
  readonly interactionId: string
  readonly response: InteractionResponse
  readonly automationRule?: AutomationRuleRecord
}

interface InteractionReconciliationOptions {
  readonly bypassStartupReconciliation?: boolean
}

/** Owns interaction response ordering and automatic rule application. */
export class ApplicationInteractionActions {
  readonly automation: AutomationActions
  readonly #options: ApplicationInteractionActionsOptions
  readonly #responses = new KeyedActionQueue()
  readonly #coordinator: InteractionAutomationCoordinator
  readonly #startupReconciliation: Promise<void>

  constructor(options: ApplicationInteractionActionsOptions) {
    this.#options = options
    this.#startupReconciliation = options.startupReconciliation ?? Promise.resolve()
    this.automation = createAutomationActions({
      state: options.state,
      events: options.events,
      commitAndWait: options.commitAndWait,
      now: options.now,
      respond: (input, applyOptions) => this.#respond(input, applyOptions),
      startupReconciliation: this.#startupReconciliation,
      reconcilePending: () => this.reconcile(),
      canRespond: (runId) => this.canRespond(runId),
    })
    this.#coordinator = new InteractionAutomationCoordinator({
      state: options.state,
      events: options.events,
      apply: (input) => this.automation.apply(input, { bypassStartupReconciliation: true }),
    })
  }

  canRespond(runId?: string): boolean {
    if (runId === undefined || this.#options.execution.respondInteraction === undefined)
      return false
    const run = this.#options.state().runs.find((candidate) => candidate.id === runId)
    return run !== undefined && supportsInteractionResponse(run.receipt.capabilities)
  }

  acceptRuntimeEvent(
    envelope: RuntimeEventEnvelopeLike,
    result: RuntimeEventIngestionResult,
  ): void {
    if (
      !result.accepted ||
      envelope.event.type !== 'interaction' ||
      !this.canRespond(envelope.runId)
    )
      return
    const interactionId = localInteractionId(envelope.runId, envelope.event.request.id)
    const target = this.#options
      .state()
      .runs.find((run) => run.id === envelope.runId)
      ?.interactions.find((interaction) => interaction.request.id === interactionId)
    if (target !== undefined) this.#schedule(target)
  }

  respond(input: ApplicationInteractionResponseInput): Promise<InteractionReceipt> {
    return this.#respond(input)
  }

  #respond(
    input: ApplicationInteractionResponseInput,
    options: AutomationApplyOptions = {},
  ): Promise<InteractionReceipt> {
    const ready =
      options.bypassStartupReconciliation === true ? Promise.resolve() : this.#startupReconciliation
    return ready.then(() =>
      this.#responses.run(`${input.runId}\u0000${input.interactionId}`, () => {
        if (input.automationRule !== undefined) assertAutomationRule(input.automationRule)
        const ports = this.#options.ports()
        return respondInteractionController({
          operationId: operationId(input.operationId, 'respond-interaction'),
          runId: input.runId,
          interactionId: input.interactionId,
          response: input.response,
          ...(input.automationRule === undefined ? {} : { automationRule: input.automationRule }),
          state: ports.state,
          events: this.#options.events,
          commitAndWait: ports.journal.commitAndWait,
          ledger: this.#options.ledger,
          effects: this.#options.effects,
          execution: this.#options.execution,
          owner: this.#options.owner,
          responseTimeoutMs:
            this.#options.responseTimeoutMs ?? DEFAULT_INTERACTION_RESPONSE_TIMEOUT_MS,
          whenDurable: this.#options.whenDurable,
        })
      }),
    )
  }

  reconcile(options: InteractionReconciliationOptions = {}): Promise<void> {
    const ready =
      options.bypassStartupReconciliation === true ? Promise.resolve() : this.#startupReconciliation
    return ready.then(() => this.#coordinator.reconcile())
  }

  async whenIdle(): Promise<void> {
    await this.#coordinator.whenIdle()
    await this.#responses.whenIdle()
  }

  #schedule(target: Parameters<InteractionAutomationCoordinator['schedule']>[0]): void {
    void this.#startupReconciliation
      .then(() => this.#coordinator.schedule(target))
      .catch(() => undefined)
  }
}

function assertAutomationRule(rule: AutomationRuleRecord): void {
  try {
    assertAutomationRuleRecord(rule)
  } catch (error) {
    if (error instanceof DomainInvariantError) {
      const secret = /secret|credential|unsupported/iu.test(error.message)
      throw new AppError(
        secret ? 'AUTOMATION_SECRET_FORBIDDEN' : 'INVALID_AUTOMATION_RULE',
        error.message,
      )
    }
    throw error
  }
}
