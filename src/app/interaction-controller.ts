import type { InteractionResponse } from '@tangle-network/agent-interface'
import { canonicalDigest } from '../domain/canonical.js'
import type { FeedbackDecisionRecord } from '../domain/entities-graph.js'
import type { AutomationRuleRecord } from '../domain/entities-runtime.js'
import type { BraidEventEnvelope } from '../domain/events.js'
import { createFeedbackDecisionId } from '../domain/ids.js'
import { interactionRemainingMs } from '../domain/interaction-timeout.js'
import { type ExecutionPort, supportsInteractionResponse } from '../ports/execution.js'
import type { JournalWriter, StateReader } from './application-ports.js'
import type { InteractionReceipt } from './application-types.js'
import type { SerializedEffectCoordinator } from './effect-coordinator.js'
import { effectRequestDigest } from './effect-coordinator.js'
import { AppError } from './errors.js'
import { executeInteractionEffect, type InteractionEffectRequest } from './interaction-effects.js'
import {
  checkInteractionResponse,
  createInteractionResponseCommand,
} from './interaction-response.js'
import {
  assertDurableResponseMatches,
  assertRecordedInteractionMatchesInput,
  assertRecordedResponseMatches,
  recordedInteractionOperation,
  recordedInteractionOwner,
} from './interaction-response-replay.js'
import type { RunLedger } from './run-ledger.js'
import { retainedExecutionRecoveryContext } from './run-recovery-context.js'
import { findRun } from './run-status.js'

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
  readonly responseTimeoutMs: number
  readonly whenDurable: () => Promise<void>
  readonly now?: () => string
  readonly providerSessionId?: string
  readonly automationRule?: AutomationRuleRecord
}

export async function respondInteraction(
  input: InteractionControllerInput,
): Promise<InteractionReceipt> {
  let run = findRun(input.state, input.runId)
  let interaction = run.interactions.find(
    (candidate) => candidate.request.id === input.interactionId,
  )
  if (!interaction)
    throw new AppError('UNKNOWN_INTERACTION', 'The interaction is no longer available')
  const checked = checkInteractionResponse(interaction.request, input.response)
  const providerResponse = {
    ...checked.response,
    id: interaction.responseBinding.interactionId,
  }
  const request: InteractionEffectRequest = createInteractionResponseCommand(
    interaction.responseBinding,
    input.operationId,
    providerResponse,
  )
  const digest = effectRequestDigest({ effectKind: 'interaction.respond', request })
  assertBinding(input, run, interaction.responseBinding)
  let recorded = recordedInteractionOperation(input.events(), input.operationId)
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
  let durableRequest = interaction.responseOperation
  let retryUnknown = durableRequest?.outcome === 'unknown'
  const previous = input.ledger.getInteraction(input.operationId)
  if (previous) {
    if (previous.digest !== digest)
      throw new AppError('OPERATION_CONFLICT', `Operation ${input.operationId} has different input`)
    await previous.completion
    run = findRun(input.state, input.runId)
    interaction = run.interactions.find((candidate) => candidate.request.id === input.interactionId)
    if (!interaction)
      throw new AppError('UNKNOWN_INTERACTION', 'The interaction is no longer available')
    durableRequest = interaction.responseOperation
    retryUnknown = durableRequest?.outcome === 'unknown'
    recorded = recordedInteractionOperation(input.events(), input.operationId)
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
    if (recorded.responded === undefined)
      throw new AppError(
        'OPERATION_REQUIRES_RECONCILIATION',
        `Operation ${input.operationId} has no durable interaction result`,
      )
    if (recorded.responded.outcome !== 'unknown') {
      assertRecordedResponseMatches(recorded.responded, checked, input.operationId)
      return {
        operationId: input.operationId,
        runId: input.runId,
        interactionId: input.interactionId,
        replayed: true,
        acknowledgement: { operationId: input.operationId, outcome: 'already-applied' },
        completion: previous.completion,
      }
    }
    retryUnknown = true
  }
  const existing = input.effects.current(input.operationId)
  if (existing && existing.requestDigest !== digest)
    throw new AppError('OPERATION_CONFLICT', `Operation ${input.operationId} has different input`)
  const requestedOutcome = recorded.requested?.outcome ?? durableRequest?.requestedOutcome
  if (recorded.responded !== undefined) {
    retryUnknown ||= recorded.responded.outcome === 'unknown'
    assertRecordedResponseMatches(recorded.responded, checked, input.operationId, {
      allowUnknownOutcome: retryUnknown,
      ...(requestedOutcome === undefined ? {} : { requestedOutcome }),
    })
    if (recorded.responded.outcome !== 'unknown') {
      const completion = Promise.resolve(input.state.currentState())
      input.ledger.setInteraction(input.operationId, { digest, completion })
      return {
        operationId: input.operationId,
        runId: input.runId,
        interactionId: input.interactionId,
        replayed: true,
        acknowledgement: { operationId: input.operationId, outcome: 'already-applied' as const },
        completion,
      }
    }
  }
  if (durableRequest !== undefined && durableRequest.operationId === input.operationId)
    assertDurableResponseMatches(durableRequest, checked, input.operationId, {
      allowUnknownOutcome: retryUnknown,
      ...(requestedOutcome === undefined ? {} : { requestedOutcome }),
    })
  if (!supportsInteractionResponse(run.receipt.capabilities))
    throw new AppError(
      'CAPABILITY_UNAVAILABLE',
      'The current runtime cannot acknowledge interaction responses',
    )
  if (input.execution.respondInteraction === undefined)
    throw new AppError(
      'CAPABILITY_UNAVAILABLE',
      'The current runtime cannot acknowledge interaction responses',
    )
  const alreadyRequested =
    recorded.requested !== undefined || durableRequest?.operationId === input.operationId
  if (recorded.requested !== undefined)
    assertRecordedResponseMatches(recorded.requested, checked, input.operationId)
  assertInteractionIsOpen(input, run, interaction.status, retryUnknown)
  const owner =
    durableRequest?.operationId ??
    recordedInteractionOwner(input.events(), input.runId, input.interactionId)
  if (owner !== undefined && owner !== input.operationId)
    throw new AppError(
      'INTERACTION_RESPONSE_IN_PROGRESS',
      `Interaction ${input.interactionId} already has a response operation`,
    )
  if (!alreadyRequested) {
    await input.commitAndWait({
      kind: 'run.interaction.response.requested',
      runId: input.runId,
      interactionId: input.interactionId,
      operationId: input.operationId,
      outcome: checked.response.outcome,
      ...(checked.dataDigest === undefined ? {} : { dataDigest: checked.dataDigest }),
      containsSecret: checked.containsSecret,
      ...(input.automationRule === undefined ? {} : { automationRule: input.automationRule }),
    })
  }
  const effectCompletion = executeInteractionEffect({
    effects: input.effects,
    execution: input.execution,
    request,
    owner: input.owner,
    timeoutMs: input.responseTimeoutMs,
    whenDurable: input.whenDurable,
    recovery: retainedExecutionRecoveryContext(run, input.state.currentState().workspace),
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
  const exact = run.controlRef
  if (
    binding.runId !== input.runId ||
    (exact !== undefined &&
      (binding.runId !== exact.runId ||
        binding.provider !== exact.provider ||
        binding.environmentId !== exact.environmentId ||
        binding.sessionId !== exact.sessionId ||
        binding.executionId !== exact.executionId)) ||
    (exact === undefined &&
      run.providerSessionId !== undefined &&
      binding.sessionId !== run.providerSessionId) ||
    (exact === undefined &&
      run.receipt.provider !== undefined &&
      binding.provider !== run.receipt.provider) ||
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
  allowUnknownResponseRetry = false,
): void {
  if (currentInteractionExpired(input, run))
    throw new AppError('INTERACTION_EXPIRED', 'The interaction response window has expired')
  if (
    status !== 'pending' &&
    status !== 'responding' &&
    !(allowUnknownResponseRetry && status === 'unknown')
  )
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
  const now = input.now?.() ?? new Date().toISOString()
  return interactionRemainingMs(timeoutMs, interaction.source.occurredAt, run.startedAt, now) === 0
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
    automated: input.automationRule !== undefined,
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
