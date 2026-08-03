export function sortParityValue(value) {
  if (Array.isArray(value)) return value.map((item) => sortParityValue(item))
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortParityValue(child)]),
  )
}

export function parityEvidence(state, events) {
  const operationIds = new Map()
  const normalizeCallerOperationId = (value) => {
    if (typeof value !== 'string') return value
    let normalized = operationIds.get(value)
    if (!normalized) {
      normalized = `<caller-operation-${operationIds.size + 1}>`
      operationIds.set(value, normalized)
    }
    return normalized
  }
  const normalizedState = {
    ...state,
    runs: Array.isArray(state?.runs)
      ? state.runs.map((run) => ({
          ...run,
          operationId: normalizeCallerOperationId(run?.operationId),
        }))
      : state?.runs,
  }
  const normalizedEvents = events.map((event) =>
    event?.kind === 'run.requested' && event.payload && typeof event.payload === 'object'
      ? {
          ...event,
          payload: {
            ...event.payload,
            operationId: normalizeCallerOperationId(event.payload.operationId),
          },
        }
      : event,
  )
  return sortParityValue({ events: normalizedEvents, state: normalizedState })
}

export function firstTerminalTrace(evidence) {
  const finishIndex = evidence.events.findIndex(
    (event) => event.kind === 'run.finished' && event.payload?.status === 'completed',
  )
  if (finishIndex < 0) throw new Error('terminal proof has no completed baseline run')
  const finish = evidence.events[finishIndex]
  return {
    state: {
      ...evidence.state,
      revision: finish.revision,
      sequence: finish.sequence,
      messages: evidence.state.messages.slice(0, 2),
      runs: evidence.state.runs.slice(0, 1),
      activeRunId: null,
      lastError: null,
    },
    events: evidence.events.slice(0, finishIndex + 1),
  }
}
