import { canonicalDigest } from '../domain/canonical.js'
import type { AutomationAuditRecord, AutomationRuleScope } from '../domain/entities-interactions.js'
import type { BraidEventEnvelope } from '../domain/events.js'
import {
  createFeedbackDecisionId,
  createOperationId,
  type Digest,
  type RuleId,
} from '../domain/ids.js'
import type { BraidInteraction } from '../domain/runtime-projection.js'
import type { BraidState } from '../domain/state.js'
import {
  type AutomationEvaluation,
  type AutomationEvaluationContext,
  evaluateAutomation,
  type StoredAutomationRule,
} from './automation-matching.js'
import { reserveRuleUse } from './automation-rule-persistence.js'
import { commitAutomationEvent } from './automation-rule-store.js'
import type {
  ApplyAutomationInput,
  ApplyAutomationReceipt,
  AutomationDryRunInput,
  AutomationDryRunReceipt,
} from './automation-rule-types.js'
import {
  assertAutomationSafe,
  evaluationContext,
  interactionRequestDigest,
  requiredOperationId,
} from './automation-rule-validation.js'
import { AppError } from './errors.js'
import { checkInteractionResponse } from './interaction-response.js'

export async function dryRunAutomation(
  input: AutomationDryRunInput,
): Promise<AutomationDryRunReceipt> {
  const operationId = requiredOperationId(input.operationId)
  assertAutomationSafe(input.interaction.request)
  const context = evaluationContext(input.context, input.now?.() ?? new Date().toISOString())
  const commandDigest = canonicalDigest({
    kind: 'automation.rule.dry-run',
    interaction: interactionRequestDigest(input.interaction.request),
    context,
  })
  const prior = findAuditOperation(input.events(), operationId)
  if (prior !== undefined) {
    if (prior.requestDigest !== commandDigest)
      throw new AppError('OPERATION_CONFLICT', `Operation ${operationId} has different input`)
    return {
      operationId,
      replayed: true,
      evaluation: evaluationFromAudit(input.state(), input.interaction, context, prior),
      revision: input.state().revision,
    }
  }
  const evaluation = evaluateAutomation(input.state().rules, input.interaction, context)
  const audit = automationAudit({
    operationId,
    interaction: input.interaction,
    requestDigest: commandDigest,
    outcome: evaluation.status === 'eligible' ? 'dry-run' : auditOutcomeForEvaluation(evaluation),
    ...(evaluation.rule === undefined ? {} : { ruleId: evaluation.rule.id }),
    ...(evaluation.detail === undefined ? {} : { detail: evaluation.detail }),
    createdAt: context.now,
  })
  await commitAutomationEvent(input, { kind: 'interaction.automation.audited', audit })
  return {
    operationId,
    replayed: false,
    evaluation,
    revision: input.state().revision,
  }
}

export async function applyAutomation(
  input: ApplyAutomationInput,
): Promise<ApplyAutomationReceipt> {
  const operationId = requiredOperationId(input.operationId)
  assertAutomationSafe(input.interaction.request)
  const context = evaluationContext(input.context, input.now?.() ?? new Date().toISOString())
  const requestDigest = interactionRequestDigest(input.interaction.request)
  const prior = findAuditOperation(input.events(), operationId)
  if (prior !== undefined) {
    if (prior.requestDigest !== requestDigest)
      throw new AppError('OPERATION_CONFLICT', `Operation ${operationId} has different input`)
    return {
      operationId,
      replayed: true,
      evaluation: evaluateAutomation(input.state().rules, input.interaction, context),
      revision: input.state().revision,
    }
  }
  const evaluation = evaluateAutomation(input.state().rules, input.interaction, context)
  if (evaluation.status !== 'eligible' || evaluation.rule === undefined) {
    await commitAutomationEvent(input, {
      kind: 'interaction.automation.audited',
      audit: automationAudit({
        operationId,
        interaction: input.interaction,
        requestDigest,
        outcome: auditOutcomeForEvaluation(evaluation),
        ...(evaluation.rule === undefined ? {} : { ruleId: evaluation.rule.id }),
        ...(evaluation.detail === undefined ? {} : { detail: evaluation.detail }),
        createdAt: context.now,
      }),
    })
    return { operationId, replayed: false, evaluation, revision: input.state().revision }
  }

  const checked = checkInteractionResponse(input.interaction.request, {
    id: input.interaction.request.id,
    outcome: 'accepted',
    data: evaluation.rule.answer,
  })
  if (checked.containsSecret || checked.publicData === undefined)
    throw new AppError(
      'AUTOMATION_SECRET_FORBIDDEN',
      'Automation is unavailable for interactions containing secret answers',
    )
  const reserved = await reserveRuleUse(input, evaluation.rule, operationId, context.now)
  if (!reserved) {
    const refreshed = evaluateAutomation(input.state().rules, input.interaction, context)
    return { operationId, replayed: true, evaluation: refreshed, revision: input.state().revision }
  }
  const response = await input.respond(checked.response, { automated: true })
  const applied =
    response.acknowledgement.outcome === 'accepted' ||
    response.acknowledgement.outcome === 'already-applied'
  await commitAutomationEvent(input, {
    kind: 'interaction.automation.audited',
    audit: automationAudit({
      operationId,
      interaction: input.interaction,
      requestDigest,
      outcome: applied ? 'applied' : 'matched',
      ruleId: evaluation.rule.id,
      ...(checked.dataDigest === undefined ? {} : { responseDigest: checked.dataDigest }),
      responseScope: evaluation.rule.responseScope,
      ...(response.acknowledgement.detail === undefined
        ? {}
        : { detail: response.acknowledgement.detail }),
      createdAt: context.now,
    }),
  })
  return {
    operationId,
    replayed: response.replayed,
    evaluation,
    response,
    revision: input.state().revision,
  }
}

export function automationAudits(
  events: readonly BraidEventEnvelope[],
): readonly AutomationAuditRecord[] {
  return events.flatMap((envelope) =>
    envelope.event.kind === 'interaction.automation.audited' ? [envelope.event.audit] : [],
  )
}

function automationAudit(input: {
  readonly operationId?: string
  readonly interaction: BraidInteraction
  readonly requestDigest: Digest
  readonly responseDigest?: Digest
  readonly responseScope?: AutomationRuleScope
  readonly ruleId?: RuleId
  readonly outcome: AutomationAuditRecord['outcome']
  readonly detail?: string
  readonly createdAt: string
}): AutomationAuditRecord {
  const id = createFeedbackDecisionId(
    `feedback-${canonicalDigest({
      operationId: input.operationId ?? null,
      runId: input.interaction.runId,
      interactionId: input.interaction.request.id,
      requestDigest: input.requestDigest,
      ruleId: input.ruleId ?? null,
      outcome: input.outcome,
    }).slice(0, 48)}`,
  )
  return {
    id,
    runId: input.interaction.runId as AutomationAuditRecord['runId'],
    interactionId: input.interaction.request.id as AutomationAuditRecord['interactionId'],
    ...(input.ruleId === undefined ? {} : { ruleId: input.ruleId }),
    ...(input.operationId === undefined
      ? {}
      : { operationId: createOperationId(input.operationId) }),
    requestDigest: input.requestDigest,
    ...(input.responseDigest === undefined ? {} : { responseDigest: input.responseDigest }),
    ...(input.responseScope === undefined ? {} : { responseScope: input.responseScope }),
    outcome: input.outcome,
    ...(input.detail === undefined ? {} : { detail: safeAuditDetail(input.detail) }),
    createdAt: input.createdAt,
  }
}

function safeAuditDetail(value: string): string {
  return /^AUTOMATION_[A-Z0-9_]{1,96}$/u.test(value) ? value : 'AUTOMATION_RESPONSE_RESULT'
}

function findAuditOperation(
  events: readonly BraidEventEnvelope[],
  operationId: string,
): AutomationAuditRecord | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event
    if (event?.kind === 'interaction.automation.audited' && event.audit.operationId === operationId)
      return event.audit
  }
  return undefined
}

function evaluationFromAudit(
  state: BraidState,
  interaction: BraidInteraction,
  context: AutomationEvaluationContext,
  audit: AutomationAuditRecord,
): AutomationEvaluation {
  const current = evaluateAutomation(state.rules, interaction, context)
  if (audit.outcome !== 'dry-run') {
    const status = auditStatus(audit.outcome)
    if (status === undefined) return current
    const { rule: _rule, ...withoutRule } = current
    return { ...withoutRule, status }
  }
  if (audit.ruleId === undefined) return current
  const rule = state.rules.find((candidate) => candidate.id === audit.ruleId) as
    | StoredAutomationRule
    | undefined
  return rule === undefined ? current : { ...current, status: 'eligible', rule }
}

function auditStatus(
  outcome: AutomationAuditRecord['outcome'],
): AutomationEvaluation['status'] | undefined {
  switch (outcome) {
    case 'skipped':
      return 'none'
    case 'conflict':
      return 'conflict'
    case 'expired':
      return 'expired'
    case 'use-limit':
      return 'use-limit'
    case 'disabled':
      return 'disabled'
    default:
      return undefined
  }
}

function auditOutcomeForEvaluation(
  evaluation: AutomationEvaluation,
): AutomationAuditRecord['outcome'] {
  switch (evaluation.status) {
    case 'expired':
      return 'expired'
    case 'use-limit':
      return 'use-limit'
    case 'disabled':
      return 'disabled'
    case 'conflict':
      return 'conflict'
    case 'eligible':
      return 'matched'
    case 'none':
      return 'skipped'
    default: {
      const exhaustive: never = evaluation.status
      return exhaustive
    }
  }
}
