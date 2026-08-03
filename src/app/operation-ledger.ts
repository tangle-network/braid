import { canonicalDigest } from '../domain/canonical.js'
import type { BraidEventEnvelope } from '../domain/events.js'

export type LedgerOperationKind = 'send' | 'cancel' | 'shutdown'

export interface OperationRecord {
  readonly kind: LedgerOperationKind
  readonly digest: string
  readonly runId?: string
  completion: Promise<void>
}

export const DEFAULT_CANCEL_REASON = 'Cancelled by user'

export function cancelRequestDigest(runId: string, reason: string): string {
  return canonicalDigest({ command: 'cancel_run', runId, reason })
}

export function shutdownRequestDigest(): string {
  return canonicalDigest({ command: 'shutdown' })
}

/**
 * In-process registry binding an operation identifier to the work it started.
 *
 * Run dispatch identity is durable in effect storage, because a run reaches an
 * external provider and must never be repeated after a crash. Cancellation and
 * shutdown are journalled instead of admitted through the effect coordinator,
 * which serializes dispatches and would therefore queue a cancellation behind
 * the very run it is meant to stop, so their identity is rebuilt from the
 * journal at startup.
 */
export class OperationLedger {
  readonly #records = new Map<string, OperationRecord>()

  get(operationId: string): OperationRecord | undefined {
    return this.#records.get(operationId)
  }

  set(operationId: string, record: OperationRecord): void {
    this.#records.set(operationId, record)
  }

  delete(operationId: string): void {
    this.#records.delete(operationId)
  }

  forRun(runId: string): readonly OperationRecord[] {
    return [...this.#records.values()].filter((entry) => entry.runId === runId)
  }

  restore(envelopes: readonly BraidEventEnvelope[]): void {
    for (const envelope of envelopes) {
      const event = envelope.event
      if (event.kind === 'run.cancel.requested') {
        this.#records.set(event.operationId, {
          kind: 'cancel',
          digest: cancelRequestDigest(event.runId, event.reason ?? DEFAULT_CANCEL_REASON),
          runId: event.runId,
          completion: Promise.resolve(),
        })
      } else if (event.kind === 'application.shutdown.requested') {
        this.#records.set(event.operationId, {
          kind: 'shutdown',
          digest: shutdownRequestDigest(),
          completion: Promise.resolve(),
        })
      }
    }
  }
}
