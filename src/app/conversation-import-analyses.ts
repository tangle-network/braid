import type { AnalysisModelCallRecord } from '../domain/analysis-model-call.js'
import { safePublicIdentifier } from '../domain/provider-values.js'
import { isCanonicalIsoDateTime } from '../domain/text.js'
import { AppError } from './errors.js'

type JsonRecord = Readonly<Record<string, unknown>>

const MODEL_CALL_KEYS = new Set([
  'sequence',
  'callId',
  'callRef',
  'path',
  'model',
  'provider',
  'route',
  'inputTokens',
  'outputTokens',
  'cachedTokens',
  'cacheWriteTokens',
  'tokensKnown',
  'cost',
  'latencyMs',
  'outcome',
  'responseStatus',
  'failureCode',
  'startedAt',
  'endedAt',
])
const COST_KEYS = new Set(['status', 'usd'])
const REDACTION_MARKERS = new Set(['[redacted]', '[redacted credential]', '[redacted secret]'])

/**
 * Import the public model-call facts embedded in an analysis export.
 *
 * The importer copies a fixed allow-list only. It rejects opaque payloads and
 * treats redacted optional numeric fields as unavailable rather than zero.
 */
export function importAnalysisModelCalls(
  value: unknown,
  label: string,
): readonly AnalysisModelCallRecord[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw invalid(`${label} must be an array`)
  return Object.freeze(
    value.map((entry, index) => importAnalysisModelCall(entry, `${label}[${index}]`)),
  )
}

function importAnalysisModelCall(value: unknown, label: string): AnalysisModelCallRecord {
  const record = jsonRecord(value, label)
  exactKeys(record, MODEL_CALL_KEYS, label)
  const cost = jsonRecord(record.cost, `${label}.cost`)
  exactKeys(cost, COST_KEYS, `${label}.cost`)
  const costStatus = oneOf(
    cost.status,
    ['observed', 'estimated', 'unknown'] as const,
    `${label}.cost.status`,
  )
  const costUsd = optionalNumber(cost.usd, `${label}.cost.usd`)
  if (costStatus === 'unknown' && costUsd !== undefined) {
    throw invalid(`${label}.cost.usd must be absent when cost.status is unknown`)
  }
  if (costStatus !== 'unknown' && costUsd === undefined) {
    throw invalid(`${label}.cost.usd is required when cost.status is ${costStatus}`)
  }
  const path = oneOf(
    record.path,
    ['/v1/chat/completions', '/v1/responses', 'unknown-path'] as const,
    `${label}.path`,
  )
  const outcome = oneOf(record.outcome, ['succeeded', 'failed'] as const, `${label}.outcome`)
  const tokensKnown = record.tokensKnown
  if (typeof tokensKnown !== 'boolean') {
    throw invalid(`${label}.tokensKnown must be boolean`)
  }
  const sequence = positiveInteger(record.sequence, `${label}.sequence`)
  const inputTokens = optionalNumber(record.inputTokens, `${label}.inputTokens`)
  const outputTokens = optionalNumber(record.outputTokens, `${label}.outputTokens`)
  if (tokensKnown && (inputTokens === undefined || outputTokens === undefined)) {
    throw invalid(`${label} known tokens require inputTokens and outputTokens`)
  }
  const responseStatus = optionalHttpStatus(record.responseStatus, `${label}.responseStatus`)
  return Object.freeze({
    sequence,
    callId: requiredIdentifier(record.callId, `${label}.callId`),
    callRef: requiredIdentifier(record.callRef, `${label}.callRef`),
    path,
    model: requiredIdentifier(record.model, `${label}.model`),
    ...optionalIdentifier('provider', record.provider, label),
    ...optionalIdentifier('route', record.route, label),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...optionalNumberField('cachedTokens', record.cachedTokens, label),
    ...optionalNumberField('cacheWriteTokens', record.cacheWriteTokens, label),
    tokensKnown,
    cost: Object.freeze({
      status: costStatus,
      ...(costUsd === undefined ? {} : { usd: costUsd }),
    }),
    ...optionalNumberField('latencyMs', record.latencyMs, label),
    outcome,
    ...(responseStatus === undefined ? {} : { responseStatus }),
    ...optionalIdentifier('failureCode', record.failureCode, label),
    ...optionalDateField('startedAt', record.startedAt, label),
    ...optionalDateField('endedAt', record.endedAt, label),
  })
}

function optionalHttpStatus(value: unknown, label: string): number | undefined {
  if (value === undefined || isRedactionMarker(value)) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 100 || value > 599) {
    throw invalid(`${label} must be an HTTP status code`)
  }
  return value
}

function jsonRecord(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${label} must be an object`)
  }
  return value as JsonRecord
}

function exactKeys(record: JsonRecord, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw invalid(`${label}.${key} is not supported`)
  }
}

function requiredIdentifier(value: unknown, label: string): string {
  const identifier = safePublicIdentifier(value)
  if (identifier === undefined) throw invalid(`${label} must be a safe public identifier`)
  return identifier
}

function optionalIdentifier(
  key: string,
  value: unknown,
  parentLabel: string,
): { [property: string]: string } {
  if (value === undefined || isRedactionMarker(value)) return {}
  return { [key]: requiredIdentifier(value, `${parentLabel}.${key}`) }
}

function optionalNumberField(
  key: string,
  value: unknown,
  parentLabel: string,
): { [property: string]: number } {
  const number = optionalNumber(value, `${parentLabel}.${key}`)
  return number === undefined ? {} : { [key]: number }
}

function optionalDateField(
  key: string,
  value: unknown,
  parentLabel: string,
): { [property: string]: string } {
  if (value === undefined || isRedactionMarker(value)) return {}
  if (!isCanonicalIsoDateTime(value)) {
    throw invalid(`${parentLabel}.${key} must be a canonical ISO timestamp`)
  }
  return { [key]: value }
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || isRedactionMarker(value)) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalid(`${label} must be a non-negative number`)
  }
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw invalid(`${label} must be a positive integer`)
  }
  return value
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw invalid(`${label} is unsupported`)
  }
  return value as T[number]
}

function isRedactionMarker(value: unknown): boolean {
  return typeof value === 'string' && REDACTION_MARKERS.has(value)
}

function invalid(message: string): AppError {
  return new AppError('IMPORT_INVALID', message)
}
