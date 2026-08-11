import type { BraidEvent } from './events.js'
import { reserveText } from './content-budget.js'
import type { BraidInteraction, BraidState } from './state.js'
import { createOperationId } from './ids.js'
import { finalizeRunUsage } from './run-usage.js'
import {
  activity,
  addActivity,
  assertTerminalTransition,
  findRun,
  sourceFromProvider,
  terminalMessageStatus,
  terminalPartStatus,
  updateMessage,
  updateRun,
  upsertPart,
  withProviderProgress,
  MAX_RUN_EVENT_DETAILS,
  MAX_RUN_INTERACTIONS,
  TERMINAL_RUN_STATES,
  type ReducerBase,
} from './reducer-support.js'

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
      const source = sourceFromProvider(event.provider) ?? {}
      const interaction: BraidInteraction = {
        request: event.request,
        responseBinding: event.responseBinding,
        runId: event.runId,
        source,
        status: 'pending',
      }
      const interactions = [
        ...(state.runs.find((run) => run.id === event.runId)?.interactions ?? []),
        interaction,
      ]
      return {
        ...state,
        ...base,
        runs: updateRun(state, event.runId, (run) =>
          addActivity(
            {
              ...withProviderProgress(run, event.provider),
              status: 'waiting',
              interactions: interactions.slice(-MAX_RUN_INTERACTIONS),
              ...(interactions.length > MAX_RUN_INTERACTIONS
                ? { interactionsTruncated: true }
                : {}),
            },
            activity(event, 'interaction', event.request.kind, event.request.title, source),
          ),
        ),
      }
    }
    case 'run.interaction.cancelled':
      return {
        ...state,
        ...base,
        runs: updateRun(state, event.runId, (run) => ({
          ...withProviderProgress(run, event.provider),
          interactions: run.interactions.map((item) =>
            item.request.id === event.interactionId
              ? withoutResponseOperation(item, 'cancelled')
              : item,
          ),
        })),
      }
    case 'run.interaction.response.requested':
      return {
        ...state,
        ...base,
        runs: updateRun(state, event.runId, (run) => ({
          ...run,
          interactions: run.interactions.map((item) =>
            item.request.id === event.interactionId
              ? {
                  ...item,
                  status: 'responding' as const,
                  responseOperation: {
                    operationId: createOperationId(event.operationId),
                    outcome: event.outcome,
                    ...(event.dataDigest === undefined ? {} : { dataDigest: event.dataDigest }),
                    containsSecret: event.containsSecret,
                    ...(event.automationRule === undefined
                      ? {}
                      : { automationRule: event.automationRule }),
                  },
                }
              : item,
          ),
        })),
      }
    case 'run.interaction.responded':
      return {
        ...state,
        ...base,
        lastError:
          event.outcome === 'unknown'
            ? (event.detail ?? 'Interaction response is unknown')
            : state.lastError,
        runs: updateRun(state, event.runId, (run) => ({
          ...run,
          interactions: run.interactions.map((item) =>
            item.request.id === event.interactionId
              ? withoutResponseOperation(
                  item,
                  event.outcome === 'accepted'
                    ? 'resolved'
                    : event.outcome === 'unknown'
                      ? 'unknown'
                      : event.outcome,
                )
              : item,
          ),
        })),
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
            ? { providerSessionId: event.envelope.event.sessionId }
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
