import type { InteractionRequest } from '@tangle-network/agent-interface'
import { canonicalDigest } from '../domain/canonical.js'
import type { AutomationRuleMatcher, AutomationRuleRecord } from '../domain/entities-runtime.js'
import type { BraidInteraction } from '../domain/runtime-projection.js'
import type { AutomationRuleScope } from '../domain/entities-interactions.js'
import { interactionHasSecretField } from './interaction-response.js'

/**
 * Optional metadata that is stored with an existing Braid rule record without
 * changing the provider or agent-interface contracts.
 */
export interface AutomationRuleMetadata {
  readonly providerSessionId?: string
  readonly creationSource?: 'manual' | 'imported'
}

export type StoredAutomationRule = AutomationRuleRecord & {
  readonly matcher: AutomationRuleMatcher & AutomationRuleRuleSession
  readonly automationMetadata?: AutomationRuleMetadata
}

interface AutomationRuleRuleSession {
  readonly providerSessionId?: string
}

export interface AutomationEvaluationContext {
  readonly profileDigest?: string
  readonly connectionId?: string
  readonly runner?: string
  readonly workspaceId?: string
  readonly providerSessionId?: string
  readonly now: string
}

export interface AutomationEvaluation {
  readonly status: 'eligible' | 'none' | 'conflict' | 'expired' | 'use-limit' | 'disabled'
  readonly rule?: StoredAutomationRule
  readonly matchingRules: readonly StoredAutomationRule[]
  readonly skippedRules: readonly {
    readonly rule: StoredAutomationRule
    readonly reason: 'expired' | 'use-limit' | 'disabled'
  }[]
  readonly detail?: string
}

export function evaluateAutomation(
  rules: readonly AutomationRuleRecord[],
  interaction: Pick<BraidInteraction, 'request' | 'runId'>,
  context: AutomationEvaluationContext,
): AutomationEvaluation {
  if (interactionHasSecretField(interaction.request))
    return {
      status: 'none',
      matchingRules: [],
      skippedRules: [],
      detail: 'AUTOMATION_SECRET_FORBIDDEN',
    }
  const matchingRules: StoredAutomationRule[] = []
  const skippedRules: AutomationEvaluation['skippedRules'][number][] = []
  for (const candidate of rules) {
    const rule = candidate as StoredAutomationRule
    if (!matches(rule.matcher, interaction.request, context)) continue
    if (!rule.enabled) {
      skippedRules.push({ rule, reason: 'disabled' })
      continue
    }
    if (isExpired(rule, context.now)) {
      skippedRules.push({ rule, reason: 'expired' })
      continue
    }
    if (rule.maximumUses !== undefined && rule.uses >= rule.maximumUses) {
      skippedRules.push({ rule, reason: 'use-limit' })
      continue
    }
    matchingRules.push(rule)
  }

  if (matchingRules.length === 0) {
    const reason = skippedRules[0]?.reason
    return {
      status: reason ?? 'none',
      matchingRules: [],
      skippedRules,
      ...(reason === undefined ? {} : { detail: `AUTOMATION_RULE_${reason.toUpperCase()}` }),
    }
  }

  const ordered = [...matchingRules].sort(compareRules)
  const topSpecificity = specificity(ordered[0]?.matcher ?? {})
  const top = ordered.filter((rule) => specificity(rule.matcher) === topSpecificity)
  const answerDigests = new Set(top.map((rule) => canonicalDigest(rule.answer)))
  const scopes = new Set(top.map((rule) => rule.responseScope))
  if (answerDigests.size > 1 || scopes.size > 1) {
    return {
      status: 'conflict',
      matchingRules: ordered,
      skippedRules,
      detail: 'AUTOMATION_RULE_CONFLICT',
    }
  }
  const rule = ordered[0]
  if (rule === undefined)
    return {
      status: 'none',
      matchingRules: [],
      skippedRules,
      detail: 'AUTOMATION_RULE_NONE',
    }
  return { status: 'eligible', rule, matchingRules: ordered, skippedRules }
}

export function automationSubjectValue(request: InteractionRequest): string | undefined {
  const subject = request.subject
  if (subject === undefined) return undefined
  switch (subject.type) {
    case 'tool':
      return subject.toolName
    case 'command':
      return subject.command
    case 'file':
      return subject.path
    case 'resource':
      return subject.uri
    default: {
      const exhaustive: never = subject
      return exhaustive
    }
  }
}

export function automationRuleScopeIsOffered(
  request: InteractionRequest,
  scope: AutomationRuleScope,
): boolean {
  const offered = new Set(request.responseScopes ?? ['interaction'])
  return offered.has(scope === 'once' ? 'interaction' : scope)
}

export function automationRuleAnswerDigest(rule: Pick<AutomationRuleRecord, 'answer'>): string {
  return canonicalDigest(rule.answer)
}

function matches(
  matcher: AutomationRuleMatcher & AutomationRuleRuleSession,
  request: InteractionRequest,
  context: AutomationEvaluationContext,
): boolean {
  if (matcher.interactionKind !== undefined && matcher.interactionKind !== request.kind)
    return false
  if (matcher.subjectType !== undefined && matcher.subjectType !== request.subject?.type)
    return false
  if (
    matcher.subjectValue !== undefined &&
    matcher.subjectValue !== automationSubjectValue(request)
  )
    return false
  if (!matchesValue(matcher.profileDigest, context.profileDigest)) return false
  if (!matchesValue(matcher.connectionId, context.connectionId)) return false
  if (!matchesValue(matcher.runner, context.runner)) return false
  if (!matchesValue(matcher.workspaceId, context.workspaceId)) return false
  if (!matchesValue(matcher.providerSessionId, context.providerSessionId)) return false
  return true
}

function matchesValue(expected: string | undefined, actual: string | undefined): boolean {
  return expected === undefined || (actual !== undefined && expected === actual)
}

function isExpired(rule: AutomationRuleRecord, now: string): boolean {
  return rule.expiresAt !== undefined && Date.parse(now) >= Date.parse(rule.expiresAt)
}

function specificity(matcher: AutomationRuleMatcher & AutomationRuleRuleSession): number {
  return Object.values(matcher).filter((value) => value !== undefined).length
}

function compareRules(left: StoredAutomationRule, right: StoredAutomationRule): number {
  const specificityDifference = specificity(right.matcher) - specificity(left.matcher)
  if (specificityDifference !== 0) return specificityDifference
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}
