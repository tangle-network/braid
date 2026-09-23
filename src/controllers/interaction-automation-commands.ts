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
import type { Clock } from '../ports/clock.js'
import type { IdSource } from '../ports/ids.js'
import type { InteractionResponseResult } from '../ports/interactions.js'
import { InteractionError } from './interaction-error.js'
import type {
  AutomationDryRunInput,
  AutomationDryRunResult,
  CreateAutomationRuleInput,
  UpdateAutomationRuleInput,
} from './interaction-controller-types.js'
import {
  type AutomationMatcher,
  withoutProviderSession,
} from './interaction-automation-matching.js'
import { validateAutomationScope } from './interaction-automation-validation.js'
import {
  assertAutomationCommandBounded,
  assertAutomationCreateBounded,
  assertAutomationDryRunBounded,
  assertAutomationUpdateBounded,
} from './interaction-automation-bounds.js'
import type { InteractionPersistence } from './interaction-persistence.js'
import {
  type OperationAuthority,
  OperationConflictError,
  assertOperationId,
} from '../domain/operation-authority.js'

export class InteractionAutomationCommands {
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
  readonly #matcher: AutomationMatcher
  readonly #schedule: (record: InteractionRecord) => Promise<InteractionResponseResult | undefined>
  readonly #appendAudit: (input: Omit<AutomationAuditRecord, 'id'>) => void
  readonly #operations: OperationAuthority

  constructor(options: {
    readonly persistence: InteractionPersistence
    readonly clock: Clock
    readonly ids: IdSource
    readonly defaultContext?: {
      readonly profileDigest?: string
      readonly connectionId?: string
      readonly workspaceId?: string
      readonly runner?: string
    }
    readonly matcher: AutomationMatcher
    readonly schedule: (record: InteractionRecord) => Promise<InteractionResponseResult | undefined>
    readonly appendAudit: (input: Omit<AutomationAuditRecord, 'id'>) => void
    readonly operationAuthority: OperationAuthority
  }) {
    this.#persistence = options.persistence
    this.#clock = options.clock
    this.#ids = options.ids
    this.#defaultContext = options.defaultContext
    this.#matcher = options.matcher
    this.#schedule = options.schedule
    this.#appendAudit = options.appendAudit
    this.#operations = options.operationAuthority
    for (const envelope of options.persistence.events()) {
      const event = envelope.event
      if (event.kind === 'automation.rule.created' || event.kind === 'automation.rule.updated') {
        const rule = event.rule
        if (rule.operationId && rule.commandDigest) {
          this.#operations.remember(rule.operationId, rule.commandDigest, structuredClone(rule))
        }
      } else if (
        (event.kind === 'automation.rule.disabled' || event.kind === 'automation.rule.deleted') &&
        event.operationId &&
        event.commandDigest
      ) {
        this.#operations.remember(event.operationId, event.commandDigest, true)
      } else if (event.kind === 'automation.command.recorded') {
        this.#operations.remember(
          event.operationId,
          event.commandDigest,
          structuredClone(event.result),
        )
      }
    }
  }

  update(input: UpdateAutomationRuleInput): AutomationRuleRecord {
    this.#requireOperation(input.operationId)
    assertAutomationUpdateBounded(input)
    const state = this.#persistence.state()
    const existing = state.rules.find((rule) => rule.id === input.ruleId)
    if (!existing) {
      throw new InteractionError('UNKNOWN_AUTOMATION_RULE', 'The automation rule is not available')
    }
    const targetKey = input.interactionKey ?? existing.interactionKey
    const target = targetKey
      ? state.interactions.find((interaction) => interaction.key === targetKey)
      : undefined
    const request = input.request ? this.#parseRequest(input.request) : target?.request
    if ((input.answer !== undefined || input.responseScope !== undefined) && !request) {
      throw new InteractionError(
        'AUTOMATION_REQUEST_REQUIRED',
        'Updating an answer or scope requires the matching interaction request',
      )
    }
    const answer = input.answer ?? canonicalInteractionData(existing.answer)
    const responseScope = input.responseScope ?? existing.responseScope
    const matcherBase = target ? this.#matcher.ruleMatcherFor(target) : existing.matcher
    const matcher = {
      ...(responseScope === 'session' ? matcherBase : withoutProviderSession(matcherBase)),
      ...(input.matcher ?? {}),
    }
    const validation = request
      ? validateInteractionData(request.answerSpec, 'accepted', answer)
      : { ok: true as const, containsSecret: false, publicData: existing.answer }
    if (!validation.ok || validation.containsSecret) {
      throw new InteractionError(
        'INVALID_AUTOMATION_ANSWER',
        'Automation answer does not match the interaction',
      )
    }
    if (request) {
      validateAutomationScope(
        request,
        target,
        {
          operationId: input.operationId,
          ...(targetKey === undefined ? {} : { interactionKey: targetKey }),
          answer,
          responseScope,
          ...(input.matcher === undefined ? {} : { matcher: input.matcher }),
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
          ...(input.maximumUses === undefined ? {} : { maximumUses: input.maximumUses }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
        },
        validation.publicData,
      )
    }
    const digest = canonicalDigest({
      command: 'automation.update',
      ruleId: input.ruleId,
      interactionKey: targetKey,
      request,
      matcher,
      answer: validation.publicData,
      responseScope,
      expiresAt: input.expiresAt ?? existing.expiresAt,
      maximumUses: input.maximumUses ?? existing.maximumUses,
      priority: input.priority ?? existing.priority,
    })
    const previous = this.#commandResult(input.operationId, digest)
    if (previous !== undefined) return structuredClone(previous as AutomationRuleRecord)
    const rule: AutomationRuleRecord = {
      ...existing,
      ...(targetKey === undefined ? {} : { interactionKey: targetKey }),
      matcher,
      answer: validation.publicData,
      responseScope,
      ...(input.expiresAt === undefined && existing.expiresAt === undefined
        ? {}
        : { expiresAt: input.expiresAt ?? existing.expiresAt }),
      ...(input.maximumUses === undefined && existing.maximumUses === undefined
        ? {}
        : { maximumUses: input.maximumUses ?? existing.maximumUses }),
      priority: input.priority ?? existing.priority,
      operationId: input.operationId,
      commandDigest: digest,
    }
    this.#persistence.commit({ kind: 'automation.rule.updated', rule })
    this.#operations.remember(input.operationId, digest, structuredClone(rule))
    if (target?.status === 'pending') void this.#schedule(target)
    return structuredClone(rule)
  }

  create(input: CreateAutomationRuleInput): AutomationRuleRecord {
    this.#requireOperation(input.operationId)
    assertAutomationCreateBounded(input)
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
    const previous = this.#commandResult(input.operationId, digest)
    if (previous) return structuredClone(previous as AutomationRuleRecord)
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
      operationId: input.operationId,
      commandDigest: digest,
    }
    this.#persistence.commit({ kind: 'automation.rule.created', rule })
    this.#operations.remember(input.operationId, digest, structuredClone(rule))
    if (target?.status === 'pending') void this.#schedule(target)
    return structuredClone(rule)
  }

  async dryRun(input: AutomationDryRunInput): Promise<AutomationDryRunResult> {
    this.#requireOperation(input.operationId)
    assertAutomationDryRunBounded(input)
    const target = this.#persistence
      .state()
      .interactions.find((interaction) => interaction.key === input.key)
    if (!target)
      throw new InteractionError('UNKNOWN_INTERACTION', 'The interaction is not available')
    const digest = canonicalDigest({ command: 'automation.dry-run', key: input.key })
    const previous = this.#commandResult(input.operationId, digest)
    if (previous) return structuredClone(previous as AutomationDryRunResult)
    const candidates = this.#matcher.candidates(target, true)
    const result: AutomationDryRunResult = {
      key: input.key,
      eligible: candidates.some((candidate) => candidate.eligible),
      candidates,
      replayed: false,
    }
    this.#persistence.commit({
      kind: 'automation.command.recorded',
      operationId: input.operationId,
      commandDigest: digest,
      result,
    })
    this.#operations.remember(input.operationId, digest, structuredClone(result))
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
    assertAutomationCommandBounded(operationId, ruleId)
    const digest = canonicalDigest({ command: 'automation.disable', ruleId })
    const previous = this.#commandResult(operationId, digest)
    if (previous !== undefined) return Boolean(previous)
    const rule = this.#persistence.state().rules.find((item) => item.id === ruleId)
    if (!rule)
      throw new InteractionError('UNKNOWN_AUTOMATION_RULE', 'The automation rule is not available')
    this.#persistence.commit({
      kind: 'automation.rule.disabled',
      ruleId,
      operationId,
      commandDigest: digest,
    })
    this.#operations.remember(operationId, digest, true)
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
    assertAutomationCommandBounded(operationId, ruleId)
    const digest = canonicalDigest({ command: 'automation.delete', ruleId })
    const previous = this.#commandResult(operationId, digest)
    if (previous !== undefined) return Boolean(previous)
    if (!this.#persistence.state().rules.some((rule) => rule.id === ruleId)) {
      throw new InteractionError('UNKNOWN_AUTOMATION_RULE', 'The automation rule is not available')
    }
    this.#persistence.commit({
      kind: 'automation.rule.deleted',
      ruleId,
      operationId,
      commandDigest: digest,
    })
    this.#operations.remember(operationId, digest, true)
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
    try {
      const previous = this.#operations.get(operationId, digest)
      return previous === undefined ? undefined : structuredClone(previous.value)
    } catch (error) {
      if (error instanceof OperationConflictError)
        throw new InteractionError('OPERATION_CONFLICT', 'Operation input changed')
      throw error
    }
  }

  #parseRequest(input: CreateAutomationRuleInput['request']) {
    const parsed = parseInteractionRequest(input)
    if (!parsed.ok) throw new InteractionError('INVALID_INTERACTION', 'Invalid interaction request')
    return parsed.safeRequest
  }

  #requireOperation(operationId: string): void {
    try {
      assertOperationId(operationId)
    } catch (error) {
      throw new InteractionError(
        'OPERATION_ID_REQUIRED',
        error instanceof Error ? error.message : 'This action requires operationId',
      )
    }
  }
}
