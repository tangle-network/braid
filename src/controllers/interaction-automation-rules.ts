import { canonicalDigest } from '../domain/canonical.js'
import { canonicalInteractionData } from '../domain/interaction.js'
import type { AutomationAuditRecord, InteractionRecord } from '../domain/interaction-state.js'
import type { InteractionCapabilities } from '../domain/interaction-state.js'
import type { Clock } from '../ports/clock.js'
import type { IdSource } from '../ports/ids.js'
import type { InteractionResponseResult, RespondInteractionInput } from '../ports/interactions.js'
import { AutomationMatcher } from './interaction-automation-matching.js'
import { bindingForRecord } from './interaction-controller-utils.js'
import { finalizeAutomationOutcomes } from './interaction-automation-outcome.js'
import { InteractionAutomationCommands } from './interaction-automation-commands.js'
import type { InteractionPersistence } from './interaction-persistence.js'
import type { OperationAuthority } from '../domain/operation-authority.js'

export class InteractionAutomationRules {
  readonly #persistence: InteractionPersistence
  readonly #clock: Clock
  readonly #ids: IdSource
  readonly #respond: (
    input: RespondInteractionInput,
    automated: boolean,
  ) => Promise<InteractionResponseResult>
  readonly #automationOperations = new Map<string, string>()
  readonly #reservations = new Map<string, number>()
  readonly #tasks = new Set<Promise<InteractionResponseResult | undefined>>()
  readonly #matcher: AutomationMatcher
  readonly commands: InteractionAutomationCommands

  constructor(options: {
    readonly persistence: InteractionPersistence
    readonly clock: Clock
    readonly ids: IdSource
    readonly capabilities: InteractionCapabilities
    readonly defaultContext?: {
      readonly profileDigest?: string
      readonly connectionId?: string
      readonly workspaceId?: string
      readonly runner?: string
    }
    readonly respond: (
      input: RespondInteractionInput,
      automated: boolean,
    ) => Promise<InteractionResponseResult>
    readonly operationAuthority: OperationAuthority
  }) {
    this.#persistence = options.persistence
    this.#clock = options.clock
    this.#ids = options.ids
    this.#respond = options.respond
    this.#matcher = new AutomationMatcher({
      persistence: options.persistence,
      clock: options.clock,
      capabilities: options.capabilities,
      getReservation: (ruleId) => this.#reservations.get(ruleId) ?? 0,
      appendAudit: (input) => this.#appendAudit(input),
    })
    this.commands = new InteractionAutomationCommands({
      persistence: options.persistence,
      clock: options.clock,
      ids: options.ids,
      ...(options.defaultContext === undefined ? {} : { defaultContext: options.defaultContext }),
      matcher: this.#matcher,
      schedule: (record) => this.schedule(record),
      appendAudit: (input) => this.#appendAudit(input),
      operationAuthority: options.operationAuthority,
    })
  }

  schedule(record: InteractionRecord): Promise<InteractionResponseResult | undefined> {
    return this.#track(Promise.resolve().then(() => this.apply(record)))
  }

  apply(record: InteractionRecord): Promise<InteractionResponseResult | undefined> {
    const candidates = this.#matcher.candidates(record, false)
    const eligible = candidates.filter((candidate) => candidate.eligible)
    const highest = eligible[0]
    if (!highest) return Promise.resolve(undefined)
    const samePriority = eligible.filter((candidate) => {
      const state = this.#persistence.state()
      const rule = state.rules.find((item) => item.id === candidate.ruleId)
      const first = state.rules.find((item) => item.id === highest.ruleId)
      return rule?.priority === first?.priority
    })
    if (samePriority.length > 1) {
      const state = this.#persistence.state()
      const digests = new Set(
        samePriority.map((candidate) => {
          const rule = state.rules.find((item) => item.id === candidate.ruleId)
          return canonicalDigest(rule?.answer ?? {})
        }),
      )
      if (digests.size > 1) {
        this.#appendAudit({
          interactionKey: record.key,
          kind: record.request.kind,
          outcome: 'conflict',
          reason: 'Multiple equal-priority rules offered different answers',
          createdAt: this.#clock.now(),
        })
        return Promise.resolve(undefined)
      }
    }
    const rule = this.#persistence.state().rules.find((item) => item.id === highest.ruleId)
    if (!rule) return Promise.resolve(undefined)
    this.#appendAudit({
      interactionKey: record.key,
      ruleId: rule.id,
      kind: record.request.kind,
      outcome: 'matched',
      answerDigest: canonicalDigest(rule.answer),
      createdAt: this.#clock.now(),
    })
    const operationId =
      this.#automationOperations.get(record.key) ??
      `automation-${canonicalDigest({ key: record.key, ruleId: rule.id })}`
    this.#automationOperations.set(record.key, rule.id)
    this.#reservations.set(rule.id, (this.#reservations.get(rule.id) ?? 0) + 1)
    const response = this.#respond(
      {
        ...bindingForRecord(record),
        operationId,
        response: {
          id: record.interactionId,
          outcome: 'accepted',
          data: canonicalInteractionData(rule.answer),
        },
      },
      true,
    )
    return response.finally(() => this.#release(rule.id))
  }

  async waitForAutomation(): Promise<void> {
    await Promise.all([...this.#tasks])
  }

  reconcileOutcomes(): void {
    finalizeAutomationOutcomes(this.#persistence, this.#clock, this.#ids)
  }

  ruleIdForInteraction(key: string): string | undefined {
    return this.#automationOperations.get(key)
  }

  #appendAudit(input: Omit<AutomationAuditRecord, 'id'>): void {
    this.#persistence.commit({
      kind: 'automation.audit.recorded',
      audit: { id: this.#ids.next('audit'), ...input },
    })
  }

  #track(
    task: Promise<InteractionResponseResult | undefined>,
  ): Promise<InteractionResponseResult | undefined> {
    this.#tasks.add(task)
    void task.then(
      () => this.#tasks.delete(task),
      () => this.#tasks.delete(task),
    )
    return task
  }

  #release(ruleId: string): void {
    const reservation = this.#reservations.get(ruleId) ?? 0
    if (reservation <= 1) this.#reservations.delete(ruleId)
    else this.#reservations.set(ruleId, reservation - 1)
  }
}
