import { canonicalDigest } from '../domain/canonical.js'
import type { AnalysisRecord, OperationRecord } from '../domain/entities.js'
import type { AnalysisId, Digest, OperationId } from '../domain/ids.js'
import {
  createAnalysisId,
  createAnalysisRunId,
  createOperationId,
  isOperationId,
} from '../domain/ids-values.js'
import { commitAnalysisEvent } from './analysis-persistence.js'
import type { AnalysisApplicationHost } from './analysis-types.js'

export type AnalysisOperationKind = 'analysis' | 'comparison' | 'promotion'

export interface AnalysisIdentity {
  readonly operationId: OperationId
  readonly requestDigest: Digest
  readonly analysisId: AnalysisId
  readonly analysisRunId: ReturnType<typeof createAnalysisRunId>
}

export interface AnalysisOperationReservation {
  readonly operation: OperationRecord
  readonly created: boolean
}

export class AnalysisOperationError extends Error {
  readonly code: 'ANALYSIS_OPERATION_CONFLICT' | 'ANALYSIS_OPERATION_UNAVAILABLE'

  constructor(
    code: 'ANALYSIS_OPERATION_CONFLICT' | 'ANALYSIS_OPERATION_UNAVAILABLE',
    message: string,
  ) {
    super(message)
    this.name = 'AnalysisOperationError'
    this.code = code
  }
}

function operationIdFor(raw: string | undefined, input: unknown): OperationId {
  if (raw !== undefined && isOperationId(raw)) return createOperationId(raw)
  return createOperationId(`operation-analysis-${canonicalDigest({ raw, input }).slice(0, 40)}`)
}

export function analysisIdentity(input: {
  readonly kind: AnalysisOperationKind
  readonly operationId?: string
  readonly sourceDigests: readonly string[]
  readonly request: unknown
}): AnalysisIdentity {
  const requestDigest = canonicalDigest({
    kind: input.kind,
    sourceDigests: input.sourceDigests,
    request: input.request,
  })
  const operationId = operationIdFor(input.operationId, {
    kind: input.kind,
    sourceDigests: input.sourceDigests,
    requestDigest,
  })
  const identity = canonicalDigest({
    operationId,
    sourceDigests: input.sourceDigests,
    requestDigest,
  })
  return {
    operationId,
    requestDigest,
    analysisId: createAnalysisId(`analysis-${identity.slice(0, 40)}`),
    analysisRunId: createAnalysisRunId(`analysis-run-${identity.slice(0, 40)}`),
  }
}

const reservationTails = new WeakMap<object, Promise<void>>()

export async function withAnalysisOperationLock<T>(
  host: AnalysisApplicationHost,
  task: () => Promise<T>,
): Promise<T> {
  const previous = reservationTails.get(host) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((resolve) => {
    release = resolve
  })
  reservationTails.set(
    host,
    previous.catch(() => undefined).then(() => next),
  )
  await previous.catch(() => undefined)
  try {
    return await task()
  } finally {
    release()
  }
}

export async function reserveAnalysisOperation(
  host: AnalysisApplicationHost,
  input: {
    readonly identity: AnalysisIdentity
    readonly kind: 'analysis' | 'promote-analysis'
    readonly target: AnalysisRecord['id']
  },
): Promise<AnalysisOperationReservation> {
  return withAnalysisOperationLock(host, async () => {
    const existing = host
      .currentState()
      .operations.find((operation) => operation.id === input.identity.operationId)
    if (existing !== undefined) {
      if (existing.requestDigest !== input.identity.requestDigest || existing.kind !== input.kind) {
        throw new AnalysisOperationError(
          'ANALYSIS_OPERATION_CONFLICT',
          `Operation ${String(input.identity.operationId)} was already reserved for a different request`,
        )
      }
      return { operation: existing, created: false }
    }
    const at = host.now()
    const operation: OperationRecord = {
      id: input.identity.operationId,
      kind: input.kind,
      requestDigest: input.identity.requestDigest,
      status: 'pending',
      target: { kind: 'analysis', id: input.target },
      createdAt: at,
      updatedAt: at,
    }
    await commitAnalysisEvent(host, { kind: 'operation.requested', operation })
    return { operation, created: true }
  })
}

export async function updateAnalysisOperation(
  host: AnalysisApplicationHost,
  operation: OperationRecord,
  input: {
    readonly status: OperationRecord['status']
    readonly at?: string
    readonly result?: Readonly<Record<string, import('../domain/entities-base.js').JsonValue>>
    readonly failureCode?: string
    readonly failureMessage?: string
    readonly terminalOutcome?: OperationRecord['terminalOutcome']
  },
): Promise<OperationRecord> {
  const at = input.at ?? host.now()
  const updated: OperationRecord = {
    ...operation,
    status: input.status,
    ...(input.result === undefined ? {} : { result: input.result }),
    ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
    ...(input.failureMessage === undefined ? {} : { failureMessage: input.failureMessage }),
    ...(input.terminalOutcome === undefined ? {} : { terminalOutcome: input.terminalOutcome }),
    ...(input.status === 'acknowledged' || input.status === 'terminal'
      ? { acknowledgedAt: at }
      : {}),
    updatedAt: at,
  }
  await commitAnalysisEvent(host, { kind: 'operation.updated', operation: updated })
  return updated
}

export async function reconcileAnalysisState(
  host: AnalysisApplicationHost,
  activeAnalysisIds: ReadonlySet<string> = new Set(),
): Promise<void> {
  await withAnalysisOperationLock(host, async () => {
    const state = host.currentState()
    const activeOperationIds = new Set(
      [...activeAnalysisIds]
        .map((id) => state.analyses.find((analysis) => String(analysis.id) === id)?.operationId)
        .filter((id): id is OperationId => id !== undefined),
    )
    for (const analysis of state.analyses) {
      if (
        (analysis.status !== 'preparing' && analysis.status !== 'running') ||
        activeAnalysisIds.has(String(analysis.id))
      ) {
        continue
      }
      const unknown: AnalysisRecord = {
        ...analysis,
        status: 'unknown',
        error:
          'Analysis was interrupted before its durable terminal result; retry with a new operation ID.',
        updatedAt: host.now(),
      }
      await commitAnalysisEvent(host, { kind: 'analysis.updated', analysis: unknown })
      if (analysis.operationId !== undefined) {
        const operation = host
          .currentState()
          .operations.find((candidate) => candidate.id === analysis.operationId)
        if (operation !== undefined && operation.status === 'pending') {
          await updateAnalysisOperation(host, operation, {
            status: 'unknown',
            failureCode: 'ANALYSIS_RESTARTED',
            ...(unknown.error === undefined ? {} : { failureMessage: unknown.error }),
            terminalOutcome: 'unknown',
          })
        }
      }
    }
    for (const operation of host.currentState().operations) {
      if (
        (operation.kind !== 'analysis' && operation.kind !== 'promote-analysis') ||
        operation.status !== 'pending' ||
        activeOperationIds.has(operation.id)
      ) {
        continue
      }
      await updateAnalysisOperation(host, operation, {
        status: 'unknown',
        failureCode: 'ANALYSIS_RESTARTED',
        failureMessage:
          'The durable operation was pending when the application restarted and cannot be replayed safely.',
        terminalOutcome: 'unknown',
      })
    }
  })
}

export function operationResult(
  values: Readonly<Record<string, string | number | boolean | null>>,
): Readonly<Record<string, import('../domain/entities-base.js').JsonValue>> {
  return values
}
