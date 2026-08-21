import { canonicalDigest, canonicalJson } from '../domain/canonical.js'
import type { JsonValue } from '../domain/entities-base.js'
import type { RetainedRunAdmissionRecord } from '../domain/run-contracts.js'
import {
  type AnalysisIdentity,
  AnalysisOperationError,
  updateAnalysisOperation,
  withAnalysisOperationLock,
} from './analysis-operation.js'
import type { AnalysisApplicationHost } from './analysis-types.js'

const RESULT_KEY = 'retainedAdmissions'

function isJsonObject(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function admissionValue(admission: RetainedRunAdmissionRecord): JsonValue {
  return JSON.parse(canonicalJson(admission)) as JsonValue
}

function entryIdentity(
  value: JsonValue,
): { readonly callId: string; readonly phase: string } | null {
  if (!isJsonObject(value)) return null
  const callId = value.callId
  const admission = value.admission
  if (
    typeof callId !== 'string' ||
    !isJsonObject(admission) ||
    typeof admission.phase !== 'string'
  ) {
    return null
  }
  return { callId, phase: admission.phase }
}

/** Persist one model-call recovery record before Runtime may continue. */
export async function recordAnalysisRetainedAdmission(
  host: AnalysisApplicationHost,
  identity: AnalysisIdentity,
  callId: string,
  admission: RetainedRunAdmissionRecord,
): Promise<void> {
  if (callId.trim().length === 0) {
    throw new AnalysisOperationError(
      'ANALYSIS_OPERATION_CONFLICT',
      'A retained analysis admission requires a call identifier',
    )
  }
  await withAnalysisOperationLock(host, async () => {
    const operation = host
      .currentState()
      .operations.find((candidate) => candidate.id === identity.operationId)
    if (
      operation === undefined ||
      operation.kind !== 'analysis' ||
      operation.requestDigest !== identity.requestDigest ||
      operation.status !== 'pending'
    ) {
      throw new AnalysisOperationError(
        'ANALYSIS_OPERATION_UNAVAILABLE',
        `Analysis operation ${String(identity.operationId)} cannot accept retained recovery data`,
      )
    }

    const current = operation.result?.[RESULT_KEY]
    if (current !== undefined && !Array.isArray(current)) {
      throw new AnalysisOperationError(
        'ANALYSIS_OPERATION_CONFLICT',
        `Analysis operation ${String(identity.operationId)} has invalid retained recovery data`,
      )
    }
    const entries: readonly JsonValue[] = current ?? []
    const encodedAdmission = admissionValue(admission)
    const duplicate = entries.find((entry) => {
      const key = entryIdentity(entry)
      return key?.callId === callId && key.phase === admission.phase
    })
    if (duplicate !== undefined) {
      if (
        !isJsonObject(duplicate) ||
        canonicalDigest(duplicate.admission) !== canonicalDigest(encodedAdmission)
      ) {
        throw new AnalysisOperationError(
          'ANALYSIS_OPERATION_CONFLICT',
          `Analysis call ${callId} changed its ${admission.phase} admission`,
        )
      }
      return
    }

    const entry: JsonValue = { callId, admission: encodedAdmission }
    await updateAnalysisOperation(host, operation, {
      status: operation.status,
      result: {
        ...(operation.result ?? {}),
        [RESULT_KEY]: [...entries, entry],
      },
    })
  })
}
