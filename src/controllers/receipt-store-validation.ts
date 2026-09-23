import { validateNormalizedCapabilityShape } from '../connection/capability-shape.js'
import { canonicalDigest } from '../domain/canonical.js'
import { cloneBoundedProfileValue, type ProfileJsonLimits } from '../profile/profile-json.js'
import type {
  PostMaterializationReceipt,
  PreAdmissionReceipt,
  ProviderMaterializationReceipt,
} from './admission-contracts.js'
import { validateMaterializationReceipt } from './materialization-receipt.js'
import {
  type PublicCapabilityDigestInput,
  publicCapabilitySnapshotDigest,
} from './public-capabilities.js'
import {
  assertPostMaterializationReceiptShape,
  assertPreAdmissionReceiptShape,
  assertProfileSnapshot,
  assertReceiptTimestamp,
} from './receipt-shapes.js'

const RECEIPT_STORE_LIMITS: ProfileJsonLimits = Object.freeze({
  maxBytes: 1_048_576,
  maxDepth: 64,
  maxNodes: 50_000,
  maxStringLength: 262_144,
  maxEntries: 4_096,
})
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u
const PRE_KEYS = new Set([
  'kind',
  'schemaVersion',
  'receiptDigest',
  'requestedAt',
  'identifiers',
  'source',
  'sourceRevision',
  'authoredProfile',
  'authoredProfileDigest',
  'effectiveProfile',
  'effectiveProfileDigest',
  'requested',
  'selection',
  'connection',
  'connectionIdentityDigest',
  'capabilities',
  'schema',
  'validation',
  'workspace',
])
const POST_KEYS = new Set([
  'kind',
  'schemaVersion',
  'receiptDigest',
  'preAdmissionDigest',
  'admittedAt',
  'identifiers',
  'authoredProfileDigest',
  'effectiveProfileDigest',
  'connection',
  'connectionIdentityDigest',
  'capabilities',
  'schema',
  'requested',
  'selection',
  'validation',
  'materialization',
  'workspace',
])
const PRE_REQUIRED = [
  'requestedAt',
  'identifiers',
  'source',
  'authoredProfile',
  'authoredProfileDigest',
  'effectiveProfile',
  'effectiveProfileDigest',
  'requested',
  'selection',
  'connection',
  'connectionIdentityDigest',
  'capabilities',
  'schema',
  'validation',
  'workspace',
]
const POST_REQUIRED = [
  'preAdmissionDigest',
  'admittedAt',
  'identifiers',
  'authoredProfileDigest',
  'effectiveProfileDigest',
  'connection',
  'connectionIdentityDigest',
  'capabilities',
  'schema',
  'requested',
  'selection',
  'validation',
  'materialization',
  'workspace',
]
function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function bounded(value: unknown, field: string): Record<string, unknown> {
  try {
    return record(cloneBoundedProfileValue(value, RECEIPT_STORE_LIMITS), field)
  } catch (error) {
    throw new Error(
      `${field} is oversized or not JSON data: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function assertKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, field: string) {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${field} contains an unsupported field`)
  }
}

function assertHeader(
  value: Record<string, unknown>,
  kind: string,
  keys: ReadonlySet<string>,
  required: readonly string[],
): void {
  assertKeys(value, keys, kind)
  if (value.kind !== kind || value.schemaVersion !== 1) {
    throw new Error(`${kind} has an unsupported schema`)
  }
  if (typeof value.receiptDigest !== 'string' || !DIGEST_PATTERN.test(value.receiptDigest)) {
    throw new Error(`${kind} must carry a valid receipt digest`)
  }
  if (required.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${kind} is missing a required field`)
  }
}

function assertDigest(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${field} must carry a valid digest`)
  }
}

function assertCapabilities(value: Record<string, unknown>, field: string): void {
  validateNormalizedCapabilityShape(value)
  if (
    value.digest !== publicCapabilitySnapshotDigest(value as unknown as PublicCapabilityDigestInput)
  ) {
    throw new Error(`${field} digest does not match its snapshot`)
  }
}

function sameDigest(left: unknown, right: unknown, field: string): void {
  if (canonicalDigest(left) !== canonicalDigest(right)) {
    throw new Error(`Post-materialization receipt does not match ${field}`)
  }
}

export function assertPostMatchesPre(
  pre: PreAdmissionReceipt,
  post: PostMaterializationReceipt,
): void {
  if (post.preAdmissionDigest !== pre.receiptDigest) {
    throw new Error('Post-materialization receipt points at a different pre-admission receipt')
  }
  if (
    post.authoredProfileDigest !== pre.authoredProfileDigest ||
    post.effectiveProfileDigest !== pre.effectiveProfileDigest ||
    post.connectionIdentityDigest !== pre.connectionIdentityDigest ||
    post.capabilities.digest !== pre.capabilities.digest
  ) {
    throw new Error(
      'Post-materialization receipt has different profile, connection, or capability bindings',
    )
  }
  sameDigest(post.identifiers, pre.identifiers, 'identifiers')
  sameDigest(post.connection, pre.connection, 'connection')
  sameDigest(post.schema, pre.schema, 'schema')
  sameDigest(post.requested, pre.requested, 'requested overrides')
  sameDigest(post.selection, pre.selection, 'selection')
  sameDigest(post.validation, pre.validation, 'validation')
  sameDigest(post.workspace, pre.workspace, 'workspace')
}

export function preAdmissionReceiptDigest(candidate: Record<string, unknown>): string {
  return canonicalDigest({
    kind: 'braid.pre-admission',
    schemaVersion: 1,
    requestedAt: candidate.requestedAt,
    identifiers: candidate.identifiers,
    source: candidate.source,
    ...(candidate.sourceRevision === undefined ? {} : { sourceRevision: candidate.sourceRevision }),
    authoredProfile: candidate.authoredProfile,
    authoredProfileDigest: candidate.authoredProfileDigest,
    effectiveProfile: candidate.effectiveProfile,
    effectiveProfileDigest: candidate.effectiveProfileDigest,
    requested: candidate.requested,
    connectionIdentityDigest: candidate.connectionIdentityDigest,
    connection: candidate.connection,
    selection: candidate.selection,
    capabilities: candidate.capabilities,
    schema: candidate.schema,
    workspace: candidate.workspace,
    validation: candidate.validation,
  })
}

export function postMaterializationReceiptDigest(candidate: Record<string, unknown>): string {
  return canonicalDigest({
    kind: 'braid.post-materialization',
    schemaVersion: 1,
    preAdmissionDigest: candidate.preAdmissionDigest,
    admittedAt: candidate.admittedAt,
    identifiers: candidate.identifiers,
    authoredProfileDigest: candidate.authoredProfileDigest,
    effectiveProfileDigest: candidate.effectiveProfileDigest,
    connection: candidate.connection,
    connectionIdentityDigest: candidate.connectionIdentityDigest,
    capabilities: candidate.capabilities,
    schema: candidate.schema,
    requested: candidate.requested,
    selection: candidate.selection,
    validation: candidate.validation,
    materialization: candidate.materialization,
    workspace: candidate.workspace,
  })
}

function freezeJson<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value as Record<string, unknown>)) freezeJson(child, seen)
  return Object.freeze(value)
}

export function normalizeStoredPreAdmission(value: PreAdmissionReceipt): PreAdmissionReceipt {
  const candidate = bounded(value, 'Pre-admission receipt')
  assertHeader(candidate, 'braid.pre-admission', PRE_KEYS, PRE_REQUIRED)
  assertPreAdmissionReceiptShape(candidate)
  assertDigest(candidate.authoredProfileDigest, 'Pre-admission authored profile')
  assertDigest(candidate.effectiveProfileDigest, 'Pre-admission effective profile')
  assertReceiptTimestamp(candidate.requestedAt, 'Pre-admission requestedAt')
  assertProfileSnapshot(
    candidate.authoredProfile,
    candidate.authoredProfileDigest,
    'Pre-admission authored profile',
  )
  assertProfileSnapshot(
    candidate.effectiveProfile,
    candidate.effectiveProfileDigest,
    'Pre-admission effective profile',
  )
  assertDigest(candidate.connectionIdentityDigest, 'Pre-admission connection identity')
  const capabilities = record(candidate.capabilities, 'Pre-admission capabilities')
  assertDigest(capabilities.digest, 'Pre-admission capabilities')
  assertCapabilities(capabilities, 'Pre-admission capabilities')
  if (candidate.receiptDigest !== preAdmissionReceiptDigest(candidate)) {
    throw new Error('Pre-admission receipt digest does not match its contents')
  }
  return freezeJson(candidate) as unknown as PreAdmissionReceipt
}

export function normalizeStoredPostMaterialization(
  value: PostMaterializationReceipt,
): PostMaterializationReceipt {
  const candidate = bounded(value, 'Post-materialization receipt')
  assertHeader(candidate, 'braid.post-materialization', POST_KEYS, POST_REQUIRED)
  if (
    typeof candidate.preAdmissionDigest !== 'string' ||
    !DIGEST_PATTERN.test(candidate.preAdmissionDigest) ||
    typeof candidate.effectiveProfileDigest !== 'string' ||
    !DIGEST_PATTERN.test(candidate.effectiveProfileDigest)
  ) {
    throw new Error('Post-materialization receipt has incomplete profile bindings')
  }
  assertPostMaterializationReceiptShape(candidate)
  assertReceiptTimestamp(candidate.admittedAt, 'Post-materialization admittedAt')
  assertDigest(candidate.authoredProfileDigest, 'Post-materialization authored profile')
  assertDigest(candidate.connectionIdentityDigest, 'Post-materialization connection identity')
  const capabilities = record(candidate.capabilities, 'Post-materialization capabilities')
  if (typeof capabilities.digest !== 'string' || !DIGEST_PATTERN.test(capabilities.digest)) {
    throw new Error('Post-materialization receipt has an incomplete capability binding')
  }
  assertCapabilities(capabilities, 'Post-materialization capabilities')
  const validation = record(candidate.validation, 'Post-materialization validation')
  const issues = validation.issues
  if (!Array.isArray(issues)) throw new Error('Post-materialization validation has no issues list')
  const expectedUnsupportedDimensions = issues.flatMap((issue) => {
    const entry = record(issue, 'Post-materialization validation issue')
    return entry.code === 'UNSUPPORTED_PROFILE_DIMENSION' && typeof entry.path === 'string'
      ? [entry.path]
      : []
  })
  const materialization = validateMaterializationReceipt(
    candidate.materialization as ProviderMaterializationReceipt,
    {
      requestDigest: candidate.preAdmissionDigest,
      effectiveProfileDigest: candidate.effectiveProfileDigest,
      capabilityDigest: capabilities.digest,
      expectedUnsupportedDimensions,
    },
  )
  if (
    candidate.receiptDigest !== postMaterializationReceiptDigest({ ...candidate, materialization })
  ) {
    throw new Error('Post-materialization receipt digest does not match its contents')
  }
  return freezeJson({ ...candidate, materialization }) as unknown as PostMaterializationReceipt
}
