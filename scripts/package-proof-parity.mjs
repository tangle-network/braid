import { loadPackageProofCanonicalDigest } from './package-proof-product-modules.mjs'

export { baselineEventEnd, firstTerminalTrace } from './package-proof-trace.mjs'

const canonicalDigest = await loadPackageProofCanonicalDigest()

function sortParityValue(value, parentKey) {
  if (Array.isArray(value)) return value.map((item) => sortParityValue(item, parentKey))
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [
        key,
        key === 'occurredAt' || key === 'receivedAt'
          ? '<runtime-time>'
          : parentKey === 'spend' && key === 'ms'
            ? '<runtime-duration-ms>'
            : sortParityValue(child, key),
      ]),
  )
}

function normalizeDraftEvent(event) {
  if (event?.kind !== 'draft.changed' && event?.kind !== 'draft.recorded') return undefined
  const value = event.payload?.value
  const text = event.kind === 'draft.changed' ? value?.text : value?.draft?.text
  return {
    ...event,
    kind: 'draft.changed',
    payload: {
      value: {
        kind: 'draft.changed',
        text: typeof text === 'string' ? text : '',
      },
    },
  }
}

export function parityEvidence(state, events) {
  const operationIds = new Map()
  const effects = new Map()
  const normalizeCallerOperationId = (value) => {
    if (typeof value !== 'string') return value
    let normalized = operationIds.get(value)
    if (!normalized) {
      normalized = `<caller-operation-${operationIds.size + 1}>`
      operationIds.set(value, normalized)
    }
    return normalized
  }
  const normalizeDerivedOperationId = (value) => {
    if (typeof value !== 'string') return value
    for (const [operationId, normalized] of operationIds) {
      if (value.includes(operationId)) return value.replaceAll(operationId, normalized)
    }
    return value
  }
  const normalizeEffect = (effect) => {
    if (!effect || typeof effect !== 'object') return effect
    const key = `${String(effect.operationId)}\u0000${String(effect.effectKind)}\u0000${String(effect.requestDigest)}`
    let ordinal = effects.get(key)
    if (ordinal === undefined) {
      ordinal = effects.size + 1
      effects.set(key, ordinal)
    }
    return {
      ...effect,
      id:
        typeof effect.id === 'string'
          ? `<effect-${ordinal}>`
          : normalizeDerivedOperationId(effect.id),
      operationId: normalizeCallerOperationId(effect.operationId),
      ...(typeof effect.requestDigest === 'string'
        ? { requestDigest: `<effect-request-${ordinal}>` }
        : {}),
    }
  }
  const normalizeReceipt = (receipt) => {
    if (!receipt || typeof receipt !== 'object') return receipt
    const operationId = normalizeCallerOperationId(receipt.operationId)
    const normalizedRequestDigest = canonicalDigest({
      runId: receipt.runId,
      turnId: receipt.turnId,
      operationId,
      conversationId: receipt.conversationId,
      branchId: receipt.branchId,
      text: receipt.requested?.text,
      profileDigest: receipt.profileDigest,
      contextPlanDigest: receipt.requested?.contextPlanDigest ?? null,
    })
    const normalized = {
      ...receipt,
      operationId,
      requestDigest: normalizedRequestDigest,
    }
    const { digest: _digest, ...base } = normalized
    return { ...normalized, digest: canonicalDigest(base) }
  }
  const normalizeRun = (run) =>
    run && typeof run === 'object'
      ? {
          ...run,
          operationId: normalizeCallerOperationId(run.operationId),
          ...(run.receipt === undefined ? {} : { receipt: normalizeReceipt(run.receipt) }),
        }
      : run
  const normalizedState = {
    ...state,
    runs: Array.isArray(state?.runs) ? state.runs.map(normalizeRun) : state?.runs,
    effects: Array.isArray(state?.effects)
      ? state.effects.map((effect) => normalizeEffect(effect))
      : state?.effects,
  }
  const normalizedEvents = events.map((event) => {
    const normalizedDraft = normalizeDraftEvent(event)
    if (normalizedDraft !== undefined) return normalizedDraft
    if (event?.kind === 'run.requested' && event.payload && typeof event.payload === 'object') {
      return {
        ...event,
        payload: {
          ...event.payload,
          operationId: normalizeCallerOperationId(event.payload.operationId),
          ...(event.payload.admission === undefined
            ? {}
            : { admission: normalizeReceipt(event.payload.admission) }),
          ...(event.payload.receipt === undefined
            ? {}
            : { receipt: normalizeReceipt(event.payload.receipt) }),
        },
      }
    }
    if (event?.kind === 'effect.upserted' && event.payload && typeof event.payload === 'object') {
      return {
        ...event,
        payload: {
          ...event.payload,
          ...(event.payload.effect === undefined
            ? {}
            : { effect: normalizeEffect(event.payload.effect) }),
          ...(event.payload.value && typeof event.payload.value === 'object'
            ? {
                value: {
                  ...event.payload.value,
                  effect: normalizeEffect(event.payload.value.effect),
                },
              }
            : {}),
        },
      }
    }
    return event
  })
  return sortParityValue({ events: normalizedEvents, state: normalizedState })
}

export function firstDifference(left, right, path = '$') {
  if (Object.is(left, right)) return undefined
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length)
      return { path: `${path}.length`, left: left.length, right: right.length }
    for (let index = 0; index < left.length; index += 1) {
      const difference = firstDifference(left[index], right[index], `${path}[${index}]`)
      if (difference) return difference
    }
    return undefined
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)].sort())
    for (const key of keys) {
      const difference = firstDifference(left[key], right[key], `${path}.${key}`)
      if (difference) return difference
    }
    return undefined
  }
  return { path, left, right }
}
