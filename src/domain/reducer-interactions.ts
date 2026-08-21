import { canonicalDigest } from './canonical.js'
import { reserveText } from './content-budget.js'
import type { BraidEvent } from './events.js'
import { createOperationId } from './ids.js'
import { DomainInvariantError } from './invariants-base.js'
import { assertAutomationRuleRecord } from './invariants-runtime.js'
import { safePublicIdentifier } from './provider-values.js'
import {
  activity,
  addActivity,
  assertTerminalTransition,
  findRun,
  MAX_RUN_EVENT_DETAILS,
  MAX_RUN_INTERACTIONS,
  type ReducerBase,
  sourceFromProvider,
  TERMINAL_RUN_STATES,
  terminalMessageStatus,
  terminalPartStatus,
  updateMessage,
  updateRun,
  upsertPart,
  withPendingInteractionIndex,
  withProviderProgress,
} from './reducer-support.js'
import { finalizeRunUsage } from './run-usage.js'
import type { BraidInteraction, BraidState } from './state.js'

type InteractionEvent = Extract<
  BraidEvent,
  {
    kind:
      | 'run.interaction'
      | 'run.interaction.cancelled'
      | 'run.interaction.response.requested'
      | 'run.interaction.responded'
      | 'run.status.changed'
      | 'run.provider.event'
      | 'run.finished'
  }
>

export function reduceInteractionEvent(
  state: BraidState,
  event: InteractionEvent,
  base: ReducerBase,
): BraidState {
  switch (event.kind) {
    case 'run.interaction': {
      const run = findRun(state, event.runId)
      const source = sourceFromProvider(event.provider) ?? {}
      const existing = run.interactions.find((item) => item.request.id === event.request.id)
      if (existing !== undefined) {
        if (!sameInteractionEvent(existing, event.request, event.responseBinding, source)) {
          throw interactionInvariant(
            `Interaction ${event.request.id} was requested with different data`,
          )
        }
        return {
          ...state,
          ...base,
          runs: updateRun(state, event.runId, (candidate) =>
            withProviderProgress(candidate, event.provider),
          ),
        }
      }
      if (run.pendingInteractionIds?.includes(event.request.id)) {
        throw interactionInvariant(`Interaction ${event.request.id} is not available`)
      }
      const interaction: BraidInteraction = {
        request: event.request,
        responseBinding: event.responseBinding,
        runId: event.runId,
        source,
        status: 'pending',
      }
      const interactions = [...run.interactions, interaction]
      const visibleInteractions = interactions.slice(-MAX_RUN_INTERACTIONS)
      return {
        ...state,
        ...base,
        runs: updateRun(state, event.runId, (run) =>
          addActivity(
            {
              ...withPendingInteractionIndex(
                {
                  ...withProviderProgress(run, event.provider),
                  status: 'waiting',
                  ...(interactions.length > MAX_RUN_INTERACTIONS
                    ? { interactionsTruncated: true }
                    : {}),
                },
                interactions,
              ),
              interactions: visibleInteractions,
            },
            activity(event, 'interaction', event.request.kind, event.request.title, source),
          ),
        ),
      }
    }
    case 'run.interaction.cancelled': {
      const run = findRun(state, event.runId)
      const current = interactionFor(run, event.interactionId)
      if (current.status === 'cancelled') {
        return providerProgress(state, run, event.provider, base)
      }
      if (current.status !== 'pending' && current.status !== 'responding') {
        throw interactionInvariant(
          `Interaction ${event.interactionId} cannot transition from ${current.status} to cancelled`,
        )
      }
      const next = withoutResponseOperation(current, 'cancelled')
      return {
        ...state,
        ...base,
        runs: updateRun(state, event.runId, (candidate) =>
          withPendingInteractionIndex(
            withProviderProgress(candidate, event.provider),
            replaceInteraction(candidate, event.interactionId, next),
          ),
        ),
      }
    }
    case 'run.interaction.response.requested': {
      const run = findRun(state, event.runId)
      const current = interactionFor(run, event.interactionId)
      if (event.automationRule !== undefined) assertAutomationRuleRecord(event.automationRule)
      if (current.status === 'responding') {
        if (sameResponseRequest(current, event)) return { ...state, ...base }
        throw interactionInvariant(
          `Interaction ${event.interactionId} has a different response operation`,
        )
      }
      if (current.status !== 'pending') {
        throw interactionInvariant(
          `Interaction ${event.interactionId} cannot transition from ${current.status} to responding`,
        )
      }
      const next: BraidInteraction = {
        ...current,
        status: 'responding',
        responseOperation: {
          operationId: createOperationId(event.operationId),
          outcome: event.outcome,
          ...(event.dataDigest === undefined ? {} : { dataDigest: event.dataDigest }),
          containsSecret: event.containsSecret,
          ...(event.automationRule === undefined ? {} : { automationRule: event.automationRule }),
        },
      }
      return {
        ...state,
        ...base,
        runs: updateRun(state, event.runId, (run) => ({
          ...run,
          ...withPendingInteractionIndex(run, replaceInteraction(run, event.interactionId, next)),
        })),
      }
    }
    case 'run.interaction.responded': {
      const run = findRun(state, event.runId)
      const current = interactionFor(run, event.interactionId)
      if (current.status !== 'responding') {
        if (isTerminalInteraction(current.status)) {
          if (sameResponseResult(current, event)) {
            return {
              ...state,
              ...base,
              ...(event.outcome === 'unknown'
                ? { lastError: event.detail ?? 'Interaction response is unknown' }
                : {}),
            }
          }
          throw interactionInvariant(
            `Interaction ${event.interactionId} has a different response result`,
          )
        }
        throw interactionInvariant(
          `Interaction ${event.interactionId} cannot be resolved from ${current.status}`,
        )
      }
      const responseOperation = current.responseOperation
      if (responseOperation === undefined)
        throw interactionInvariant(
          `Interaction ${event.interactionId} has no response operation to resolve`,
        )
      assertResponseMatches(responseOperation, event)
      const nextStatus = interactionStatusForOutcome(event.outcome)
      const next: BraidInteraction = {
        ...current,
        status: nextStatus,
        responseOperation: responseOperationForResult(responseOperation, event),
      }
      return {
        ...state,
        ...base,
        lastError:
          event.outcome === 'unknown'
            ? (event.detail ?? 'Interaction response is unknown')
            : state.lastError,
        runs: updateRun(state, event.runId, (run) => ({
          ...run,
          ...withPendingInteractionIndex(run, replaceInteraction(run, event.interactionId, next)),
        })),
      }
    }
    case 'run.status.changed': {
      const current = findRun(state, event.runId)
      assertTerminalTransition(current.status, event.status)
      return {
        ...state,
        ...base,
        activeRunId:
          event.status === 'detached' || TERMINAL_RUN_STATES.includes(event.status)
            ? state.activeRunId === event.runId
              ? null
              : state.activeRunId
            : event.runId,
        runs: updateRun(state, event.runId, (run) =>
          addActivity(
            { ...withProviderProgress({ ...run, status: event.status }, event.provider) },
            activity(event, 'status', event.status, event.detail),
          ),
        ),
      }
    }
    case 'run.provider.event':
      return {
        ...state,
        ...base,
        runs: updateRun(state, event.runId, (run) => ({
          ...withProviderProgress(run, event.provider),
          ...(event.envelope.event.type === 'session.updated'
            ? {
                harnessSessionId:
                  safePublicIdentifier(event.envelope.event.sessionId) ?? run.harnessSessionId,
              }
            : {}),
          eventDetails: [
            ...run.eventDetails,
            {
              eventId: event.envelope.eventId,
              sequence: event.envelope.sequence,
              type: event.envelope.event.type,
              ...(event.envelope.cursor === undefined ? {} : { cursor: event.envelope.cursor }),
              ...(event.envelope.occurredAt === undefined
                ? {}
                : { occurredAt: event.envelope.occurredAt }),
            },
          ].slice(-MAX_RUN_EVENT_DETAILS),
          ...(run.eventDetails.length + 1 > MAX_RUN_EVENT_DETAILS
            ? { eventDetailsTruncated: true }
            : {}),
        })),
      }
    case 'run.finished':
      return reduceFinishedEvent(state, event, base)
    default: {
      const exhaustive: never = event
      return exhaustive
    }
  }
}

function withoutResponseOperation(
  interaction: BraidInteraction,
  status: BraidInteraction['status'],
): BraidInteraction {
  const { responseOperation: _responseOperation, ...rest } = interaction
  return { ...rest, status }
}

function interactionFor(run: BraidState['runs'][number], interactionId: string): BraidInteraction {
  const interaction = run.interactions.find((item) => item.request.id === interactionId)
  if (interaction === undefined)
    throw interactionInvariant(`Interaction ${interactionId} is unknown`)
  return interaction
}

function replaceInteraction(
  run: BraidState['runs'][number],
  interactionId: string,
  replacement: BraidInteraction,
): readonly BraidInteraction[] {
  return run.interactions.map((item) => (item.request.id === interactionId ? replacement : item))
}

function sameInteractionEvent(
  current: BraidInteraction,
  request: BraidInteraction['request'],
  responseBinding: BraidInteraction['responseBinding'],
  source: BraidInteraction['source'],
): boolean {
  return (
    canonicalDigest(current.request) === canonicalDigest(request) &&
    canonicalDigest(current.responseBinding) === canonicalDigest(responseBinding) &&
    canonicalDigest(current.source) === canonicalDigest(source)
  )
}

function sameResponseRequest(
  current: BraidInteraction,
  event: Extract<BraidEvent, { kind: 'run.interaction.response.requested' }>,
): boolean {
  const response = current.responseOperation
  return (
    response !== undefined &&
    response.operationId === createOperationId(event.operationId) &&
    response.outcome === event.outcome &&
    (response.dataDigest ?? undefined) === (event.dataDigest ?? undefined) &&
    response.containsSecret === event.containsSecret &&
    canonicalDigest(response.automationRule ?? null) ===
      canonicalDigest(event.automationRule ?? null)
  )
}

function sameResponseResult(
  current: BraidInteraction,
  event: Extract<BraidEvent, { kind: 'run.interaction.responded' }>,
): boolean {
  const response = current.responseOperation
  return (
    response !== undefined &&
    response.operationId === createOperationId(event.operationId) &&
    response.outcome === event.outcome &&
    (response.dataDigest ?? undefined) === (event.dataDigest ?? undefined) &&
    response.containsSecret === event.containsSecret &&
    interactionStatusForOutcome(event.outcome) === current.status
  )
}

function assertResponseMatches(
  response: NonNullable<BraidInteraction['responseOperation']>,
  event: Extract<BraidEvent, { kind: 'run.interaction.responded' }>,
): void {
  if (
    response.operationId !== createOperationId(event.operationId) ||
    (event.outcome !== 'unknown' && response.outcome !== event.outcome) ||
    (response.dataDigest ?? undefined) !== (event.dataDigest ?? undefined) ||
    response.containsSecret !== event.containsSecret
  ) {
    throw interactionInvariant(`Interaction ${event.interactionId} has a different response result`)
  }
}

function responseOperationForResult(
  response: NonNullable<BraidInteraction['responseOperation']>,
  event: Extract<BraidEvent, { kind: 'run.interaction.responded' }>,
): NonNullable<BraidInteraction['responseOperation']> {
  const { dataDigest: _dataDigest, ...withoutDataDigest } = response
  return {
    ...withoutDataDigest,
    outcome: event.outcome,
    ...(event.dataDigest === undefined ? {} : { dataDigest: event.dataDigest }),
    containsSecret: event.containsSecret,
  }
}

function interactionStatusForOutcome(
  outcome: Extract<BraidEvent, { kind: 'run.interaction.responded' }>['outcome'],
): BraidInteraction['status'] {
  switch (outcome) {
    case 'accepted':
      return 'resolved'
    case 'declined':
      return 'declined'
    case 'cancelled':
      return 'cancelled'
    case 'unknown':
      return 'unknown'
    default: {
      const exhaustive: never = outcome
      return exhaustive
    }
  }
}

function isTerminalInteraction(status: BraidInteraction['status']): boolean {
  return status !== 'pending' && status !== 'responding'
}

function providerProgress(
  state: BraidState,
  run: BraidState['runs'][number],
  provider: Extract<BraidEvent, { kind: 'run.interaction.cancelled' }>['provider'],
  base: ReducerBase,
): BraidState {
  return {
    ...state,
    ...base,
    runs: updateRun(state, run.id, (candidate) => withProviderProgress(candidate, provider)),
  }
}

function interactionInvariant(message: string): DomainInvariantError {
  return new DomainInvariantError(message)
}

function reduceFinishedEvent(
  state: BraidState,
  event: Extract<BraidEvent, { kind: 'run.finished' }>,
  base: ReducerBase,
): BraidState {
  const run = findRun(state, event.runId)
  const finalReservation = reserveText(run, event.finalText)
  const errorReservation =
    event.error === undefined ? undefined : reserveText(finalReservation.run, event.error)
  const reasonReservation =
    event.reason === undefined
      ? undefined
      : reserveText(errorReservation?.run ?? finalReservation.run, event.reason)
  const reservedRun = reasonReservation?.run ?? errorReservation?.run ?? finalReservation.run
  assertTerminalTransition(run.status, event.status === 'unknown' ? 'unknown' : event.status)
  const hasMissingHistory = state.missingHistory.some((range) => range.runId === event.runId)
  const messageStatus = hasMissingHistory ? 'incomplete' : terminalMessageStatus(event.status)
  return {
    ...state,
    ...base,
    activeRunId: state.activeRunId === event.runId ? null : state.activeRunId,
    lastError: errorReservation?.value ?? (event.status === 'failed' ? state.lastError : null),
    messages: updateMessage(state, event.runId, (message) => {
      const source = sourceFromProvider(event.provider)
      const existingTextPart = message.parts.find((part) => part.kind === 'text')
      const withFinalPart = event.finalText
        ? upsertPart(message, {
            id: existingTextPart?.id ?? `${event.runId}:text`,
            kind: 'text',
            text: finalReservation.value,
            ...(source === undefined ? {} : { source }),
          })
        : message
      return {
        ...withFinalPart,
        text: finalReservation.value || withFinalPart.text,
        status: messageStatus,
        complete: event.status !== 'unknown' && !hasMissingHistory,
        parts: withFinalPart.parts.map((part) =>
          part.status === 'running'
            ? {
                ...part,
                status: terminalPartStatus(event.status),
              }
            : part,
        ),
      }
    }),
    runs: updateRun(state, event.runId, (candidate) => {
      const withProgress = withProviderProgress(
        {
          ...candidate,
          ...(reservedRun.contentBytes === undefined
            ? {}
            : { contentBytes: reservedRun.contentBytes }),
          ...(reservedRun.contentTruncated === undefined
            ? {}
            : { contentTruncated: reservedRun.contentTruncated }),
        },
        event.provider,
      )
      return {
        ...finalizeRunUsage(withProgress, event.usage),
        status: event.status,
        ...(errorReservation === undefined ? {} : { error: errorReservation.value }),
        ...(reasonReservation === undefined ? {} : { terminalReason: reasonReservation.value }),
        complete: event.status !== 'unknown' && !hasMissingHistory,
      }
    }),
  }
}
