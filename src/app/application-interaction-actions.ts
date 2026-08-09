import type { InteractionResponse } from '@tangle-network/agent-interface'
import type { AutomationRuleRecord } from '../domain/entities-runtime.js'
import type { BraidEvent, BraidEventEnvelope } from '../domain/events.js'
import type { BraidState } from '../domain/state.js'
import type { ExecutionPort } from '../ports/execution.js'
import { KeyedActionQueue } from './action-serialization.js'
import type { PortViews } from './application-port-builder.js'
import type { RuntimeEventEnvelopeLike, RuntimeEventIngestionResult } from './application-ports.js'
import type { InteractionReceipt } from './application-types.js'
import { type AutomationActions, createAutomationActions } from './automation-actions.js'
import type { SerializedEffectCoordinator } from './effect-coordinator.js'
import { operationId } from './application-guards.js'
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
  readonly responseTimeoutMs?: number
}

export interface ApplicationInteractionResponseInput {
  readonly operationId: string
  readonly runId: string
  readonly interactionId: string
  readonly response: InteractionResponse
  readonly automationRule?: AutomationRuleRecord
}

/** Owns interaction response ordering and automatic rule application. */
export class ApplicationInteractionActions {
  readonly automation: AutomationActions
  readonly #options: ApplicationInteractionActionsOptions
  readonly #responses = new KeyedActionQueue()
  readonly #coordinator: InteractionAutomationCoordinator

  constructor(options: ApplicationInteractionActionsOptions) {
    this.#options = options
    this.automation = createAutomationActions({
      state: options.state,
      events: options.events,
      commitAndWait: options.commitAndWait,
      now: options.now,
      respond: (input) => this.respond(input),
      reconcilePending: () => this.reconcile(),
      canRespond: () => this.canRespond(),
    })
    this.#coordinator = new InteractionAutomationCoordinator({
      state: options.state,
      events: options.events,
      apply: (input) => this.automation.apply(input),
    })
  }

  canRespond(): boolean {
    return this.#options.execution.respondInteraction !== undefined
  }

  acceptRuntimeEvent(
    envelope: RuntimeEventEnvelopeLike,
    result: RuntimeEventIngestionResult,
  ): void {
    if (!result.accepted || envelope.event.type !== 'interaction' || !this.canRespond()) return
    const interactionId = envelope.event.request.id
    const target = this.#options
      .state()
      .runs.find((run) => run.id === envelope.runId)
      ?.interactions.find((interaction) => interaction.request.id === interactionId)
    if (target !== undefined) void this.#coordinator.schedule(target)
  }

  respond(input: ApplicationInteractionResponseInput): Promise<InteractionReceipt> {
    return this.#responses.run(`${input.runId}\u0000${input.interactionId}`, () => {
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
    })
  }

  reconcile(): Promise<void> {
    return this.canRespond() ? this.#coordinator.reconcile() : Promise.resolve()
  }

  async whenIdle(): Promise<void> {
    await this.#coordinator.whenIdle()
    await this.#responses.whenIdle()
  }
}
