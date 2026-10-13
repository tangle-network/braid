import {
  type ContextTransferRequest,
  ContextTransferRequestSchema,
} from '@tangle-network/agent-interface'
import { redactStructuredValueWithNumericTelemetry } from './bounded-structured.js'
import { canonicalDigest } from './canonical.js'

export const MAX_PERSISTED_CONTEXT_REQUEST_BYTES = 64 * 1024

/** Keep a canonical commitment exact, or refuse before its provider effect. */
export function persistedContextTransferRequest(value: unknown): ContextTransferRequest {
  const request = ContextTransferRequestSchema.parse(value)
  if (canonicalDigest(request) !== canonicalDigest(value))
    throw new RangeError('The canonical handoff request contains unrecognized fields')
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_PERSISTED_CONTEXT_REQUEST_BYTES)
    throw new RangeError('The canonical handoff request exceeds the durable payload limit')
  const sanitized = redactStructuredValueWithNumericTelemetry(request, undefined, {
    maxDepth: 8,
    maxItems: 20_000,
    maxBytes: MAX_PERSISTED_CONTEXT_REQUEST_BYTES,
  }) as ContextTransferRequest
  const candidate = {
    ...sanitized,
    plan: {
      ...sanitized.plan,
      // This one schema-validated integer is a count, not credential material.
      ...(request.plan.estimatedTokens === undefined
        ? {}
        : { estimatedTokens: request.plan.estimatedTokens }),
    },
  }
  if (canonicalDigest(candidate) !== canonicalDigest(request))
    throw new RangeError(
      'The canonical handoff request cannot be retained without redaction or truncation',
    )
  const checked = ContextTransferRequestSchema.parse(candidate)
  rejectSecretDesignation(checked)
  return checked
}

function rejectSecretDesignation(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  const fields = recordValue(record.answerSpec)?.fields
  const hasSecretAnswerSpec =
    Array.isArray(fields) && fields.some((field) => recordValue(field)?.type === 'secret')
  if (
    hasSecretAnswerSpec ||
    record.containsSecret === true ||
    record.secretDesignated === true ||
    record.isSecret === true
  )
    throw new RangeError(
      'Secret-designated values cannot be retained in a canonical handoff request',
    )
  for (const child of Object.values(record)) rejectSecretDesignation(child)
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** The only journal locations that carry this exact canonical wire contract. */
export function persistedContextTransferEventRequest(event: unknown):
  | {
      readonly path: readonly string[]
      readonly request: ContextTransferRequest
    }
  | undefined {
  const record = recordValue(event)
  if (record?.kind === 'run.requested') {
    const requested = recordValue(recordValue(record.receipt)?.requested)
    if (requested?.portableContextTransferRequest !== undefined)
      return {
        path: ['receipt', 'requested', 'portableContextTransferRequest'],
        request: persistedContextTransferRequest(requested.portableContextTransferRequest),
      }
  }
  if (record?.kind === 'operation.updated') {
    const operation = recordValue(record.operation)
    const result = recordValue(operation?.result)
    if (
      operation?.kind === 'conversation-fork' &&
      result?.kind === 'handoff' &&
      result.request !== undefined
    )
      return {
        path: ['operation', 'result', 'request'],
        request: persistedContextTransferRequest(result.request),
      }
  }
  return undefined
}
