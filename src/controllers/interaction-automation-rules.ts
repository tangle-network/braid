import { canonicalDigest } from '../domain/canonical.js'
import {
  answerSpecContainsSecret,
  canonicalInteractionData,
  parseInteractionRequest,
  validateInteractionData,
} from '../domain/interaction.js'
import type {
  AutomationAuditRecord,
  AutomationRuleRecord,
  InteractionRecord,
} from '../domain/interaction-state.js'
import type { InteractionCapabilities } from '../domain/interaction-state.js'
import type { Clock } from '../ports/clock.js'
import type { IdSource } from '../ports/ids.js'
import type { InteractionResponseResult, RespondInteractionInput } from '../ports/interactions.js'
import { InteractionError } from './interaction-error.js'
import type {
  AutomationDryRunInput,
  AutomationDryRunResult,
  CreateAutomationRuleInput,
} from './interaction-controller-types.js'
import { AutomationMatcher, withoutProviderSession } from './interaction-automation-matching.js'
import { validateAutomationScope } from './interaction-automation-validation.js'
import { bindingForRecord } from './interaction-controller-utils.js'
import type { InteractionPersistence } from './interaction-persistence.js'

interface StoredCommandOperation {
  readonly digest: string
  readonly result: unknown
}

export class InteractionAutomationRules {
  readonly #persistence: InteractionPersistence
  readonly #clock: Clock
  readonly #ids: IdSource
  readonly #defaultContext:
    | {
        readonly profileDigest?: string
        readonly connectionId?: string
        readonly workspaceId?: string
        readonly runner?: string
      }
    | undefined
  readonly #respond: (
    input: RespondInteractionInput,
    automated: boolean,
  ) => Promise<InteractionResponseResult>
  readonly #commands = new Map<string, StoredCommandOperation>()
  readonly #automationOperations = new Map<string, string>()
  readonly #reservations = new Map<string, number>()
  readonly #tasks = new Set<Promise<InteractionResponseResult | undefined>>()
  readonly #matcher: AutomationMatcher

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
  }) {
    this.#persistence = options.persistence
    this.#clock = options.clock
    this.#ids = options.ids
    this.#defaultContext = options.defaultContext
    this.#respond = options.respond
    this.#matcher = new AutomationMatcher({
      persistence: options.persistence,
      clock: options.clock,
      capabilities: options.capabilities,
      getReservation: (ruleId) => this.#reservations.get(ruleId) ?? 0,
      appendAudit: (input) => this.#appendAudit(input),
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
    const operationId = this.#automationOperations.get(record.key) ?? this.#ids.next('operation')
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

  ruleIdForInteraction(key: string): string | undefined {
    return this.#automationOperations.get(key)
  }

  create(input: CreateAutomationRuleInput): AutomationRuleRecord {
    this.#requireOperation(input.operationId)
    const state = this.#persistence.state()
    const target = input.interactionKey
      ? state.interactions.find((interaction) => interaction.key === input.interactionKey)
      : undefined
    let request = target?.request
    if (!request && input.request) {
      const parsed = parseInteractionRequest(input.request)
      if (!parsed.ok)
        throw new InteractionError('INVALID_INTERACTION', 'Invalid interaction request')
      request = parsed.safeRequest
    }
    if (!request)
      throw new InteractionError('UNKNOWN_INTERACTION', 'The interaction is not available')
    if (answerSpecContainsSecret(request.answerSpec)) {
      throw new InteractionError(
        'AUTOMATION_SECRET_FORBIDDEN',
        'Secret answers must remain manual and cannot be automated',
      )
    }
    const validation = validateInteractionData(request.answerSpec, 'accepted', input.answer)
    if (!validation.ok || validation.containsSecret) {
      throw new InteractionError(
        'INVALID_AUTOMATION_ANSWER',
        'Automation answer does not match the interaction',
      )
    }
    validateAutomationScope(request, target, input, validation.publicData)
    const matcherBase = target
      ? this.#matcher.ruleMatcherFor(target)
      : this.#matcher.matcherForRequest(request, {
          ...(this.#defaultContext?.profileDigest === undefined
            ? {}
            : { profileDigest: this.#defaultContext.profileDigest }),
          ...(this.#defaultContext?.connectionId === undefined
            ? {}
            : { connectionId: this.#defaultContext.connectionId }),
          ...(this.#defaultContext?.workspaceId === undefined
            ? {}
            : { workspaceId: this.#defaultContext.workspaceId }),
          ...(this.#defaultContext?.runner === undefined
            ? {}
            : { runner: this.#defaultContext.runner }),
        })
    const matcher = {
      ...(input.responseScope === 'session' ? matcherBase : withoutProviderSession(matcherBase)),
      ...input.matcher,
    }
    const digest = canonicalDigest({
      command: 'automation.create',
      interactionKey: input.interactionKey,
      request,
      matcher,
      answer: validation.publicData,
      responseScope: input.responseScope,
      expiresAt: input.expiresAt,
      maximumUses: input.maximumUses,
      priority: input.priority ?? 0,
    })
    const previous = this.#commands.get(input.operationId)
    if (previous) {
      if (previous.digest !== digest)
        throw new InteractionError('OPERATION_CONFLICT', 'Operation input changed')
      return structuredClone(previous.result as AutomationRuleRecord)
    }
    const createdAt = this.#clock.now()
    const rule: AutomationRuleRecord = {
      id: this.#ids.next('rule'),
      enabled: true,
      ...(input.interactionKey === undefined ? {} : { interactionKey: input.interactionKey }),
      matcher,
      answer: validation.publicData,
      responseScope: input.responseScope,
      createdAt,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      ...(input.maximumUses === undefined ? {} : { maximumUses: input.maximumUses }),
      uses: 0,
      priority: input.priority ?? 0,
    }
    this.#commands.set(input.operationId, { digest, result: structuredClone(rule) })
    this.#persistence.commit({ kind: 'automation.rule.created', rule })
    if (target?.status === 'pending') this.#track(this.apply(target))
    return structuredClone(rule)
  }

  async dryRun(input: AutomationDryRunInput): Promise<AutomationDryRunResult> {
    const target = this.#persistence
      .state()
      .interactions.find((interaction) => interaction.key === input.key)
    if (!target)
      throw new InteractionError('UNKNOWN_INTERACTION', 'The interaction is not available')
    const digest = canonicalDigest({ command: 'automation.dry-run', key: input.key })
    const previous = this.#commands.get(input.operationId)
    if (previous) {
      if (previous.digest !== digest)
        throw new InteractionError('OPERATION_CONFLICT', 'Operation input changed')
      return structuredClone(previous.result as AutomationDryRunResult)
    }
    const candidates = this.#matcher.candidates(target, true)
    const result: AutomationDryRunResult = {
      key: input.key,
      eligible: candidates.some((candidate) => candidate.eligible),
      candidates,
      replayed: false,
    }
    this.#commands.set(input.operationId, { digest, result: structuredClone(result) })
    this.#appendAudit({
      operationId: input.operationId,
      interactionKey: target.key,
      kind: target.request.kind,
      outcome: 'dry-run',
      createdAt: this.#clock.now(),
    })
    return result
  }

  disable(operationId: string, ruleId: string): boolean {
    const digest = canonicalDigest({ command: 'automation.disable', ruleId })
    const previous = this.#commandResult(operationId, digest)
    if (previous !== undefined) return Boolean(previous)
    const rule = this.#persistence.state().rules.find((item) => item.id === ruleId)
    if (!rule)
      throw new InteractionError('UNKNOWN_AUTOMATION_RULE', 'The automation rule is not available')
    this.#commands.set(operationId, { digest, result: true })
    if (rule.enabled) this.#persistence.commit({ kind: 'automation.rule.disabled', ruleId })
    this.#appendAudit({
      operationId,
      ruleId,
      kind: 'automation',
      outcome: 'disabled',
      createdAt: this.#clock.now(),
    })
    return true
  }

  delete(operationId: string, ruleId: string): boolean {
    const digest = canonicalDigest({ command: 'automation.delete', ruleId })
    const previous = this.#commandResult(operationId, digest)
    if (previous !== undefined) return Boolean(previous)
    if (!this.#persistence.state().rules.some((rule) => rule.id === ruleId)) {
      throw new InteractionError('UNKNOWN_AUTOMATION_RULE', 'The automation rule is not available')
    }
    this.#commands.set(operationId, { digest, result: true })
    this.#persistence.commit({ kind: 'automation.rule.deleted', ruleId })
    this.#appendAudit({
      operationId,
      ruleId,
      kind: 'automation',
      outcome: 'deleted',
      createdAt: this.#clock.now(),
    })
    return true
  }

  #commandResult(operationId: string, digest: string): unknown | undefined {
    const previous = this.#commands.get(operationId)
    if (!previous) return undefined
    if (previous.digest !== digest)
      throw new InteractionError('OPERATION_CONFLICT', 'Operation input changed')
    return structuredClone(previous.result)
  }

  #requireOperation(operationId: string): void {
    if (!operationId)
      throw new InteractionError('OPERATION_ID_REQUIRED', 'This action requires operationId')
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
