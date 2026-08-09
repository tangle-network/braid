import { canonicalDigest } from '../domain/canonical.js'
import { automationRuleAnswerDigest, type StoredAutomationRule } from './automation-matching.js'
import {
  automationOperationRecord,
  commitAutomationEvent,
  findAutomationOperation,
  findAutomationRuleEvent,
} from './automation-rule-store.js'
import type { AutomationRuleReceipt, UpdateAutomationRuleInput } from './automation-rule-types.js'
import {
  assertExpiry,
  assertMaximumUses,
  assertOperationDigest,
  interactionRequestDigest,
  normalizeAutomationRule,
  parseRuleId,
} from './automation-rule-validation.js'
import { AppError } from './errors.js'

export async function updateAutomationRule(
  input: UpdateAutomationRuleInput,
): Promise<AutomationRuleReceipt> {
  const ruleId = parseRuleId(input.ruleId)
  const current = input.state().rules.find((rule) => rule.id === ruleId) as
    | StoredAutomationRule
    | undefined
  if (current === undefined)
    throw new AppError('AUTOMATION_RULE_NOT_FOUND', 'The automation rule does not exist')
  if (input.request === undefined) {
    if (input.answer !== undefined || input.responseScope !== undefined)
      throw new AppError(
        'AUTOMATION_REQUEST_REQUIRED',
        'Updating an answer or response scope requires the matching interaction request',
      )
    return await updateRuleMetadata(input, current, ruleId)
  }
  const responseScope = input.responseScope ?? current.responseScope
  const context = {
    ...(input.context ?? {}),
    ...(input.context?.providerSessionId === undefined &&
    current.matcher.providerSessionId !== undefined
      ? { providerSessionId: current.matcher.providerSessionId }
      : {}),
  }
  const now = input.now?.() ?? new Date().toISOString()
  const expiresAt =
    input.expiresAt ??
    (current.expiresAt !== undefined && Date.parse(current.expiresAt) > Date.parse(now)
      ? current.expiresAt
      : undefined)
  const normalized = normalizeAutomationRule({
    ...input,
    ruleId,
    request: input.request,
    answer: input.answer ?? current.answer,
    responseScope,
    matcher: input.matcher ?? current.matcher,
    context,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(input.maximumUses === undefined && current.maximumUses === undefined
      ? {}
      : { maximumUses: input.maximumUses ?? current.maximumUses }),
    confirmPersistent:
      input.confirmPersistent ??
      (current.responseScope === 'persistent' && responseScope === 'persistent'),
    now: () => now,
  })
  const digest = canonicalDigest({
    kind: 'automation.rule.update',
    ruleId,
    requestDigest: interactionRequestDigest(input.request),
    matcher: normalized.rule.matcher,
    answerDigest: automationRuleAnswerDigest(normalized.rule),
    responseScope,
    expiresAt: input.expiresAt ?? current.expiresAt ?? null,
    maximumUses: normalized.rule.maximumUses ?? null,
  })
  const prior = findAutomationOperation(input.events(), normalized.operationId)
  if (prior !== undefined) {
    assertOperationDigest(prior, digest, normalized.operationId)
    const stored = findAutomationRuleEvent(input.events(), normalized.operationId)
    if (stored === undefined)
      throw new AppError('OPERATION_REQUIRES_RECONCILIATION', 'The rule write needs reconciliation')
    return {
      operationId: normalized.operationId,
      ruleId,
      rule: stored,
      replayed: true,
      revision: input.state().revision,
    }
  }
  const rule: StoredAutomationRule = {
    ...normalized.rule,
    enabled: current.enabled,
    createdAt: current.createdAt,
    uses: current.uses,
    ...(input.expiresAt === undefined && current.expiresAt !== undefined
      ? { expiresAt: current.expiresAt }
      : {}),
    ...(current.automationMetadata === undefined && normalized.rule.automationMetadata === undefined
      ? {}
      : {
          automationMetadata: {
            ...(current.automationMetadata ?? {}),
            ...(normalized.rule.automationMetadata ?? {}),
          },
        }),
  }
  await commitAutomationEvent(input, {
    kind: 'rule.upserted',
    rule,
    operation: automationOperationRecord(normalized.operationId, digest, now),
  })
  return {
    operationId: normalized.operationId,
    ruleId,
    rule,
    replayed: false,
    revision: input.state().revision,
  }
}

async function updateRuleMetadata(
  input: UpdateAutomationRuleInput,
  current: StoredAutomationRule,
  ruleId: StoredAutomationRule['id'],
): Promise<AutomationRuleReceipt> {
  const now = input.now?.() ?? new Date().toISOString()
  assertExpiry(input.expiresAt, now)
  assertMaximumUses(input.maximumUses)
  const matcher = {
    ...current.matcher,
    ...(input.matcher ?? {}),
    ...(input.context?.profileDigest === undefined
      ? {}
      : { profileDigest: input.context.profileDigest }),
    ...(input.context?.connectionId === undefined
      ? {}
      : { connectionId: input.context.connectionId }),
    ...(input.context?.runner === undefined ? {} : { runner: input.context.runner }),
    ...(input.context?.workspaceId === undefined ? {} : { workspaceId: input.context.workspaceId }),
    ...(input.context?.providerSessionId === undefined
      ? {}
      : { providerSessionId: input.context.providerSessionId }),
  }
  const automationMetadata = {
    ...(current.automationMetadata ?? {}),
    ...(input.creationSource === undefined ? {} : { creationSource: input.creationSource }),
    ...(input.context?.providerSessionId === undefined
      ? {}
      : { providerSessionId: input.context.providerSessionId }),
  }
  const digest = canonicalDigest({
    kind: 'automation.rule.update',
    ruleId,
    requestDigest: null,
    matcher,
    answerDigest: automationRuleAnswerDigest(current),
    responseScope: current.responseScope,
    expiresAt: input.expiresAt ?? current.expiresAt ?? null,
    maximumUses: input.maximumUses ?? current.maximumUses ?? null,
    automationMetadata,
  })
  const prior = findAutomationOperation(input.events(), input.operationId)
  if (prior !== undefined) {
    assertOperationDigest(prior, digest, input.operationId)
    const stored = findAutomationRuleEvent(input.events(), input.operationId)
    if (stored === undefined)
      throw new AppError('OPERATION_REQUIRES_RECONCILIATION', 'The rule write needs reconciliation')
    return {
      operationId: input.operationId,
      ruleId,
      rule: stored,
      replayed: true,
      revision: input.state().revision,
    }
  }
  const rule: StoredAutomationRule = {
    ...current,
    matcher,
    ...(Object.keys(automationMetadata).length === 0 ? {} : { automationMetadata }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    ...(input.maximumUses === undefined ? {} : { maximumUses: input.maximumUses }),
  }
  await commitAutomationEvent(input, {
    kind: 'rule.upserted',
    rule,
    operation: automationOperationRecord(input.operationId, digest, now),
  })
  return {
    operationId: input.operationId,
    ruleId,
    rule,
    replayed: false,
    revision: input.state().revision,
  }
}
