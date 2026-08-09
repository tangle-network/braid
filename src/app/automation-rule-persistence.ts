import { canonicalDigest } from '../domain/canonical.js'
import type { BraidEvent, BraidEventEnvelope } from '../domain/events.js'
import { createOperationId, type Digest } from '../domain/ids.js'
import type { StoredAutomationRule } from './automation-matching.js'
import type {
  ApplyAutomationInput,
  AutomationRuleReceipt,
  AutomationStoreInput,
  CreateAutomationRuleInput,
  RuleMutationReceipt,
} from './automation-rule-types.js'
import {
  assertOperationDigest,
  normalizeAutomationRule,
  parseRuleId,
  requiredOperationId,
} from './automation-rule-validation.js'
import { AppError } from './errors.js'

export async function createAutomationRule(
  input: CreateAutomationRuleInput,
): Promise<AutomationRuleReceipt> {
  const normalized = normalizeAutomationRule(input)
  const prior = findRuleOperation(input.events(), normalized.operationId)
  if (prior !== undefined) {
    assertOperationDigest(prior, normalized.digest, normalized.operationId)
    const stored = findRuleEvent(input.events(), normalized.operationId)
    if (stored === undefined)
      throw new AppError('OPERATION_REQUIRES_RECONCILIATION', 'The rule write needs reconciliation')
    return {
      operationId: normalized.operationId,
      ruleId: stored.id,
      rule: stored,
      replayed: true,
      revision: input.state().revision,
    }
  }
  await commit(input, {
    kind: 'rule.upserted',
    rule: normalized.rule,
    operation: operationRecord(normalized.operationId, normalized.digest, normalized.now),
  })
  return {
    operationId: normalized.operationId,
    ruleId: normalized.ruleId,
    rule: normalized.rule,
    replayed: false,
    revision: input.state().revision,
  }
}

export async function disableAutomationRule(
  input: AutomationStoreInput & { readonly operationId: string; readonly ruleId: string },
): Promise<RuleMutationReceipt> {
  return await mutateRule(input, false)
}

export async function deleteAutomationRule(
  input: AutomationStoreInput & { readonly operationId: string; readonly ruleId: string },
): Promise<RuleMutationReceipt> {
  const operationId = requiredOperationId(input.operationId)
  const ruleId = parseRuleId(input.ruleId)
  const digest = canonicalDigest({ kind: 'automation.rule.delete', ruleId })
  const prior = findRuleOperation(input.events(), operationId)
  if (prior !== undefined) {
    assertOperationDigest(prior, digest, operationId)
    return {
      operationId,
      ruleId,
      replayed: true,
      revision: input.state().revision,
    }
  }
  if (!input.state().rules.some((rule) => rule.id === ruleId))
    throw new AppError('AUTOMATION_RULE_NOT_FOUND', 'The automation rule does not exist')
  const now = input.now?.() ?? new Date().toISOString()
  await commit(input, {
    kind: 'rule.deleted',
    ruleId,
    operation: operationRecord(operationId, digest, now),
  })
  return {
    operationId,
    ruleId,
    replayed: false,
    revision: input.state().revision,
  }
}

export async function reserveRuleUse(
  input: ApplyAutomationInput,
  rule: StoredAutomationRule,
  operationId: string,
  now: string,
): Promise<boolean> {
  const reservationId = `operation-${canonicalDigest({ kind: 'automation.rule.use', operationId, ruleId: rule.id }).slice(0, 48)}`
  const reservationDigest = canonicalDigest({
    kind: 'automation.rule.use',
    operationId,
    ruleId: rule.id,
    uses: rule.uses + 1,
  })
  const previous = findRuleOperation(input.events(), reservationId)
  if (previous !== undefined) {
    assertOperationDigest(previous, reservationDigest, operationId)
    return false
  }
  const nextRule: StoredAutomationRule = { ...rule, uses: rule.uses + 1 }
  await commit(input, {
    kind: 'rule.upserted',
    rule: nextRule,
    operation: operationRecord(reservationId, reservationDigest, now),
  })
  return true
}

export async function commit(input: AutomationStoreInput, event: BraidEvent): Promise<void> {
  const result = input.commitAndWait(event)
  if (result !== undefined) await result
}

async function mutateRule(
  input: AutomationStoreInput & { readonly operationId: string; readonly ruleId: string },
  enabled: boolean,
): Promise<RuleMutationReceipt> {
  const operationId = requiredOperationId(input.operationId)
  const ruleId = parseRuleId(input.ruleId)
  const current = input.state().rules.find((rule) => rule.id === ruleId) as
    | StoredAutomationRule
    | undefined
  if (current === undefined)
    throw new AppError('AUTOMATION_RULE_NOT_FOUND', 'The automation rule does not exist')
  const digest = canonicalDigest({ kind: 'automation.rule.disable', ruleId, enabled })
  const prior = findRuleOperation(input.events(), operationId)
  if (prior !== undefined) {
    assertOperationDigest(prior, digest, operationId)
    return {
      operationId,
      ruleId,
      rule: current,
      replayed: true,
      revision: input.state().revision,
    }
  }
  const now = input.now?.() ?? new Date().toISOString()
  const rule: StoredAutomationRule = { ...current, enabled }
  await commit(input, {
    kind: 'rule.upserted',
    rule,
    operation: operationRecord(operationId, digest, now),
  })
  return {
    operationId,
    ruleId,
    rule,
    replayed: false,
    revision: input.state().revision,
  }
}

function operationRecord(operationId: string, requestDigest: Digest, now: string) {
  return {
    id: createOperationId(operationId),
    kind: 'custom' as const,
    requestDigest,
    status: 'terminal' as const,
    createdAt: now,
    updatedAt: now,
  }
}

function findRuleOperation(
  events: readonly BraidEventEnvelope[],
  operationId: string,
): { readonly id: string; readonly requestDigest: Digest } | undefined {
  for (const envelope of events) {
    const event = envelope.event
    if (event.kind === 'rule.upserted' && event.operation?.id === operationId)
      return event.operation
    if (event.kind === 'rule.deleted' && event.operation.id === operationId) return event.operation
  }
  return undefined
}

function findRuleEvent(
  events: readonly BraidEventEnvelope[],
  operationId: string,
): StoredAutomationRule | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event
    if (event?.kind === 'rule.upserted' && event.operation?.id === operationId)
      return event.rule as StoredAutomationRule
  }
  return undefined
}
