import type { InteractionRequest } from '@tangle-network/agent-interface'
import { canonicalDigest } from '../domain/canonical.js'
import type { AutomationRuleScope } from '../domain/entities-interactions.js'
import type { AutomationRuleMatcher } from '../domain/entities-runtime.js'
import { createOperationId, createRuleId, type Digest, type RuleId } from '../domain/ids.js'
import { AppError } from './errors.js'
import {
  automationRuleAnswerDigest,
  automationRuleScopeIsOffered,
  automationSubjectValue,
  type StoredAutomationRule,
} from './automation-matching.js'
import { checkInteractionResponse, interactionHasSecretField } from './interaction-response.js'
import { parseInteractionRequest } from './interaction-request.js'
import type { AutomationContext, CreateAutomationRuleInput } from './automation-rule-types.js'

export interface NormalizedAutomationRule {
  readonly operationId: string
  readonly ruleId: RuleId
  readonly rule: StoredAutomationRule
  readonly digest: Digest
  readonly now: string
}

export function normalizeAutomationRule(
  input: CreateAutomationRuleInput,
): NormalizedAutomationRule {
  const operationId = requiredOperationId(input.operationId)
  const request = parseRequest(input.request)
  assertAutomationSafe(request)
  const ruleId = parseRuleId(input.ruleId)
  assertAutomationScope(request, input.responseScope, input.confirmPersistent === true)
  const checked = checkInteractionResponse(request, {
    id: request.id,
    outcome: 'accepted',
    data: input.answer,
  })
  if (checked.containsSecret || checked.publicData === undefined)
    throw new AppError(
      'AUTOMATION_SECRET_FORBIDDEN',
      'Automation is unavailable for interactions containing secret answers',
    )
  const now = input.now?.() ?? new Date().toISOString()
  assertExpiry(input.expiresAt, now)
  assertMaximumUses(input.maximumUses)
  const matcher = buildMatcher(request, input.matcher, input.context, input.responseScope)
  assertScopeContext(input.responseScope, matcher)
  const rule: StoredAutomationRule = {
    id: ruleId,
    enabled: true,
    matcher,
    answer: structuredClone(checked.publicData),
    responseScope: input.responseScope,
    createdAt: now,
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    ...(input.maximumUses === undefined ? {} : { maximumUses: input.maximumUses }),
    uses: 0,
    ...(input.creationSource === undefined && input.context?.providerSessionId === undefined
      ? {}
      : {
          automationMetadata: {
            ...(input.creationSource === undefined ? {} : { creationSource: input.creationSource }),
            ...(input.context?.providerSessionId === undefined
              ? {}
              : { providerSessionId: input.context.providerSessionId }),
          },
        }),
  }
  const requestDigest = interactionRequestDigest(request)
  const digest = canonicalDigest({
    kind: 'automation.rule.create',
    ruleId,
    requestDigest,
    matcher,
    answerDigest: automationRuleAnswerDigest(rule),
    responseScope: rule.responseScope,
    expiresAt: rule.expiresAt ?? null,
    maximumUses: rule.maximumUses ?? null,
  })
  return { operationId, ruleId, rule, digest, now }
}

export function assertAutomationSafe(request: InteractionRequest): void {
  if (interactionHasSecretField(request))
    throw new AppError(
      'AUTOMATION_SECRET_FORBIDDEN',
      'Automation is unavailable for interactions containing secret answers',
    )
}

export function assertOperationDigest(
  prior: { readonly requestDigest: Digest },
  digest: Digest,
  operationId: string,
): void {
  if (prior.requestDigest !== digest)
    throw new AppError('OPERATION_CONFLICT', `Operation ${operationId} has different input`)
}

export function requiredOperationId(value: string): string {
  if (!value) throw new AppError('INVALID_OPERATION_ID', 'Automation operationId is required')
  try {
    createOperationId(value)
  } catch {
    throw new AppError('INVALID_OPERATION_ID', 'Automation operationId is invalid')
  }
  return value
}

export function parseRuleId(value: string): RuleId {
  try {
    return createRuleId(value)
  } catch {
    throw new AppError('INVALID_AUTOMATION_RULE', 'Automation rule id is invalid')
  }
}

export function evaluationContext(
  context: AutomationContext,
  now: string,
): import('./automation-matching.js').AutomationEvaluationContext {
  return { ...context, now }
}

export function interactionRequestDigest(request: InteractionRequest): Digest {
  return canonicalDigest({
    id: request.id,
    kind: request.kind,
    title: request.title,
    body: request.body ?? null,
    subject:
      request.subject === undefined
        ? null
        : { type: request.subject.type, value: automationSubjectValue(request) ?? null },
    answerSpec: request.answerSpec,
    responseScopes: request.responseScopes ?? ['interaction'],
    timeoutMs: request.timeoutMs ?? null,
    onTimeout: request.onTimeout ?? null,
  })
}

function parseRequest(value: InteractionRequest): InteractionRequest {
  const parsed = parseInteractionRequest(value)
  if (parsed === undefined)
    throw new AppError('INVALID_INTERACTION_REQUEST', 'Interaction request is invalid')
  return parsed
}

function assertAutomationScope(
  request: InteractionRequest,
  scope: AutomationRuleScope,
  confirmedPersistent: boolean,
): void {
  if (!automationRuleScopeIsOffered(request, scope))
    throw new AppError(
      'AUTOMATION_SCOPE_UNSUPPORTED',
      `The interaction does not offer ${scope} responses`,
    )
  if (scope === 'persistent' && !confirmedPersistent)
    throw new AppError(
      'AUTOMATION_CONFIRMATION_REQUIRED',
      'Persistent automation requires explicit confirmation of its scope',
    )
}

function assertScopeContext(
  scope: AutomationRuleScope,
  matcher: AutomationRuleMatcher & { readonly providerSessionId?: string },
): void {
  if (scope === 'session' && matcher.providerSessionId === undefined)
    throw new AppError(
      'AUTOMATION_SCOPE_CONTEXT_REQUIRED',
      'Session automation requires an exact provider session binding',
    )
  if (
    scope === 'persistent' &&
    matcher.profileDigest === undefined &&
    matcher.connectionId === undefined &&
    matcher.runner === undefined &&
    matcher.workspaceId === undefined
  )
    throw new AppError(
      'AUTOMATION_SCOPE_CONTEXT_REQUIRED',
      'Persistent automation requires an explicit profile, connection, runner, or workspace scope',
    )
}

function assertExpiry(expiresAt: string | undefined, now: string): void {
  if (expiresAt === undefined) return
  const expires = Date.parse(expiresAt)
  if (!Number.isFinite(expires) || expires <= Date.parse(now))
    throw new AppError('AUTOMATION_EXPIRY_INVALID', 'Automation expiry must be in the future')
}

function assertMaximumUses(maximumUses: number | undefined): void {
  if (
    maximumUses !== undefined &&
    (!Number.isInteger(maximumUses) || maximumUses < 1 || maximumUses > 1_000_000)
  )
    throw new AppError(
      'AUTOMATION_USE_LIMIT_INVALID',
      'Automation use limit must be a positive integer',
    )
}

function buildMatcher(
  request: InteractionRequest,
  matcher: AutomationRuleMatcher | undefined,
  context: AutomationContext | undefined,
  responseScope: AutomationRuleScope,
): AutomationRuleMatcher & { readonly providerSessionId?: string } {
  const subjectValue = automationSubjectValue(request)
  assertMatcherIdentity(request, matcher)
  const base = {
    interactionKind: request.kind,
    ...(request.subject === undefined ? {} : { subjectType: request.subject.type }),
    ...(subjectValue === undefined ? {} : { subjectValue }),
    ...(context?.profileDigest === undefined ? {} : { profileDigest: context.profileDigest }),
    ...(context?.connectionId === undefined ? {} : { connectionId: context.connectionId }),
    ...(context?.runner === undefined ? {} : { runner: context.runner }),
    ...(context?.workspaceId === undefined ? {} : { workspaceId: context.workspaceId }),
    ...(responseScope === 'session' && context?.providerSessionId === undefined
      ? {}
      : responseScope === 'session'
        ? { providerSessionId: context?.providerSessionId }
        : {}),
  }
  return {
    ...base,
    ...(matcher?.profileDigest === undefined && context?.profileDigest === undefined
      ? {}
      : { profileDigest: matcher?.profileDigest ?? context?.profileDigest }),
    ...(matcher?.connectionId === undefined && context?.connectionId === undefined
      ? {}
      : { connectionId: matcher?.connectionId ?? context?.connectionId }),
    ...(matcher?.runner === undefined && context?.runner === undefined
      ? {}
      : { runner: matcher?.runner ?? context?.runner }),
    ...(matcher?.workspaceId === undefined && context?.workspaceId === undefined
      ? {}
      : { workspaceId: matcher?.workspaceId ?? context?.workspaceId }),
  } as AutomationRuleMatcher & {
    readonly providerSessionId?: string
  }
}

function assertMatcherIdentity(
  request: InteractionRequest,
  matcher: AutomationRuleMatcher | undefined,
): void {
  if (matcher?.interactionKind !== undefined && matcher.interactionKind !== request.kind)
    throw new AppError(
      'AUTOMATION_MATCHER_CONFLICT',
      'An automation matcher cannot target another interaction kind',
    )
  const subject = request.subject
  if (matcher?.subjectType !== undefined && matcher.subjectType !== subject?.type)
    throw new AppError(
      'AUTOMATION_MATCHER_CONFLICT',
      'An automation matcher cannot target another subject type',
    )
  const subjectValue = automationSubjectValue(request)
  if (matcher?.subjectValue !== undefined && matcher.subjectValue !== subjectValue)
    throw new AppError(
      'AUTOMATION_MATCHER_CONFLICT',
      'An automation matcher cannot target another subject value',
    )
}
