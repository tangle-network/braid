import { canonicalDigest } from '../domain/canonical.js'
import type { BraidEventEnvelope } from '../domain/events.js'
import type { BraidState } from '../domain/state.js'

export type OperationKind = 'send' | 'cancel' | 'shutdown'

export interface OperationRecord {
  readonly kind: OperationKind
  readonly digest: string
  readonly runId?: string
  completion: Promise<void>
}

export class OperationLedger {
  readonly #records = new Map<string, OperationRecord>()

  get(operationId: string): OperationRecord | undefined {
    return this.#records.get(operationId)
  }

  set(operationId: string, record: OperationRecord): void {
    this.#records.set(operationId, record)
  }

  forRun(runId: string): OperationRecord[] {
    return [...this.#records.values()].filter((entry) => entry.runId === runId)
  }

  restore(envelopes: readonly BraidEventEnvelope[], state: BraidState): void {
    for (const envelope of envelopes) {
      const event = envelope.event
      if (event.kind === 'run.requested') {
        this.#records.set(event.operationId, {
          kind: 'send',
          digest: canonicalDigest({
            command: 'send',
            conversationId: state.conversationId,
            branchId: state.branchId,
            text: event.text,
            profile: state.profile,
          }),
          runId: event.runId,
          completion: Promise.resolve(),
        })
      } else if (event.kind === 'run.cancel.requested') {
        this.#records.set(event.operationId, {
          kind: 'cancel',
          digest: canonicalDigest({
            command: 'cancel_run',
            runId: event.runId,
            reason: event.reason ?? 'Cancelled by user',
          }),
          runId: event.runId,
          completion: Promise.resolve(),
        })
      } else if (event.kind === 'application.shutdown.requested') {
        this.#records.set(event.operationId, {
          kind: 'shutdown',
          digest: canonicalDigest({ command: 'shutdown' }),
          completion: Promise.resolve(),
        })
      }
    }
  }
}
