import {
  containsControlCharacters,
  containsSecretShape,
  redactProviderText,
  redactProviderValues,
} from '../connection/redaction.js'
import { canonicalDigest } from '../domain/canonical.js'
import { cloneBoundedProfileValue, type ProfileJsonLimits } from '../profile/profile-json.js'
import type {
  ProviderMaterializationPath,
  ProviderMaterializationReceipt,
} from './admission-contracts.js'

const MAX_GENERATED_PATHS = 512
const MAX_UNSUPPORTED_DIMENSIONS = 128
const MAX_PATH_LENGTH = 1_024
const RESERVED_PATH_ROOTS = new Set(['.git', '.ssh', 'node_modules'])
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u
const RECEIPT_LIMITS: ProfileJsonLimits = Object.freeze({
  maxBytes: 1_048_576,
  maxDepth: 32,
  maxNodes: 20_000,
  maxStringLength: 8_192,
  maxEntries: 2_048,
})
const RECEIPT_KEYS = new Set([
  'materializationDigest',
  'requestDigest',
  'effectiveProfileDigest',
  'capabilityDigest',
  'generatedPaths',
  'unsupportedDimensions',
  'normalizedValues',
  'providerVersion',
  'runnerVersion',
  'runtimeRunId',
  'providerSessionId',
  'environmentId',
  'placement',
  'replayCursor',
])

export class MaterializationReceiptError extends Error {
  readonly detail: string

  constructor(detail: string) {
    const safeDetail = redactProviderText(detail, 512) ?? 'the receipt is invalid'
    super(`Provider materialization receipt is not usable: ${safeDetail}`)
    this.name = 'MaterializationReceiptError'
    this.detail = safeDetail
  }
}

function requireDigest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new MaterializationReceiptError(`${field} must be a sha256 digest`)
  }
  return value
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MaterializationReceiptError(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireKnownKeys(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) {
    if (!RECEIPT_KEYS.has(key)) {
      throw new MaterializationReceiptError(`receipt contains unknown field ${key}`)
    }
  }
}

function generatedPath(entry: unknown): ProviderMaterializationPath {
  const value = requireRecord(entry, 'generated path')
  if (typeof value.path !== 'string' || value.path.length === 0) {
    throw new MaterializationReceiptError('a generated path is missing')
  }
  if (containsControlCharacters(value.path)) {
    throw new MaterializationReceiptError('a generated path contains control characters')
  }
  const safePath = redactProviderText(value.path, MAX_PATH_LENGTH) ?? '<invalid>'
  if (value.path.length > MAX_PATH_LENGTH) {
    throw new MaterializationReceiptError(`generated path exceeds ${MAX_PATH_LENGTH} characters`)
  }
  if (value.path.startsWith('/') || /^[A-Za-z]:/u.test(value.path) || value.path.includes('\\')) {
    throw new MaterializationReceiptError(`generated path ${safePath} is not workspace-relative`)
  }
  const parts = value.path.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new MaterializationReceiptError(`generated path ${safePath} is not normalized`)
  }
  if (RESERVED_PATH_ROOTS.has(parts[0] ?? '')) {
    throw new MaterializationReceiptError(`generated path ${safePath} targets a reserved root`)
  }
  if (value.mode !== undefined) {
    if (
      typeof value.mode !== 'number' ||
      !Number.isInteger(value.mode) ||
      value.mode < 0 ||
      value.mode > 0o777
    ) {
      throw new MaterializationReceiptError(`generated path ${safePath} has an invalid mode`)
    }
    if ((value.mode & 0o022) !== 0) {
      throw new MaterializationReceiptError(
        `generated path ${safePath} is group- or world-writable`,
      )
    }
  }
  const path = redactProviderText(value.path, MAX_PATH_LENGTH)
  if (path === undefined) throw new MaterializationReceiptError('generated path is empty')
  return Object.freeze({
    path,
    ...(value.mode === undefined ? {} : { mode: value.mode }),
    ...(value.digest === undefined ? {} : { digest: requireDigest(value.digest, 'path digest') }),
  })
}

export interface MaterializationBinding {
  readonly requestDigest: string
  readonly effectiveProfileDigest: string
  readonly capabilityDigest: string
  readonly expectedUnsupportedDimensions: readonly string[]
}

export type MaterializationReceiptBody = Omit<
  ProviderMaterializationReceipt,
  'materializationDigest'
>

/** Digest of every validated receipt field except the digest that carries it. */
export function materializationReceiptDigest(body: MaterializationReceiptBody): string {
  const bounded = cloneBoundedProfileValue(body, RECEIPT_LIMITS)
  return canonicalDigest({
    kind: 'braid.materialization-receipt',
    schemaVersion: 1,
    receipt: bounded,
  })
}

function boundedText(field: string, value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new MaterializationReceiptError(`${field} must be bounded text`)
  }
  if (containsControlCharacters(value)) {
    throw new MaterializationReceiptError(`${field} contains control characters`)
  }
  return redactProviderText(value, 256)
}

function normalizePlacement(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined
  const placement = requireRecord(value, 'placement')
  return Object.freeze(redactProviderValues(placement))
}

/** Validate one receipt before it enters a journal, ledger, or runtime replay. */
export function validateMaterializationReceipt(
  receipt: ProviderMaterializationReceipt,
  binding: MaterializationBinding,
): ProviderMaterializationReceipt {
  let bounded: Record<string, unknown>
  try {
    bounded = requireRecord(cloneBoundedProfileValue(receipt, RECEIPT_LIMITS), 'receipt')
  } catch (error) {
    if (error instanceof MaterializationReceiptError) throw error
    throw new MaterializationReceiptError(error instanceof Error ? error.message : String(error))
  }
  requireKnownKeys(bounded)
  const materializationDigest = requireDigest(
    bounded.materializationDigest,
    'materializationDigest',
  )
  const requestDigest = requireDigest(bounded.requestDigest, 'requestDigest')
  const effectiveProfileDigest = requireDigest(
    bounded.effectiveProfileDigest,
    'effectiveProfileDigest',
  )
  const capabilityDigest = requireDigest(bounded.capabilityDigest, 'capabilityDigest')
  if (requestDigest !== binding.requestDigest) {
    throw new MaterializationReceiptError('the receipt answers a different request digest')
  }
  if (effectiveProfileDigest !== binding.effectiveProfileDigest) {
    throw new MaterializationReceiptError('the receipt names a different effective profile')
  }
  if (capabilityDigest !== binding.capabilityDigest) {
    throw new MaterializationReceiptError('the receipt names a different capability snapshot')
  }
  if (!Array.isArray(bounded.generatedPaths)) {
    throw new MaterializationReceiptError('generatedPaths must be an array')
  }
  if (bounded.generatedPaths.length > MAX_GENERATED_PATHS) {
    throw new MaterializationReceiptError(`more than ${MAX_GENERATED_PATHS} generated paths`)
  }
  const paths = bounded.generatedPaths.map(generatedPath)
  const seen = new Set<string>()
  for (const entry of paths) {
    if (seen.has(entry.path)) {
      throw new MaterializationReceiptError(`generated path ${entry.path} is reported twice`)
    }
    seen.add(entry.path)
  }
  if (!Array.isArray(bounded.unsupportedDimensions)) {
    throw new MaterializationReceiptError('unsupportedDimensions must be an array')
  }
  if (bounded.unsupportedDimensions.length > MAX_UNSUPPORTED_DIMENSIONS) {
    throw new MaterializationReceiptError(
      `more than ${MAX_UNSUPPORTED_DIMENSIONS} unsupported dimensions`,
    )
  }
  const unsupportedDimensions = bounded.unsupportedDimensions.map((dimension) => {
    if (
      typeof dimension !== 'string' ||
      dimension.length === 0 ||
      dimension.length > 256 ||
      containsControlCharacters(dimension)
    ) {
      throw new MaterializationReceiptError('unsupportedDimensions contains an invalid value')
    }
    return dimension
  })
  const unexpected = unsupportedDimensions.filter(
    (dimension) => !binding.expectedUnsupportedDimensions.includes(dimension),
  )
  if (unexpected.length > 0) {
    throw new MaterializationReceiptError(
      `the runtime reported dimensions the admission did not accept: ${unexpected.join(', ')}`,
    )
  }
  const normalized = requireRecord(bounded.normalizedValues, 'normalizedValues')
  const normalizedValues = redactProviderValues(normalized)
  for (const [key, value] of Object.entries(normalizedValues)) {
    if (typeof value === 'string' && containsSecretShape(value)) {
      throw new MaterializationReceiptError(`normalizedValues.${key} still carries secret material`)
    }
  }
  const placement = normalizePlacement(bounded.placement)
  const body: MaterializationReceiptBody = {
    requestDigest,
    effectiveProfileDigest,
    capabilityDigest,
    generatedPaths: Object.freeze(paths),
    unsupportedDimensions: Object.freeze(unsupportedDimensions),
    normalizedValues,
    ...optionalText('providerVersion', bounded.providerVersion),
    ...optionalText('runnerVersion', bounded.runnerVersion),
    ...optionalText('runtimeRunId', bounded.runtimeRunId),
    ...optionalText('providerSessionId', bounded.providerSessionId),
    ...optionalText('environmentId', bounded.environmentId),
    ...(placement === undefined ? {} : { placement }),
    ...optionalText('replayCursor', bounded.replayCursor),
  }
  if (materializationDigest !== materializationReceiptDigest(body)) {
    throw new MaterializationReceiptError(
      'materializationDigest does not match the complete receipt',
    )
  }
  return Object.freeze({ materializationDigest, ...body })
}

function optionalText(field: string, value: unknown): Record<string, string> {
  const safe = boundedText(field, value)
  return safe === undefined ? {} : { [field]: safe }
}
