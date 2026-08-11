import type { BraidEvent, BraidEventEnvelope } from '../domain/events.js'
import type { RunId } from '../domain/ids.js'
import type { BraidState } from '../domain/state.js'

/**
 * Durable event access used by the application controller.
 * A production adapter must make append durable before returning.
 */
export interface JournalPort {
  envelope(state: BraidState, event: BraidEvent): BraidEventEnvelope
  append(
    envelope: BraidEventEnvelope,
  ):
    | undefined
    | { readonly appended?: boolean }
    | Promise<{ readonly appended?: boolean } | undefined>
  all(): readonly BraidEventEnvelope[]
  /** Loads the complete persisted history needed to freeze one analysis source. */
  loadEvents?(input: { readonly runId?: RunId }): Promise<readonly BraidEventEnvelope[]>
  /** Resolves once an asynchronous durable journal has committed its queue. */
  flush?(): Promise<void>
  /** Drains pending writes before releasing the underlying durable store. */
  close?(): Promise<void>
}

export type EffectStatus =
  | 'pending'
  | 'acknowledged'
  | 'failed'
  | 'unknown'
  | 'conflict'
  | 'terminal'

export type EffectOutcomeStatus = Exclude<EffectStatus, 'pending' | 'conflict'>

export interface EffectRecord {
  readonly operationId: string
  readonly effectKind: string
  readonly requestDigest: string
  readonly status: EffectStatus
  readonly attempt: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly metadata: Readonly<Record<string, string>>
  readonly detail?: string
  readonly externalReference?: string
  readonly conflictWithDigest?: string
}

/**
 * Operation records are separate from the event journal because they guard
 * external mutations and must be reconciled by operation identity.
 */
export interface EffectStoragePort {
  /** Returns an opaque keyed binding for an exact request. The key stays in protected storage. */
  readonly fingerprint?: (input: {
    readonly effectKind: string
    readonly request: unknown
  }) => string
  /** Atomically admits one operation before any external dispatch. */
  reserveEffect(record: EffectRecord): { readonly record: EffectRecord; readonly created: boolean }
  current(operationId: string): EffectRecord | undefined
  latest(operationId: string, requestDigest: string): EffectRecord | undefined
  appendEffect(record: EffectRecord): void
  history(operationId: string): readonly EffectRecord[]
}
