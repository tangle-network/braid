import { canonicalDigest } from '../domain/canonical.js'
import {
  type AnalysisOperationKind,
  type AnalysisOperationRecord,
  AnalysisServiceError,
} from './model.js'

export function operationDigest(
  kind: AnalysisOperationKind,
  targetId: string,
  request: unknown,
): string {
  return `sha256:${canonicalDigest({ kind, targetId, request })}`
}

export function operationConflict(input: AnalysisOperationRecord, digest: string): never {
  throw new AnalysisServiceError(
    'OPERATION_CONFLICT',
    'The operation ID is already bound to another request',
    {
      operationId: input.operationId,
      existingDigest: input.requestDigest,
      requestedDigest: digest,
    },
  )
}

export function reserveInput(
  operationId: string,
  kind: AnalysisOperationKind,
  targetId: string,
  request: unknown,
  updatedAt: string,
  ownerId?: string,
  leaseUntil?: string,
): Omit<AnalysisOperationRecord, 'status' | 'result' | 'updatedAt'> & {
  readonly updatedAt: string
} {
  return {
    operationId,
    kind,
    targetId,
    requestDigest: `sha256:${canonicalDigest(request)}`,
    ...(ownerId ? { ownerId } : {}),
    ...(leaseUntil ? { leaseUntil } : {}),
    updatedAt,
  }
}
