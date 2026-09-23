import { canonicalDigest } from '../domain/canonical.js'
import { containsControlCharacters, redactErrorMessage } from '../connection/redaction.js'
import { cloneBoundedProfileValue, type ProfileJsonLimits } from '../profile/profile-json.js'

/**
 * Admission idempotency.
 *
 * A retry after a lost acknowledgement must not dispatch a second run, and a
 * reused operation id with different execution inputs must not be silently
 * accepted as the same operation. The ledger records the operation digest with
 * the outcome, so a retry either replays the recorded result or fails with a
 * conflict — it never reaches the runtime twice.
 */

export type AdmissionEntryState = 'in-flight' | 'materialized' | 'failed'

const LEDGER_LIMITS: ProfileJsonLimits = Object.freeze({
  maxBytes: 64 * 1_024,
  maxDepth: 8,
  maxNodes: 256,
  maxStringLength: 1_024,
  maxEntries: 16,
})
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const LEDGER_KEYS = new Set([
  'operationId',
  'operationDigest',
  'state',
  'startedAt',
  'completedAt',
  'receiptDigest',
  'failure',
])

export interface AdmissionLedgerEntry {
  readonly operationId: string
  readonly operationDigest: string
  readonly state: AdmissionEntryState
  readonly startedAt: string
  readonly completedAt?: string
  readonly receiptDigest?: string
  readonly failure?: string
}

export class AdmissionConflictError extends Error {
  readonly operationId: string

  constructor(operationId: string, detail: string) {
    super(
      `Admission ${operationId} conflicts with a recorded operation: ${redactErrorMessage(detail)}`,
    )
    this.name = 'AdmissionConflictError'
    this.operationId = operationId
  }
}

export class AdmissionInFlightError extends Error {
  readonly operationId: string

  constructor(operationId: string) {
    super(`Admission ${operationId} is already in flight; reconcile its outcome before retrying`)
    this.name = 'AdmissionInFlightError'
    this.operationId = operationId
  }
}

export class AdmissionFailedError extends Error {
  readonly operationId: string

  constructor(operationId: string, failure: string) {
    super(`Admission ${operationId} previously failed: ${redactErrorMessage(failure)}`)
    this.name = 'AdmissionFailedError'
    this.operationId = operationId
  }
}

export interface AdmissionLedger {
  read(operationId: string): Promise<AdmissionLedgerEntry | undefined>
  write(entry: AdmissionLedgerEntry): Promise<void>
  /** Reserve atomically when the ledger has durable compare-and-set support. */
  reserve?(entry: AdmissionLedgerEntry): Promise<AdmissionLedgerEntry | undefined>
}

export class MemoryAdmissionLedger implements AdmissionLedger {
  readonly #entries = new Map<string, AdmissionLedgerEntry>()

  async read(operationId: string): Promise<AdmissionLedgerEntry | undefined> {
    return this.#entries.get(operationId)
  }

  async write(entry: AdmissionLedgerEntry): Promise<void> {
    const safe = normalizeAdmissionEntry(entry)
    const existing = this.#entries.get(safe.operationId)
    this.#entries.set(safe.operationId, transitionAdmissionEntry(existing, safe))
  }

  async reserve(entry: AdmissionLedgerEntry): Promise<AdmissionLedgerEntry | undefined> {
    const safe = normalizeAdmissionEntry(entry)
    const existing = this.#entries.get(safe.operationId)
    if (existing !== undefined) {
      if (existing.operationDigest !== safe.operationDigest) {
        throw new AdmissionConflictError(safe.operationId, 'the operation digest changed')
      }
      return existing
    }
    this.#entries.set(safe.operationId, safe)
    return undefined
  }

  entries(): readonly AdmissionLedgerEntry[] {
    return Object.freeze([...this.#entries.values()])
  }
}

/**
 * Identity of one admission's execution inputs.
 *
 * Credential identity and canonical provider configuration are included: the same
 * connection id and endpoint with a rotated credential or a changed route is a
 * different execution, and a digest that ignored them would let a retry reuse a
 * receipt that no longer describes what runs.
 */
export function admissionOperationDigest(input: {
  readonly identifiers: Readonly<Record<string, string>>
  readonly authoredProfileDigest: string
  readonly effectiveProfileDigest: string
  readonly connectionIdentityDigest: string
  readonly selectionDigest: string
  readonly workspaceDigest: string
  readonly capabilityDigest?: string
}): string {
  return canonicalDigest({
    kind: 'braid.admission-operation',
    schemaVersion: 1,
    identifiers: input.identifiers,
    authoredProfileDigest: input.authoredProfileDigest,
    effectiveProfileDigest: input.effectiveProfileDigest,
    connectionIdentityDigest: input.connectionIdentityDigest,
    selectionDigest: input.selectionDigest,
    workspaceDigest: input.workspaceDigest,
    ...(input.capabilityDigest === undefined ? {} : { capabilityDigest: input.capabilityDigest }),
  })
}

/** Non-empty, bounded, single-line operation ids only. */
export function requireOperationId(operationId: string): string {
  if (operationId.length === 0) throw new Error('Admission requires a non-empty operationId')
  if (operationId.length > 256) throw new Error('Admission operationId exceeds 256 characters')
  if (containsControlCharacters(operationId)) {
    throw new Error('Admission operationId must be single-line printable text')
  }
  return operationId
}

export function normalizeAdmissionEntry(value: unknown): AdmissionLedgerEntry {
  let cloned: unknown
  try {
    cloned = cloneBoundedProfileValue(value, LEDGER_LIMITS)
  } catch (error) {
    throw new Error(
      `Admission ledger entry is oversized or not JSON data: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (cloned === null || typeof cloned !== 'object' || Array.isArray(cloned)) {
    throw new Error('Admission ledger entry must be an object')
  }
  const candidate = cloned as Record<string, unknown>
  if (Object.keys(candidate).some((key) => !LEDGER_KEYS.has(key))) {
    throw new Error('Admission ledger entry contains an unsupported field')
  }
  if (
    typeof candidate.operationId !== 'string' ||
    typeof candidate.operationDigest !== 'string' ||
    (candidate.state !== 'in-flight' &&
      candidate.state !== 'materialized' &&
      candidate.state !== 'failed') ||
    typeof candidate.startedAt !== 'string'
  ) {
    throw new Error('Admission ledger entry has an invalid shape')
  }
  requireOperationId(candidate.operationId)
  if (!DIGEST_PATTERN.test(candidate.operationDigest)) {
    throw new Error('Admission ledger operationDigest must be a sha256 digest')
  }
  if (!TIMESTAMP_PATTERN.test(candidate.startedAt) || Number.isNaN(Date.parse(candidate.startedAt))) {
    throw new Error('Admission ledger startedAt must be an ISO timestamp')
  }
  const completedAt = candidate.completedAt
  const receiptDigest = candidate.receiptDigest
  const failure = candidate.failure
  if (candidate.state === 'in-flight') {
    if (completedAt !== undefined || receiptDigest !== undefined || failure !== undefined) {
      throw new Error('In-flight admission entries cannot carry an outcome')
    }
  } else {
    if (
      typeof completedAt !== 'string' ||
      !TIMESTAMP_PATTERN.test(completedAt) ||
      Number.isNaN(Date.parse(completedAt))
    ) {
      throw new Error('Completed admission entries must carry an ISO timestamp')
    }
    if (candidate.state === 'materialized') {
      if (typeof receiptDigest !== 'string' || !DIGEST_PATTERN.test(receiptDigest)) {
        throw new Error('Materialized admission entry must carry a receipt digest')
      }
      if (failure !== undefined) throw new Error('Materialized admission entries cannot carry a failure')
    } else {
      if (typeof failure !== 'string') throw new Error('Failed admission entry must carry a failure')
      if (receiptDigest !== undefined) throw new Error('Failed admission entries cannot carry a receipt digest')
    }
  }
  return Object.freeze({
    operationId: candidate.operationId,
    operationDigest: candidate.operationDigest,
    state: candidate.state,
    startedAt: candidate.startedAt,
    ...(typeof completedAt === 'string' ? { completedAt } : {}),
    ...(typeof receiptDigest === 'string' ? { receiptDigest } : {}),
    ...(typeof failure === 'string' ? { failure: redactErrorMessage(failure) } : {}),
  })
}

export function transitionAdmissionEntry(
  existing: AdmissionLedgerEntry | undefined,
  next: AdmissionLedgerEntry,
): AdmissionLedgerEntry {
  if (existing === undefined) return Object.freeze({ ...next })
  if (existing.operationDigest !== next.operationDigest) {
    throw new AdmissionConflictError(next.operationId, 'the operation digest changed')
  }
  if (existing.startedAt !== next.startedAt) {
    throw new AdmissionConflictError(next.operationId, 'the operation start time changed')
  }
  if (existing.state === 'materialized') {
    if (next.state === 'materialized' && existing.receiptDigest === next.receiptDigest)
      return existing
    throw new AdmissionConflictError(next.operationId, 'the operation is already materialized')
  }
  if (existing.state === 'failed') {
    if (next.state === 'failed' && existing.failure === next.failure) return existing
    throw new AdmissionConflictError(next.operationId, 'the operation has already failed')
  }
  return Object.freeze({ ...next })
}

/**
 * Decide what a retry should do. Returns the recorded receipt digest to replay,
 * or `undefined` when this admission is new and may proceed.
 */
export async function reserveAdmission(
  ledger: AdmissionLedger,
  input: {
    readonly operationId: string
    readonly operationDigest: string
    readonly now: string
  },
): Promise<{ readonly replayReceiptDigest?: string }> {
  const operationId = requireOperationId(input.operationId)
  return withAdmissionReservationLock(ledger, operationId, async () => {
    const candidate: AdmissionLedgerEntry = {
      operationId,
      operationDigest: input.operationDigest,
      state: 'in-flight',
      startedAt: input.now,
    }
    const existing = ledger.reserve
      ? await ledger.reserve(candidate)
      : await ledger.read(operationId)
    if (existing !== undefined) {
      if (existing.operationDigest !== input.operationDigest) {
        throw new AdmissionConflictError(
          operationId,
          'the same operationId was used with different execution inputs',
        )
      }
      if (existing.state === 'in-flight') throw new AdmissionInFlightError(operationId)
      if (existing.state === 'materialized') {
        if (existing.receiptDigest === undefined) {
          throw new AdmissionFailedError(operationId, 'materialized entry has no receipt digest')
        }
        return Object.freeze({ replayReceiptDigest: existing.receiptDigest })
      }
      throw new AdmissionFailedError(
        operationId,
        redactErrorMessage(existing.failure ?? 'unknown failure'),
      )
    }
    if (ledger.reserve === undefined) await ledger.write(candidate)
    return Object.freeze({})
  })
}

const reservationTails = new WeakMap<object, Map<string, Promise<void>>>()

function withAdmissionReservationLock<T>(
  ledger: AdmissionLedger,
  operationId: string,
  work: () => Promise<T>,
): Promise<T> {
  const owner = ledger as object
  const operations = reservationTails.get(owner) ?? new Map<string, Promise<void>>()
  reservationTails.set(owner, operations)
  const prior = operations.get(operationId) ?? Promise.resolve()
  const current = prior.then(work, work)
  operations.set(
    operationId,
    current.then(
      () => undefined,
      () => undefined,
    ),
  )
  return current
}

export async function completeAdmission(
  ledger: AdmissionLedger,
  input: {
    readonly operationId: string
    readonly operationDigest: string
    readonly startedAt: string
    readonly completedAt: string
    readonly receiptDigest: string
  },
): Promise<void> {
  await ledger.write({
    operationId: input.operationId,
    operationDigest: input.operationDigest,
    state: 'materialized',
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    receiptDigest: input.receiptDigest,
  })
}

export async function failAdmission(
  ledger: AdmissionLedger,
  input: {
    readonly operationId: string
    readonly operationDigest: string
    readonly startedAt: string
    readonly completedAt: string
    readonly failure: string
  },
): Promise<void> {
  await ledger.write({
    operationId: input.operationId,
    operationDigest: input.operationDigest,
    state: 'failed',
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    failure: input.failure,
  })
}
