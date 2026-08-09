import type { BraidEvent, BraidEventEnvelope } from '../domain/events.js'
import type { BraidInteraction } from '../domain/runtime-projection.js'
import { AppError } from './errors.js'
import type { checkInteractionResponse } from './interaction-response.js'

type RecordedInteractionEvent = Extract<
  BraidEvent,
  { kind: 'run.interaction.response.requested' | 'run.interaction.responded' }
>

export interface RecordedInteractionOperation {
  readonly requested?: Extract<BraidEvent, { kind: 'run.interaction.response.requested' }>
  readonly responded?: Extract<BraidEvent, { kind: 'run.interaction.responded' }>
  readonly conflict?: string
}

export function recordedInteractionOperation(
  events: readonly BraidEventEnvelope[],
  operationId: string,
): RecordedInteractionOperation {
  let requested: RecordedInteractionOperation['requested']
  let responded: RecordedInteractionOperation['responded']
  for (const envelope of events) {
    const event = envelope.event
    if (
      (event.kind !== 'run.interaction.response.requested' &&
        event.kind !== 'run.interaction.responded') ||
      event.operationId !== operationId
    )
      continue
    if (event.kind === 'run.interaction.response.requested') {
      if (
        requested !== undefined &&
        (requested.runId !== event.runId || requested.interactionId !== event.interactionId)
      )
        return { conflict: `Operation ${operationId} was used for two interactions` }
      requested = event
    } else {
      if (
        responded !== undefined &&
        (responded.runId !== event.runId || responded.interactionId !== event.interactionId)
      )
        return { conflict: `Operation ${operationId} was used for two interactions` }
      responded = event
    }
  }
  return {
    ...(requested === undefined ? {} : { requested }),
    ...(responded === undefined ? {} : { responded }),
  }
}

export function recordedInteractionOwner(
  events: readonly BraidEventEnvelope[],
  runId: string,
  interactionId: string,
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event
    if (
      event?.kind === 'run.interaction.response.requested' &&
      event.runId === runId &&
      event.interactionId === interactionId
    )
      return event.operationId
  }
  return undefined
}

export function assertRecordedResponseMatches(
  event: RecordedInteractionEvent,
  checked: ReturnType<typeof checkInteractionResponse>,
  operationId: string,
): void {
  if (
    event.outcome !== checked.response.outcome ||
    (event.dataDigest ?? undefined) !== (checked.dataDigest ?? undefined)
  )
    throw new AppError('OPERATION_CONFLICT', `Operation ${operationId} has different input`)
}

export function assertRecordedInteractionMatchesInput(
  event: RecordedInteractionEvent,
  runId: string,
  interactionId: string,
  operationId: string,
): void {
  if (event.runId !== runId || event.interactionId !== interactionId)
    throw new AppError(
      'OPERATION_CONFLICT',
      `Operation ${operationId} was used for another interaction`,
    )
}

export function assertDurableResponseMatches(
  response: NonNullable<BraidInteraction['responseOperation']>,
  checked: ReturnType<typeof checkInteractionResponse>,
  operationId: string,
): void {
  if (
    response.outcome !== checked.response.outcome ||
    (response.dataDigest ?? undefined) !== (checked.dataDigest ?? undefined) ||
    response.containsSecret !== checked.containsSecret
  )
    throw new AppError('OPERATION_CONFLICT', `Operation ${operationId} has different input`)
}
