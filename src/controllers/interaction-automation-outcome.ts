import type { Clock } from '../ports/clock.js'
import type { IdSource } from '../ports/ids.js'
import type { InteractionStatus } from '../domain/interaction-state.js'
import { lengthDelimitedIdentity } from '../domain/identity.js'
import type { InteractionPersistence } from './interaction-persistence.js'

const TERMINAL_STATUSES: readonly InteractionStatus[] = [
  'resolved',
  'declined',
  'cancelled',
  'expired',
  'conflict',
  'identity_conflict',
  'unsupported',
]

export function finalizeAutomationOutcomes(
  persistence: InteractionPersistence,
  clock: Clock,
  ids: IdSource,
): void {
  const state = persistence.state()
  const finalized = new Set<string>()
  for (const matched of state.audits) {
    if (matched.outcome !== 'matched' || !matched.ruleId || !matched.interactionKey) continue
    const identity = lengthDelimitedIdentity(matched.interactionKey, matched.ruleId)
    if (finalized.has(identity)) continue
    const interaction = state.interactions.find((item) => item.key === matched.interactionKey)
    if (!interaction || !TERMINAL_STATUSES.includes(interaction.status)) continue
    if (
      state.audits.some(
        (audit) =>
          audit.interactionKey === matched.interactionKey &&
          audit.ruleId === matched.ruleId &&
          (audit.outcome === 'applied' || audit.outcome === 'skipped'),
      )
    ) {
      finalized.add(identity)
      continue
    }
    const applied =
      interaction.status === 'resolved' && interaction.resolution?.outcome === 'accepted'
    const audit = {
      id: ids.next('audit'),
      interactionKey: matched.interactionKey,
      ruleId: matched.ruleId,
      kind: interaction.request.kind,
      outcome: applied ? ('applied' as const) : ('skipped' as const),
      ...(applied ? {} : { reason: `Provider outcome was ${interaction.status}` }),
      createdAt: clock.now(),
    }
    persistence.commit(
      applied
        ? { kind: 'automation.rule.applied', ruleId: matched.ruleId, audit }
        : { kind: 'automation.audit.recorded', audit },
    )
    finalized.add(identity)
  }
}
