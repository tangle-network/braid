export function baselineEventEnd(events) {
  const finishIndex = events.findIndex(
    (event) => event.kind === 'run.finished' && event.payload?.status === 'completed',
  )
  if (finishIndex < 0) throw new Error('proof has no completed baseline run')
  const requested = events.slice(0, finishIndex).find((event) => event.kind === 'run.requested')
  const operationId =
    requested?.payload?.operationId ??
    requested?.payload?.admission?.operationId ??
    requested?.payload?.receipt?.operationId
  let end = finishIndex + 1
  while (
    typeof operationId === 'string' &&
    events[end]?.kind === 'effect.upserted' &&
    (events[end]?.payload?.effect?.operationId === operationId ||
      events[end]?.payload?.value?.effect?.operationId === operationId)
  ) {
    end += 1
  }
  return end
}

export function firstTerminalTrace(evidence) {
  const finishIndex = evidence.events.findIndex(
    (event) => event.kind === 'run.finished' && event.payload?.status === 'completed',
  )
  if (finishIndex < 0) throw new Error('terminal proof has no completed baseline run')
  const finish = evidence.events[finishIndex]
  const baselineEnd = baselineEventEnd(evidence.events)
  const lastBaselineEvent = evidence.events[baselineEnd - 1] ?? finish
  const baselineRun = evidence.state.runs[0]
  return {
    state: {
      ...evidence.state,
      revision: lastBaselineEvent.revision,
      sequence: lastBaselineEvent.sequence,
      messages: evidence.state.messages.slice(0, 2),
      runs: evidence.state.runs.slice(0, 1),
      focusedRunId: baselineRun?.id ?? null,
      activeRunId: null,
      lastError: null,
    },
    events: evidence.events.slice(0, baselineEnd),
  }
}
