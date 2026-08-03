import { canonicalDigest } from '../domain/canonical.js'
import {
  answerSpecContainsSecret,
  canonicalInteractionData,
  validateInteractionData,
} from '../domain/interaction.js'
import type {
  AutomationAuditRecord,
  AutomationRuleMatcher,
  InteractionRecord,
} from '../domain/interaction-state.js'
import type { InteractionCapabilities } from '../domain/interaction-state.js'
import type { Clock } from '../ports/clock.js'
import { acceptedCapabilityError } from './interaction-response-policy.js'
import type { AutomationCandidate } from './interaction-controller-types.js'
import type { InteractionPersistence } from './interaction-persistence.js'

export class AutomationMatcher {
  readonly #persistence: InteractionPersistence
  readonly #clock: Clock
  readonly #capabilities: InteractionCapabilities
  readonly #getReservation: (ruleId: string) => number
  readonly #appendAudit: (input: Omit<AutomationAuditRecord, 'id'>) => void

  constructor(options: {
    readonly persistence: InteractionPersistence
    readonly clock: Clock
    readonly capabilities: InteractionCapabilities
    readonly getReservation: (ruleId: string) => number
    readonly appendAudit: (input: Omit<AutomationAuditRecord, 'id'>) => void
  }) {
    this.#persistence = options.persistence
    this.#clock = options.clock
    this.#capabilities = options.capabilities
    this.#getReservation = options.getReservation
    this.#appendAudit = options.appendAudit
  }

  candidates(record: InteractionRecord, dryRun: boolean): readonly AutomationCandidate[] {
    if (answerSpecContainsSecret(record.request.answerSpec)) {
      this.#appendAudit({
        interactionKey: record.key,
        kind: record.request.kind,
        outcome: 'secret-rejected',
        reason: 'Secret answer specification is manual-only',
        createdAt: this.#clock.now(),
      })
      return []
    }
    const state = this.#persistence.state()
    const now = Date.parse(this.#clock.now())
    return state.rules
      .slice()
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
      .map((rule) => {
        let eligible = true
        let reason: string | undefined
        if (!rule.enabled) {
          eligible = false
          reason = 'Rule is disabled'
        } else if (rule.expiresAt && Number.isFinite(now) && Date.parse(rule.expiresAt) <= now) {
          eligible = false
          reason = 'Rule is expired'
        } else if (rule.maximumUses !== undefined && rule.uses >= rule.maximumUses) {
          eligible = false
          reason = 'Rule use limit reached'
        } else if (
          rule.maximumUses !== undefined &&
          rule.uses + this.#getReservation(rule.id) >= rule.maximumUses
        ) {
          eligible = false
          reason = 'Rule use limit reached'
        } else if (
          rule.responseScope === 'once' &&
          rule.uses + this.#getReservation(rule.id) >= 1
        ) {
          eligible = false
          reason = 'One-time rule already used'
        } else if (rule.interactionKey !== undefined && rule.interactionKey !== record.key) {
          eligible = false
          reason = 'Interaction is outside the rule scope'
        } else if (!matches(rule.matcher, record)) {
          eligible = false
          reason = 'Interaction is outside the rule scope'
        } else {
          const validation = validateInteractionData(
            record.request.answerSpec,
            'accepted',
            canonicalInteractionData(rule.answer),
          )
          if (!validation.ok || validation.containsSecret) {
            eligible = false
            reason = 'Rule answer is not valid for this request'
          } else {
            const capabilityError = acceptedCapabilityError(
              state,
              record,
              {
                id: record.interactionId,
                outcome: 'accepted',
                data: canonicalInteractionData(validation.publicData),
              },
              validation.publicData,
              this.#capabilities,
            )
            if (capabilityError) {
              eligible = false
              reason = capabilityError
            }
          }
        }
        if (!dryRun && !eligible) {
          this.#appendAudit({
            interactionKey: record.key,
            ruleId: rule.id,
            kind: record.request.kind,
            outcome:
              reason === 'Rule is expired'
                ? 'expired'
                : reason === 'Rule use limit reached' || reason === 'One-time rule already used'
                  ? 'use-limit'
                  : 'skipped',
            ...(reason === undefined ? {} : { reason }),
            createdAt: this.#clock.now(),
          })
        }
        return {
          ruleId: rule.id,
          eligible,
          ...(reason === undefined ? {} : { reason }),
          responseScope: rule.responseScope,
        }
      })
  }

  ruleMatcherFor(record: InteractionRecord): AutomationRuleMatcher {
    return matcherForRequest(record.request, {
      ...(record.profileDigest === undefined ? {} : { profileDigest: record.profileDigest }),
      ...(record.connectionId === undefined ? {} : { connectionId: record.connectionId }),
      ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
      ...(record.runner === undefined ? {} : { runner: record.runner }),
      ...(record.providerSessionId === undefined
        ? {}
        : { providerSessionId: record.providerSessionId }),
    })
  }

  matcherForRequest(
    request: InteractionRecord['request'],
    context: {
      readonly profileDigest?: string
      readonly connectionId?: string
      readonly workspaceId?: string
      readonly runner?: string
      readonly providerSessionId?: string
    },
  ): AutomationRuleMatcher {
    return matcherForRequest(request, context)
  }
}

function subjectValue(record: InteractionRecord): string | undefined {
  const subject = record.request.subject
  if (!subject) return undefined
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

function matcherForRequest(
  request: InteractionRecord['request'],
  context: {
    readonly profileDigest?: string
    readonly connectionId?: string
    readonly workspaceId?: string
    readonly runner?: string
    readonly providerSessionId?: string
  },
): AutomationRuleMatcher {
  const subject = request.subject
  const value = subject
    ? subject.type === 'tool'
      ? subject.toolName
      : subject.type === 'command'
        ? subject.command
        : subject.type === 'file'
          ? subject.path
          : subject.uri
    : undefined
  return {
    interactionKind: request.kind,
    ...(subject === undefined
      ? {}
      : { subjectType: subject.type, ...(value === undefined ? {} : { subjectValue: value }) }),
    ...(context.profileDigest === undefined ? {} : { profileDigest: context.profileDigest }),
    ...(context.connectionId === undefined ? {} : { connectionId: context.connectionId }),
    ...(context.workspaceId === undefined ? {} : { workspaceId: context.workspaceId }),
    ...(context.runner === undefined ? {} : { runner: context.runner }),
    ...(context.providerSessionId === undefined
      ? {}
      : { providerSessionId: context.providerSessionId }),
  }
}

export function withoutProviderSession(matcher: AutomationRuleMatcher): AutomationRuleMatcher {
  const { providerSessionId: _providerSessionId, ...withoutSession } = matcher
  return withoutSession
}

function matches(matcher: AutomationRuleMatcher, record: InteractionRecord): boolean {
  const subject = record.request.subject
  if (matcher.interactionKind !== undefined && matcher.interactionKind !== record.request.kind)
    return false
  if (matcher.subjectType !== undefined && matcher.subjectType !== subject?.type) return false
  if (matcher.subjectValue !== undefined && matcher.subjectValue !== subjectValue(record))
    return false
  if (matcher.profileDigest !== undefined && matcher.profileDigest !== record.profileDigest)
    return false
  if (matcher.connectionId !== undefined && matcher.connectionId !== record.connectionId)
    return false
  if (matcher.workspaceId !== undefined && matcher.workspaceId !== record.workspaceId) return false
  if (matcher.runner !== undefined && matcher.runner !== record.runner) return false
  if (
    matcher.providerSessionId !== undefined &&
    matcher.providerSessionId !== record.providerSessionId
  )
    return false
  return true
}

export function answerDigest(answer: unknown): string {
  return canonicalDigest(answer)
}
