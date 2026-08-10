import { canonicalDigest } from '../domain/canonical.js'
import { isSafePublicMetadata } from '../domain/public-metadata.js'
import type { Clock } from '../ports/clock.js'
import type {
  EffectOutcomeStatus,
  EffectRecord,
  EffectStoragePort,
} from '../ports/effect-storage.js'

export interface EffectIntent<TRequest> {
  readonly operationId: string
  readonly effectKind: string
  readonly request: TRequest
  /** Optional storage-owned keyed binding; never recompute it from public receipt data. */
  readonly requestDigest?: string
  /**
   * Effects sharing a key are serialized; independent keys may progress while
   * a long-running stream effect is active.
   */
  readonly serializationKey?: string
  readonly metadata?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}

export interface EffectContext<TRequest> {
  readonly operationId: string
  readonly effectKind: string
  readonly requestDigest: string
  readonly request: TRequest
  readonly signal?: AbortSignal
}

export interface EffectDispatchResult {
  readonly status: EffectOutcomeStatus
  readonly detail?: string
  readonly externalReference?: string
}

export interface EffectHandler<TRequest> {
  dispatch(context: EffectContext<TRequest>): Promise<EffectDispatchResult>
  /**
   * Resolves a durable pending record through the owning external authority.
   * Returning undefined leaves the record pending; the coordinator never
   * guesses that a pending external mutation is safe to repeat.
   */
  reconcile?(context: EffectContext<TRequest>): Promise<EffectDispatchResult | undefined>
}

export interface EffectCoordinatorOptions {
  readonly onRecord?: (record: EffectRecord) => void
}

export interface EffectHandle {
  readonly operationId: string
  readonly requestDigest: string
  readonly replayed: boolean
  readonly record: EffectRecord
  readonly completion: Promise<EffectRecord>
}

export class EffectCoordinatorError extends Error {
  readonly code:
    | 'EFFECT_KIND_REQUIRED'
    | 'OPERATION_ID_REQUIRED'
    | 'EFFECT_METADATA_UNSAFE'
    | 'EFFECT_INTENT_NOT_DURABLE'

  constructor(code: EffectCoordinatorError['code'], message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'EffectCoordinatorError'
    this.code = code
  }
}

export function effectRequestDigest<TRequest>(
  intent: Pick<EffectIntent<TRequest>, 'effectKind' | 'request'>,
): string {
  return canonicalDigest({ effectKind: intent.effectKind, request: intent.request })
}

interface QueuedEffect {
  readonly key: string
  readonly completion: Promise<EffectRecord>
}

const SECRET_TEXT =
  /(secret|password|passphrase|token|bearer|authorization|credential|private(?:[_-]?key)?|api[-_]?key)\s*[:=]/iu
const SAFE_DETAIL = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u
const SAFE_EXTERNAL_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u

function safeDetail(value: string | undefined, fallback: string): string | undefined {
  if (value === undefined) return undefined
  const candidate = value.trim()
  return SAFE_DETAIL.test(candidate) && !SECRET_TEXT.test(candidate) ? candidate : fallback
}

function safeExternalReference(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const candidate = value.trim()
  return SAFE_EXTERNAL_REFERENCE.test(candidate) && !SECRET_TEXT.test(candidate)
    ? candidate
    : undefined
}

/**
 * Serializes durable effect admission and external dispatch.
 *
 * The storage port is deliberately synchronous at this boundary so an
 * application controller can commit the pending intent before it returns a
 * receipt. A SQLite adapter can implement the same port with a synchronous
 * transaction API while remaining replaceable behind this seam.
 */
export class SerializedEffectCoordinator {
  readonly #storage: EffectStoragePort
  readonly #clock: Clock
  readonly #inFlight = new Map<string, QueuedEffect>()
  readonly #tails = new Map<string, Promise<void>>()
  readonly #onRecord: ((record: EffectRecord) => void) | undefined

  constructor(storage: EffectStoragePort, clock: Clock, options: EffectCoordinatorOptions = {}) {
    this.#storage = storage
    this.#clock = clock
    this.#onRecord = options.onRecord
  }

  current(operationId: string): EffectRecord | undefined {
    const record = this.#storage.current(operationId)
    return record === undefined ? undefined : structuredClone(record)
  }

  /**
   * Applies a provider result that arrived after the foreground deadline.
   *
   * Only pending or unknown records may be corrected. A later call observes
   * the already settled record, so the operation remains idempotent.
   */
  settle(
    operationId: string,
    requestDigest: string,
    outcome: EffectDispatchResult,
  ): EffectRecord | undefined {
    const current = this.#storage.current(operationId)
    if (current === undefined || current.requestDigest !== requestDigest) return undefined
    if (current.status !== 'pending' && current.status !== 'unknown')
      return structuredClone(current)
    const detail = safeDetail(outcome.detail, `EFFECT_${outcome.status.toUpperCase()}`)
    const externalReference = safeExternalReference(outcome.externalReference)
    if (
      current.status === outcome.status &&
      current.detail === detail &&
      current.externalReference === externalReference
    )
      return structuredClone(current)
    return this.#persistOutcome(current, outcome)
  }

  start<TRequest>(intent: EffectIntent<TRequest>, handler: EffectHandler<TRequest>): EffectHandle {
    const requestDigest = this.#validateIntent(intent)
    const metadata = intent.metadata ?? {}
    if (!isSafePublicMetadata(metadata)) {
      throw new EffectCoordinatorError(
        'EFFECT_METADATA_UNSAFE',
        'Effect metadata must contain only bounded public strings',
      )
    }
    const now = this.#clock.now()
    const pending: EffectRecord = {
      operationId: intent.operationId,
      effectKind: intent.effectKind,
      requestDigest,
      status: 'pending',
      attempt: 1,
      createdAt: now,
      updatedAt: now,
      metadata: structuredClone(metadata),
    }
    let reservation: { readonly record: EffectRecord; readonly created: boolean }
    try {
      reservation = this.#storage.reserveEffect(pending)
      if (reservation.created) this.#onRecord?.(structuredClone(reservation.record))
    } catch (error) {
      throw new EffectCoordinatorError(
        'EFFECT_INTENT_NOT_DURABLE',
        `Could not atomically admit effect ${intent.operationId} before dispatch`,
        { cause: error },
      )
    }

    const admitted = reservation.record
    if (!reservation.created && admitted.status === 'conflict') {
      this.#onRecord?.(structuredClone(admitted))
    }
    if (
      !reservation.created &&
      admitted.status !== 'pending' &&
      !(admitted.status === 'unknown' && handler.reconcile !== undefined)
    ) {
      return this.#resolvedHandle(intent, requestDigest, admitted, true)
    }

    if (!reservation.created) {
      const key = this.#key(intent.operationId, requestDigest)
      const inFlight = this.#inFlight.get(key)
      if (inFlight !== undefined) {
        return {
          operationId: intent.operationId,
          requestDigest,
          replayed: true,
          record: structuredClone(admitted),
          completion: inFlight.completion,
        }
      }

      if (handler.reconcile === undefined) {
        return this.#resolvedHandle(intent, requestDigest, admitted, true)
      }

      const completion = this.#schedule(key, intent.serializationKey ?? 'default', () =>
        this.#reconcilePending(intent, requestDigest, admitted, handler),
      )
      return {
        operationId: intent.operationId,
        requestDigest,
        replayed: true,
        record: structuredClone(admitted),
        completion,
      }
    }

    const key = this.#key(intent.operationId, requestDigest)
    const completion = this.#schedule(key, intent.serializationKey ?? 'default', () =>
      this.#dispatchNew(intent, pending, handler),
    )
    return {
      operationId: intent.operationId,
      requestDigest,
      replayed: false,
      record: structuredClone(pending),
      completion,
    }
  }

  async execute<TRequest>(
    intent: EffectIntent<TRequest>,
    handler: EffectHandler<TRequest>,
  ): Promise<EffectRecord> {
    return this.start(intent, handler).completion
  }

  #validateIntent<TRequest>(intent: EffectIntent<TRequest>): string {
    if (!intent.operationId) {
      throw new EffectCoordinatorError('OPERATION_ID_REQUIRED', 'Effect operationId is required')
    }
    if (!intent.effectKind) {
      throw new EffectCoordinatorError('EFFECT_KIND_REQUIRED', 'Effect effectKind is required')
    }
    if (intent.requestDigest !== undefined) {
      if (!/^[0-9a-f]{64}$/u.test(intent.requestDigest))
        throw new EffectCoordinatorError(
          'EFFECT_INTENT_NOT_DURABLE',
          'Effect request fingerprint must be a 256-bit hexadecimal value',
        )
      return intent.requestDigest
    }
    return effectRequestDigest(intent)
  }

  async #dispatchNew<TRequest>(
    intent: EffectIntent<TRequest>,
    pending: EffectRecord,
    handler: EffectHandler<TRequest>,
  ): Promise<EffectRecord> {
    let outcome: EffectDispatchResult
    try {
      outcome = await handler.dispatch(this.#context(intent, pending.requestDigest))
    } catch {
      outcome = {
        status: 'unknown',
        detail: 'EFFECT_DISPATCH_UNKNOWN',
      }
    }
    return this.#persistOutcome(pending, outcome)
  }

  async #reconcilePending<TRequest>(
    intent: EffectIntent<TRequest>,
    requestDigest: string,
    pending: EffectRecord,
    handler: EffectHandler<TRequest>,
  ): Promise<EffectRecord> {
    let outcome: EffectDispatchResult | undefined
    try {
      outcome = await handler.reconcile?.(this.#context(intent, requestDigest))
    } catch {
      outcome = {
        status: 'unknown',
        detail: 'EFFECT_RECONCILIATION_UNKNOWN',
      }
    }
    if (outcome === undefined) return structuredClone(pending)
    return this.#persistOutcome(pending, outcome)
  }

  #persistOutcome(base: EffectRecord, outcome: EffectDispatchResult): EffectRecord {
    const detail = safeDetail(outcome.detail, `EFFECT_${outcome.status.toUpperCase()}`)
    const externalReference = safeExternalReference(outcome.externalReference)
    const next: EffectRecord = {
      ...base,
      status: outcome.status,
      updatedAt: this.#clock.now(),
      ...(detail === undefined ? {} : { detail }),
      ...(externalReference === undefined ? {} : { externalReference }),
    }
    try {
      this.#storage.appendEffect(next)
      this.#onRecord?.(structuredClone(next))
      return structuredClone(next)
    } catch (_error) {
      const unknown: EffectRecord = {
        ...base,
        status: 'unknown',
        updatedAt: this.#clock.now(),
        detail: 'EFFECT_OUTCOME_NOT_DURABLE',
      }
      try {
        this.#storage.appendEffect(unknown)
        try {
          this.#onRecord?.(structuredClone(unknown))
        } catch {
          // The effect record is durable even if a secondary state projection failed.
        }
      } catch {
        // Leave the pending record for a later reconciliation attempt.
      }
      return structuredClone(unknown)
    }
  }

  #context<TRequest>(
    intent: EffectIntent<TRequest>,
    requestDigest: string,
  ): EffectContext<TRequest> {
    return {
      operationId: intent.operationId,
      effectKind: intent.effectKind,
      requestDigest,
      request: intent.request,
      ...(intent.signal === undefined ? {} : { signal: intent.signal }),
    }
  }

  #resolvedHandle<TRequest>(
    intent: EffectIntent<TRequest>,
    requestDigest: string,
    record: EffectRecord,
    replayed: boolean,
  ): EffectHandle {
    return {
      operationId: intent.operationId,
      requestDigest,
      replayed,
      record: structuredClone(record),
      completion: Promise.resolve(structuredClone(record)),
    }
  }

  #key(operationId: string, requestDigest: string): string {
    return `${operationId}\u0000${requestDigest}`
  }

  #schedule(
    key: string,
    serializationKey: string,
    task: () => Promise<EffectRecord>,
  ): Promise<EffectRecord> {
    const completion = this.#serialize(serializationKey, task)
    const queued = { key, completion }
    this.#inFlight.set(key, queued)
    void completion.then(
      () => this.#clearInFlight(key, completion),
      () => this.#clearInFlight(key, completion),
    )
    return completion
  }

  #clearInFlight(key: string, completion: Promise<EffectRecord>): void {
    if (this.#inFlight.get(key)?.completion === completion) this.#inFlight.delete(key)
  }

  #serialize<T>(serializationKey: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(serializationKey) ?? Promise.resolve()
    let release!: () => void
    const tail = new Promise<void>((resolve) => {
      release = resolve
    })
    this.#tails.set(serializationKey, tail)
    return previous.then(task).finally(() => {
      release()
      if (this.#tails.get(serializationKey) === tail) this.#tails.delete(serializationKey)
    })
  }
}

export { SerializedEffectCoordinator as EffectCoordinator }
