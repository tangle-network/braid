import type { BraidEvent } from './events.js'
import { reserveText, reserveValue } from './content-budget.js'
import type { BraidMessagePart, BraidState } from './state.js'
import {
  activity,
  addActivity,
  findRun,
  sourceFromProvider,
  updateMessage,
  updateRun,
  upsertPart,
  withProviderProgress,
  type ReducerBase,
} from './reducer-support.js'

type ContentEvent = Extract<
  BraidEvent,
  {
    kind:
      | 'run.text.delta'
      | 'run.part.updated'
      | 'run.reasoning.delta'
      | 'run.tool.call'
      | 'run.tool.result'
      | 'run.artifact'
      | 'run.proposal'
      | 'run.warning'
      | 'run.error'
      | 'run.usage'
      | 'run.cost'
  }
>

export function reduceContentEvent(
  state: BraidState,
  event: ContentEvent,
  base: ReducerBase,
): BraidState {
  switch (event.kind) {
    case 'run.text.delta': {
      const run = findRun(state, event.runId)
      const source = sourceFromProvider(event.provider)
      const reservation = reserveText(run, event.text)
      const next = {
        ...state,
        ...base,
        messages: updateMessage(state, event.runId, (message) =>
          upsertPart(
            message,
            {
              id: `${event.runId}:text`,
              kind: 'text',
              text: reservation.value,
              ...(source === undefined ? {} : { source }),
            },
            reservation.value,
          ),
        ),
        runs: updateRun(state, event.runId, (candidate) =>
          withProviderProgress(
            {
              ...reservation.run,
              status: candidate.status === 'starting' ? 'streaming' : candidate.status,
            },
            event.provider,
          ),
        ),
      }
      if (run.status === 'cancelling') return next
      return next
    }
    case 'run.part.updated':
      findRun(state, event.runId)
      return {
        ...updatePartEvent(state, event),
        ...base,
      }
    case 'run.reasoning.delta': {
      const run = findRun(state, event.runId)
      const source = sourceFromProvider(event.provider)
      const reservation = reserveText(run, event.text)
      return {
        ...state,
        ...base,
        messages: updateMessage(state, event.runId, (message) =>
          upsertPart(
            message,
            {
              id: event.partId,
              kind: 'reasoning',
              text: reservation.value,
              ...(source === undefined ? {} : { source }),
            },
            reservation.value,
          ),
        ),
        runs: updateRun(state, event.runId, () =>
          withProviderProgress(reservation.run, event.provider),
        ),
      }
    }
    case 'run.tool.call': {
      const run = findRun(state, event.runId)
      const source = sourceFromProvider(event.provider)
      const inputReservation =
        event.input === undefined ? { run, value: undefined } : reserveValue(run, event.input)
      return {
        ...state,
        ...base,
        messages: updateMessage(state, event.runId, (message) =>
          upsertPart(message, {
            id: event.partId,
            kind: 'tool-call',
            toolName: event.toolName,
            ...(event.callId === undefined ? {} : { callId: event.callId }),
            ...(event.input === undefined ? {} : { input: inputReservation.value }),
            ...(source === undefined ? {} : { source }),
          }),
        ),
        runs: updateRun(state, event.runId, () =>
          addActivity(
            withProviderProgress(inputReservation.run, event.provider),
            activity(event, 'tool', event.toolName, 'started', source),
          ),
        ),
      }
    }
    case 'run.tool.result': {
      const run = findRun(state, event.runId)
      const source = sourceFromProvider(event.provider)
      const resultReservation =
        event.result === undefined ? { run, value: undefined } : reserveValue(run, event.result)
      const errorReservation =
        event.error === undefined ? undefined : reserveText(resultReservation.run, event.error)
      return {
        ...state,
        ...base,
        messages: updateMessage(state, event.runId, (message) =>
          upsertPart(message, {
            ...message.parts.find((part) => part.id === event.partId),
            id: event.partId,
            kind: 'tool-result',
            toolName: event.toolName,
            ...(event.callId === undefined ? {} : { callId: event.callId }),
            ...(event.result === undefined ? {} : { result: resultReservation.value }),
            ...(errorReservation === undefined ? {} : { error: errorReservation.value }),
            ...(source === undefined ? {} : { source }),
          }),
        ),
        runs: updateRun(state, event.runId, () =>
          addActivity(
            withProviderProgress(errorReservation?.run ?? resultReservation.run, event.provider),
            activity(event, 'tool', event.toolName, errorReservation?.value ?? 'completed', source),
          ),
        ),
      }
    }
    case 'run.artifact':
    case 'run.proposal':
    case 'run.warning':
    case 'run.error': {
      const source = sourceFromProvider(event.provider)
      let run = findRun(state, event.runId)
      let title: string | undefined
      let text: string | undefined
      let uri: string | undefined
      let metadata: Readonly<Record<string, unknown>> | undefined
      if (event.kind === 'run.artifact') {
        if (event.name !== undefined) {
          const reservation = reserveText(run, event.name)
          run = reservation.run
          title = reservation.value
        }
        if (event.uri !== undefined) {
          const reservation = reserveText(run, event.uri)
          run = reservation.run
          uri = reservation.value
        }
        if (event.metadata !== undefined) {
          const reservation = reserveValue(run, event.metadata)
          run = reservation.run
          metadata = reservation.value as Readonly<Record<string, unknown>>
        }
      } else if (event.kind === 'run.proposal') {
        const reservation = reserveText(run, event.title)
        run = reservation.run
        title = reservation.value
      } else {
        const reservation = reserveText(run, event.message)
        run = reservation.run
        text = reservation.value
      }
      const part: BraidMessagePart =
        event.kind === 'run.artifact'
          ? {
              id: event.artifactId,
              kind: 'artifact',
              artifactId: event.artifactId,
              ...(title === undefined ? {} : { title }),
              ...(event.mimeType === undefined ? {} : { mimeType: event.mimeType }),
              ...(uri === undefined ? {} : { uri }),
              ...(metadata === undefined ? {} : { metadata }),
              ...(source === undefined ? {} : { source }),
            }
          : event.kind === 'run.proposal'
            ? {
                id: event.proposalId,
                kind: 'proposal',
                title: title ?? '',
                ...(event.status === undefined ? {} : { status: event.status }),
                ...(source === undefined ? {} : { source }),
              }
            : event.kind === 'run.warning'
              ? {
                  id: `${event.runId}:warning:${event.provider.eventId}`,
                  kind: 'warning',
                  text: text ?? '',
                  status: event.code,
                  ...(source === undefined ? {} : { source }),
                }
              : {
                  id: `${event.runId}:error:${event.provider.eventId}`,
                  kind: 'error',
                  text: text ?? '',
                  status: event.recoverable ? 'recoverable' : 'terminal',
                  ...(source === undefined ? {} : { source }),
                }
      const label =
        event.kind === 'run.artifact'
          ? 'artifact'
          : event.kind === 'run.proposal'
            ? 'proposal'
            : event.kind === 'run.warning'
              ? event.code
              : 'error'
      return {
        ...state,
        ...base,
        messages: updateMessage(state, event.runId, (message) => upsertPart(message, part)),
        lastError: event.kind === 'run.error' ? (text ?? '') : state.lastError,
        runs: updateRun(state, event.runId, () =>
          addActivity(
            withProviderProgress(run, event.provider),
            activity(
              event,
              event.kind,
              label,
              event.kind === 'run.error' ? text : undefined,
              source,
            ),
          ),
        ),
      }
    }
    case 'run.usage':
      return {
        ...state,
        ...base,
        runs: updateRun(state, event.runId, (run) => {
          const withProgress = withProviderProgress(run, event.provider)
          return {
            ...withProgress,
            inputTokens: event.usage.input,
            outputTokens: event.usage.output,
            ...(event.usage.reasoning === undefined
              ? {}
              : { reasoningTokens: event.usage.reasoning }),
            ...(event.usage.costUsd === undefined ? {} : { costUsd: event.usage.costUsd }),
            ...(event.usage.model === undefined ? {} : { model: event.usage.model }),
          }
        }),
      }
    case 'run.cost':
      return {
        ...state,
        ...base,
        runs: updateRun(state, event.runId, (run) => ({
          ...withProviderProgress(run, event.provider),
          costUsd: event.costUsd,
        })),
      }
    default: {
      const exhaustive: never = event
      return exhaustive
    }
  }
}

function updatePartEvent(
  state: BraidState,
  event: Extract<BraidEvent, { kind: 'run.part.updated' }>,
): BraidState {
  const source = sourceFromProvider(event.provider)
  let run = findRun(state, event.runId)
  let part = event.part
  let delta = event.delta
  if (delta !== undefined) {
    const reservation = reserveText(run, delta)
    run = reservation.run
    delta = reservation.value
  } else if (part.text !== undefined) {
    const reservation = reserveText(run, part.text)
    run = reservation.run
    part = { ...part, text: reservation.value }
  }
  if (part.input !== undefined) {
    const reservation = reserveValue(run, part.input)
    run = reservation.run
    part = { ...part, input: reservation.value }
  }
  if (part.result !== undefined) {
    const reservation = reserveValue(run, part.result)
    run = reservation.run
    part = { ...part, result: reservation.value }
  }
  part = source === undefined ? part : { ...part, source }
  return {
    ...state,
    messages: updateMessage(state, event.runId, (message) => upsertPart(message, part, delta)),
    runs: updateRun(state, event.runId, (candidate) =>
      withProviderProgress(
        {
          ...candidate,
          ...(run.contentBytes === undefined ? {} : { contentBytes: run.contentBytes }),
          ...(run.contentTruncated === undefined ? {} : { contentTruncated: run.contentTruncated }),
        },
        event.provider,
      ),
    ),
  }
}
