import type {
  AnalysisOperationRecord,
  AnalysisOperationReservation,
  AnalysisRecord,
  JsonValue,
} from './model.js'
import { cloneJson, toJsonValue } from './serialization.js'

export interface AnalysisState {
  readonly schemaVersion: 1
  readonly records: readonly AnalysisRecord[]
  readonly operations: readonly AnalysisOperationRecord[]
}

export type AnalysisReservationInput = Omit<
  AnalysisOperationRecord,
  'status' | 'result' | 'updatedAt'
> & {
  readonly updatedAt: string
}

export interface AnalysisStateTransition<T> {
  readonly state: AnalysisState
  readonly result: T
  readonly changed: boolean
}

export function emptyAnalysisState(): AnalysisState {
  return { schemaVersion: 1, records: [], operations: [] }
}

export function normalizeAnalysisState(value: unknown): AnalysisState {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid analysis state schema')
  const candidate = value as {
    readonly schemaVersion?: unknown
    readonly records?: unknown
    readonly operations?: unknown
  }
  if (
    candidate.schemaVersion !== 1 ||
    !Array.isArray(candidate.records) ||
    !Array.isArray(candidate.operations)
  )
    throw new Error('Invalid analysis state schema')
  return {
    schemaVersion: 1,
    records: candidate.records.map((record) => cloneJson(record as AnalysisRecord)),
    operations: candidate.operations.map((operation) =>
      cloneJson(operation as AnalysisOperationRecord),
    ),
  }
}

export function saveAnalysisRecord(
  state: AnalysisState,
  record: AnalysisRecord,
): AnalysisStateTransition<void> {
  return {
    state: {
      ...state,
      records: [
        ...state.records.filter((item) => item.analysisId !== record.analysisId),
        cloneJson(record),
      ],
    },
    result: undefined,
    changed: true,
  }
}

export function reserveAnalysisOperation(
  state: AnalysisState,
  input: AnalysisReservationInput,
): AnalysisStateTransition<AnalysisOperationReservation> {
  const existing = state.operations.find((item) => item.operationId === input.operationId)
  if (existing) {
    const canReclaim =
      existing.status === 'pending' &&
      existing.requestDigest === input.requestDigest &&
      Boolean(input.ownerId) &&
      Boolean(existing.ownerId) &&
      (!existing.leaseUntil || Date.parse(existing.leaseUntil) <= Date.parse(input.updatedAt))
    if (canReclaim) {
      const taken: AnalysisOperationRecord = {
        ...existing,
        ...(input.ownerId ? { ownerId: input.ownerId } : {}),
        ...(input.leaseUntil ? { leaseUntil: input.leaseUntil } : {}),
        updatedAt: input.updatedAt,
      }
      return {
        state: replaceOperation(state, taken),
        result: { record: cloneJson(taken), created: true, reclaimed: true },
        changed: true,
      }
    }
    return { state, result: { record: cloneJson(existing), created: false }, changed: false }
  }
  const record: AnalysisOperationRecord = {
    ...input,
    status: 'pending',
    updatedAt: input.updatedAt,
  }
  return {
    state: { ...state, operations: [...state.operations, cloneJson(record)] },
    result: { record: cloneJson(record), created: true },
    changed: true,
  }
}

export function renewAnalysisOperation(
  state: AnalysisState,
  operationId: string,
  requestDigest: string,
  updatedAt: string,
  leaseUntil: string,
  ownerId: string,
): AnalysisStateTransition<boolean> {
  const existing = state.operations.find((item) => item.operationId === operationId)
  if (
    !existing ||
    existing.requestDigest !== requestDigest ||
    existing.status !== 'pending' ||
    existing.ownerId !== ownerId ||
    (existing.leaseUntil !== undefined && Date.parse(existing.leaseUntil) <= Date.parse(updatedAt))
  )
    return { state, result: false, changed: false }
  const renewed = { ...existing, leaseUntil, updatedAt }
  return { state: replaceOperation(state, renewed), result: true, changed: true }
}

export function commitAnalysisRecord(
  state: AnalysisState,
  record: AnalysisRecord,
  requestDigest: string,
  updatedAt: string,
  ownerId?: string,
): AnalysisStateTransition<boolean> {
  const operation = operationFor(state, record.operationId)
  if (
    !operation ||
    operation.requestDigest !== requestDigest ||
    operation.status !== 'pending' ||
    (operation.ownerId !== undefined && operation.ownerId !== ownerId)
  )
    return { state, result: false, changed: false }
  const terminal: AnalysisOperationRecord = {
    ...operation,
    status: 'terminal',
    result: toJsonValue(record),
    updatedAt,
  }
  const withRecord = saveAnalysisRecord(state, record).state
  return { state: replaceOperation(withRecord, terminal), result: true, changed: true }
}

export function commitUnknownAnalysisRecord(
  state: AnalysisState,
  record: AnalysisRecord,
  requestDigest: string,
  updatedAt: string,
): AnalysisStateTransition<boolean> {
  const operation = operationFor(state, record.operationId)
  if (!operation || operation.requestDigest !== requestDigest || operation.status !== 'unknown')
    return { state, result: false, changed: false }
  const withRecord = saveAnalysisRecord(state, record).state
  return {
    state: replaceOperation(withRecord, { ...operation, result: toJsonValue(record), updatedAt }),
    result: true,
    changed: true,
  }
}

export function completeAnalysisOperation(
  state: AnalysisState,
  operationId: string,
  requestDigest: string,
  result: JsonValue,
  updatedAt: string,
  ownerId?: string,
): AnalysisStateTransition<void> {
  const operation = requireOperation(state, operationId, requestDigest)
  if (operation.status === 'terminal') return { state, result: undefined, changed: false }
  if (operation.status !== 'pending')
    throw new Error(`Operation is no longer writable: ${operationId}`)
  if (operation.ownerId && ownerId !== operation.ownerId)
    throw new Error(`Operation ownership was lost: ${operationId}`)
  if (
    operation.ownerId &&
    operation.leaseUntil &&
    Date.parse(operation.leaseUntil) <= Date.parse(updatedAt)
  )
    throw new Error(`Operation lease expired: ${operationId}`)
  return {
    state: replaceOperation(state, {
      ...operation,
      status: 'terminal',
      result,
      updatedAt,
    }),
    result: undefined,
    changed: true,
  }
}

export function markAnalysisOperationUnknown(
  state: AnalysisState,
  operationId: string,
  requestDigest: string,
  updatedAt: string,
  ownerId?: string,
): AnalysisStateTransition<void> {
  const operation = requireOperation(state, operationId, requestDigest)
  if (operation.status === 'terminal' || operation.status === 'unknown')
    return { state, result: undefined, changed: false }
  if (ownerId && operation.ownerId && ownerId !== operation.ownerId)
    throw new Error(`Operation ownership was lost: ${operationId}`)
  if (
    operation.ownerId &&
    operation.leaseUntil &&
    Date.parse(operation.leaseUntil) > Date.parse(updatedAt) &&
    operation.ownerId !== ownerId
  )
    throw new Error(`Operation lease is held: ${operationId}`)
  return {
    state: replaceOperation(state, { ...operation, status: 'unknown', updatedAt }),
    result: undefined,
    changed: true,
  }
}

function operationFor(
  state: AnalysisState,
  operationId: string,
): AnalysisOperationRecord | undefined {
  return state.operations.find((item) => item.operationId === operationId)
}

function requireOperation(
  state: AnalysisState,
  operationId: string,
  requestDigest: string,
): AnalysisOperationRecord {
  const operation = operationFor(state, operationId)
  if (!operation || operation.requestDigest !== requestDigest)
    throw new Error(`Unknown or conflicting operation: ${operationId}`)
  return operation
}

function replaceOperation(
  state: AnalysisState,
  operation: AnalysisOperationRecord,
): AnalysisState {
  return {
    ...state,
    operations: state.operations.map((item) =>
      item.operationId === operation.operationId ? cloneJson(operation) : item,
    ),
  }
}
