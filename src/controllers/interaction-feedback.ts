import type { Clock } from '../ports/clock.js'
import type { IdSource } from '../ports/ids.js'
import type {
  FeedbackDecisionCategory,
  FeedbackDecisionRecord,
  InteractionRecord,
} from '../domain/interaction-state.js'
import type { InteractionOutcome } from '../domain/interaction.js'
import type { InteractionPersistence } from './interaction-persistence.js'

export function recordInteractionFeedback(options: {
  readonly persistence: InteractionPersistence
  readonly clock: Clock
  readonly ids: IdSource
  readonly enabled: boolean
  readonly record: InteractionRecord
  readonly outcome: InteractionOutcome
  readonly automated: boolean
  readonly dataDigest?: string
  readonly publicData: Readonly<Record<string, string | number | boolean | readonly string[]>>
}): void {
  if (
    !options.enabled ||
    options.record.request.answerSpec.fields.some((field) => field.type === 'secret')
  )
    return
  const decision: FeedbackDecisionRecord = {
    id: options.ids.next('feedback'),
    interactionKey: options.record.key,
    runId: options.record.runId,
    interactionId: options.record.interactionId,
    category: categoryFor(options.record, options.outcome),
    chosenOption: options.outcome,
    ...(options.dataDigest === undefined ? {} : { dataDigest: options.dataDigest }),
    ...(typeof options.publicData.feedback === 'string'
      ? { feedback: options.publicData.feedback.slice(0, 4_096) }
      : {}),
    automated: options.automated,
    containsSecret: false,
    createdAt: options.clock.now(),
  }
  options.persistence.commit({ kind: 'feedback.decision.recorded', decision })
}

function categoryFor(
  record: InteractionRecord,
  outcome: InteractionOutcome,
): FeedbackDecisionCategory {
  if (record.request.kind === 'permission') return outcome === 'accepted' ? 'approval' : 'rejection'
  if (record.request.kind === 'plan') return outcome === 'accepted' ? 'approval' : 'revision'
  return outcome === 'accepted' ? 'selection' : 'rejection'
}
