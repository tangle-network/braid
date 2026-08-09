import type { InteractionResponse } from '@tangle-network/agent-interface'
import type { BraidEvent, BraidEventEnvelope } from '../domain/events.js'
import { canonicalDigest } from '../domain/canonical.js'
import type { FeedbackDecisionRecord } from '../domain/entities-graph.js'
import { createFeedbackDecisionId } from '../domain/ids.js'
import { effectRequestDigest } from './effect-coordinator.js'
import type { SerializedEffectCoordinator } from './effect-coordinator.js'
import { executeInteractionEffect, type InteractionEffectRequest } from './interaction-effects.js'
import {
  checkInteractionResponse,
  createInteractionResponseCommand,
} from './interaction-response.js'
import type { InteractionReceipt } from './application-types.js'
import type { JournalWriter, StateReader } from './application-ports.js'
import type { RunLedger } from './run-ledger.js'
import { findRun } from './run-status.js'
import type { ExecutionPort } from '../ports/execution.js'
import { AppError } from './errors.js'

export interface InteractionControllerInput {
  readonly operationId: string
  readonly runId: string
  readonly interactionId: string
  readonly response: InteractionResponse
  readonly state: StateReader
  readonly events: () => readonly BraidEventEnvelope[]
  readonly commitAndWait: JournalWriter['commitAndWait']
  readonly ledger: RunLedger
  readonly effects: SerializedEffectCoordinator
  readonly execution: ExecutionPort
  readonly owner: string
  readonly whenDurable: () => Promise<void>
  readonly now?: () => string
  readonly providerSessionId?: string
  readonly automated?: boolean
}

export async function respondInteraction(
  input: InteractionControllerInput,
): Promise<InteractionReceipt> {
  const run = findRun(input.state, input.runId)
  const interaction = run.interactions.find(
    (candidate) => candidate.request.id === input.interactionId,
  )
  if (!interaction)
    throw new AppError('UNKNOWN_INTERACTION', 'The interaction is no longer available')
  const checked = checkInteractionResponse(interaction.request, input.response)
  const request: InteractionEffectRequest = createInteractionResponseCommand(
    interaction.responseBinding,
    input.operationId,
    checked.response,
  )
  const digest = effectRequestDigest({ effectKind: 'interaction.respond', request })
  assertBinding(input, run, interaction.responseBinding)
  const recorded = recordedInteractionOperation(input.events(), input.operationId)
  if (recorded.conflict) throw new AppError('OPERATION_CONFLICT', recorded.conflict)
  if (recorded.requested !== undefined)
    assertRecordedInteractionMatchesInput(
      recorded.requested,
      input.runId,
      input.interactionId,
      input.operationId,
    )
  if (recorded.responded !== undefined)
    assertRecordedInteractionMatchesInput(
      recorded.responded,
      input.runId,
      input.interactionId,
      input.operationId,
    )
  const previous = input.ledger.getInteraction(input.operationId)
  if (previous) {
    if (previous.digest !== digest)
      throw new AppError('OPERATION_CONFLICT', `Operation ${input.operationId} has different input`)
    return {
      operationId: input.operationId,
      runId: input.runId,
      interactionId: input.interactionId,
      replayed: true,
      acknowledgement: { operationId: input.operationId, outcome: 'already-applied' },
      completion: previous.completion,
    }
  }
  const existing = input.effects.current(input.operationId)
  if (existing && existing.requestDigest !== digest)
    throw new AppError('OPERATION_CONFLICT', `Operation ${input.operationId} has different input`)
  if (recorded.responded !== undefined) {
    assertRecordedResponseMatches(recorded.responded, checked, input.operationId)
    const completion = Promise.resolve(input.state.currentState())
    input.ledger.setInteraction(input.operationId, { digest, completion })
    return {
      operationId: input.operationId,
      runId: input.runId,
      interactionId: input.interactionId,
      replayed: true,
      acknowledgement:
        recorded.responded.outcome === 'unknown'
          ? {
              operationId: input.operationId,
              outcome: 'unknown' as const,
              detail: recorded.responded.detail ?? 'INTERACTION_RESPONSE_REQUIRES_RECONCILIATION',
            }
          : { operationId: input.operationId, outcome: 'already-applied' as const },
      completion,
    }
  }
  const alreadyRequested = recorded.requested !== undefined
  if (alreadyRequested)
    assertRecordedResponseMatches(recorded.requested, checked, input.operationId)
  assertInteractionIsOpen(input, run, interaction.status)
  if (!alreadyRequested) {
    await input.commitAndWait({
      kind: 'run.interaction.response.requested',
      runId: input.runId,
      interactionId: input.interactionId,
      operationId: input.operationId,
      outcome: checked.response.outcome,
      ...(checked.dataDigest === undefined ? {} : { dataDigest: checked.dataDigest }),
      containsSecret: checked.containsSecret,
    })
  }
  const effectCompletion = executeInteractionEffect({
    effects: input.effects,
    execution: input.execution,
    request,
    owner: input.owner,
    whenDurable: input.whenDurable,
  })
  const completion = effectCompletion.then(async (result) => {
    await input.commitAndWait({
      kind: 'run.interaction.responded',
      runId: input.runId,
      interactionId: input.interactionId,
      operationId: input.operationId,
      outcome:
        result.outcome === 'accepted' || result.outcome === 'already-applied'
          ? checked.response.outcome
          : 'unknown',
      ...(checked.dataDigest === undefined ? {} : { dataDigest: checked.dataDigest }),
      containsSecret: checked.containsSecret,
      ...(result.detail === undefined ? {} : { detail: result.detail }),
    })
    if (
      (result.outcome === 'accepted' || result.outcome === 'already-applied') &&
      !checked.containsSecret
    ) {
      await input.commitAndWait({
        kind: 'feedback.decision.recorded',
        decision: feedbackDecision(input, run, checked.response, checked.dataDigest),
      })
    }
    return structuredClone(input.state.currentState())
  })
  input.ledger.setInteraction(input.operationId, { digest, completion })
  const acknowledgement = await effectCompletion
  return {
    operationId: input.operationId,
    runId: input.runId,
    interactionId: input.interactionId,
    replayed: existing !== undefined || alreadyRequested,
    acknowledgement,
    completion,
  }
}

function assertBinding(
  input: InteractionControllerInput,
  run: ReturnType<typeof findRun>,
  binding: import('@tangle-network/agent-interface').InteractionBinding,
): void {
  if (
    binding.runId !== input.runId ||
    binding.interactionId !== input.interactionId ||
    (run.providerSessionId !== undefined && binding.sessionId !== run.providerSessionId) ||
    (run.environmentId !== undefined && binding.environmentId !== run.environmentId) ||
    (run.receipt.provider !== undefined && binding.provider !== run.receipt.provider) ||
    (input.providerSessionId !== undefined && binding.sessionId !== input.providerSessionId)
  ) {
    throw new AppError(
      'INTERACTION_BINDING_MISMATCH',
      'The response belongs to a different run, provider session, or environment',
    )
  }
}

function assertInteractionIsOpen(
  input: InteractionControllerInput,
  run: ReturnType<typeof findRun>,
  status: string,
): void {
  if (currentInteractionExpired(input, run))
    throw new AppError('INTERACTION_EXPIRED', 'The interaction response window has expired')
  if (status !== 'pending' && status !== 'responding')
    throw new AppError('INTERACTION_STALE', `The interaction is already ${status}`)
  if (run.status === 'unknown' || run.status === 'expired' || run.status === 'cancelled')
    throw new AppError('INTERACTION_STALE', 'The run can no longer accept an interaction response')
}

export function isInteractionExpired(
  input: Pick<InteractionControllerInput, 'now'>,
  run: ReturnType<typeof findRun>,
  interaction: ReturnType<typeof findRun>['interactions'][number],
): boolean {
  const timeoutMs = interaction.request.timeoutMs
  if (timeoutMs === undefined) return false
  const startedAt = interaction.source.occurredAt ?? run.startedAt
  const now = input.now?.() ?? new Date().toISOString()
  const start = Date.parse(startedAt)
  const current = Date.parse(now)
  return Number.isFinite(start) && Number.isFinite(current) && current >= start + timeoutMs
}

function recordedInteractionOperation(
  events: readonly BraidEventEnvelope[],
  operationId: string,
): {
  readonly requested?: Extract<BraidEvent, { kind: 'run.interaction.response.requested' }>
  readonly responded?: Extract<BraidEvent, { kind: 'run.interaction.responded' }>
  readonly conflict?: string
} {
  let requested: Extract<BraidEvent, { kind: 'run.interaction.response.requested' }> | undefined
  let responded: Extract<BraidEvent, { kind: 'run.interaction.responded' }> | undefined
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

function assertRecordedResponseMatches(
  event: Extract<
    BraidEvent,
    { kind: 'run.interaction.response.requested' | 'run.interaction.responded' }
  >,
  checked: ReturnType<typeof checkInteractionResponse>,
  operationId: string,
): void {
  if (
    event.outcome !== checked.response.outcome ||
    (event.dataDigest ?? undefined) !== (checked.dataDigest ?? undefined)
  ) {
    throw new AppError('OPERATION_CONFLICT', `Operation ${operationId} has different input`)
  }
}

function assertRecordedInteractionMatchesInput(
  event: Extract<
    BraidEvent,
    { kind: 'run.interaction.response.requested' | 'run.interaction.responded' }
  >,
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

function currentInteractionExpired(
  input: InteractionControllerInput,
  run: ReturnType<typeof findRun>,
): boolean {
  const interaction = run.interactions.find(
    (candidate) => candidate.request.id === input.interactionId,
  )
  return interaction === undefined ? false : isInteractionExpired(input, run, interaction)
}

function feedbackDecision(
  input: InteractionControllerInput,
  run: ReturnType<typeof findRun>,
  response: InteractionResponse,
  dataDigest: string | undefined,
): FeedbackDecisionRecord {
  return {
    id: createFeedbackDecisionId(`feedback-${canonicalDigest(input.operationId).slice(0, 48)}`),
    conversationId: run.conversationId,
    category: response.outcome === 'accepted' ? 'approval' : 'rejection',
    chosenOption: chosenOption(response),
    ...(dataDigest === undefined ? {} : { feedback: `answer-digest:${dataDigest}` }),
    automated: input.automated === true,
    createdAt: input.now?.() ?? new Date().toISOString(),
  }
}

function chosenOption(response: InteractionResponse): string {
  if (response.outcome !== 'accepted') return response.outcome
  const grant = response.data?.grant
  if (Array.isArray(grant) && grant.length === 1) {
    const value = grant[0]
    if (value === 'allow_once') return 'allow_once'
    if (value === 'allow_session') return 'allow_session'
    if (value === 'allow_always') return 'allow_always'
    if (value === 'deny') return 'deny'
  }
  return 'accepted'
}
