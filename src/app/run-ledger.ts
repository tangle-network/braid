import type { BraidControlKind, BraidEventEnvelope } from '../domain/events.js'
import { isLiveRunStatus, type BraidState } from '../domain/state.js'
import type {
  ControlOperationRecord,
  OperationRecord,
  ShutdownRecord,
} from './application-types.js'

export interface InteractionOperationRecord {
  readonly digest: string
  readonly completion: Promise<BraidState>
}

export interface RunLedger {
  readonly getOperation: (operationId: string) => OperationRecord | undefined
  readonly setOperation: (record: OperationRecord) => void
  readonly getControl: (operationId: string) => ControlOperationRecord | undefined
  readonly setControl: (operationId: string, record: ControlOperationRecord) => void
  readonly deleteControl: (operationId: string) => void
  readonly getInteraction: (operationId: string) => InteractionOperationRecord | undefined
  readonly setInteraction: (operationId: string, record: InteractionOperationRecord) => void
  readonly getShutdown: (operationId: string) => ShutdownRecord | undefined
  readonly setShutdown: (operationId: string, record: ShutdownRecord) => void
  readonly operationForRun: (runId: string) => OperationRecord | undefined
  readonly controlForRun: (
    runId: string,
    kind?: BraidControlKind,
  ) => ControlOperationRecord | undefined
  readonly getAbort: (runId: string) => AbortController | undefined
  readonly setAbort: (runId: string, controller: AbortController) => void
  readonly deleteAbort: (runId: string) => void
  readonly isDetached: (runId: string) => boolean
  readonly markDetached: (runId: string) => void
  readonly clearDetached: (runId: string) => void
  readonly isExplicitlyCancelled: (runId: string) => boolean
  readonly markExplicitlyCancelled: (runId: string) => void
  readonly clearExplicitlyCancelled: (runId: string) => void
  readonly isCancellationPending: (runId: string) => boolean
  readonly markCancellationPending: (runId: string) => void
  readonly clearCancellationPending: (runId: string) => void
  readonly getCancelStatus: (runId: string) => 'cancelled' | 'aborted' | undefined
  readonly setCancelStatus: (runId: string, status: 'cancelled' | 'aborted') => void
  readonly clearCancelStatus: (runId: string) => void
  readonly claimQueueDrain: (operationId: string) => boolean
  readonly releaseQueueDrain: (operationId: string) => void
  readonly hasProviderEvent: (key: string) => boolean
  readonly addProviderEvent: (key: string) => void
  readonly restore: (events: readonly BraidEventEnvelope[], state: () => BraidState) => void
}

export function createRunLedger(): RunLedger {
  const operations = new Map<string, OperationRecord>()
  const controls = new Map<string, ControlOperationRecord>()
  const interactions = new Map<string, InteractionOperationRecord>()
  const shutdowns = new Map<string, ShutdownRecord>()
  const aborts = new Map<string, AbortController>()
  const detached = new Set<string>()
  const explicitCancellations = new Set<string>()
  const pendingCancellations = new Set<string>()
  const cancelStatuses = new Map<string, 'cancelled' | 'aborted'>()
  const queueDrains = new Set<string>()
  const providerEvents = new Set<string>()

  return {
    getOperation: (operationId) => operations.get(operationId),
    setOperation: (record) => operations.set(record.admission.operationId, record),
    getControl: (operationId) => controls.get(operationId),
    setControl: (operationId, record) => controls.set(operationId, record),
    deleteControl: (operationId) => controls.delete(operationId),
    getInteraction: (operationId) => interactions.get(operationId),
    setInteraction: (operationId, record) => interactions.set(operationId, record),
    getShutdown: (operationId) => shutdowns.get(operationId),
    setShutdown: (operationId, record) => shutdowns.set(operationId, record),
    operationForRun: (runId) => [...operations.values()].find((record) => record.runId === runId),
    controlForRun: (runId, kind) =>
      [...controls.values()].find(
        (record) => record.runId === runId && (kind === undefined || record.control === kind),
      ),
    getAbort: (runId) => aborts.get(runId),
    setAbort: (runId, controller) => aborts.set(runId, controller),
    deleteAbort: (runId) => aborts.delete(runId),
    isDetached: (runId) => detached.has(runId),
    markDetached: (runId) => detached.add(runId),
    clearDetached: (runId) => detached.delete(runId),
    isExplicitlyCancelled: (runId) => explicitCancellations.has(runId),
    markExplicitlyCancelled: (runId) => explicitCancellations.add(runId),
    clearExplicitlyCancelled: (runId) => explicitCancellations.delete(runId),
    isCancellationPending: (runId) => pendingCancellations.has(runId),
    markCancellationPending: (runId) => pendingCancellations.add(runId),
    clearCancellationPending: (runId) => pendingCancellations.delete(runId),
    getCancelStatus: (runId) => cancelStatuses.get(runId),
    setCancelStatus: (runId, status) => cancelStatuses.set(runId, status),
    clearCancelStatus: (runId) => cancelStatuses.delete(runId),
    claimQueueDrain: (operationId) => {
      if (queueDrains.has(operationId)) return false
      queueDrains.add(operationId)
      return true
    },
    releaseQueueDrain: (operationId) => queueDrains.delete(operationId),
    hasProviderEvent: (key) => providerEvents.has(key),
    addProviderEvent: (key) => providerEvents.add(key),
    restore: (events, state) => {
      for (const envelope of events) {
        const event = envelope.event
        if (event.kind === 'run.requested' && event.receipt) {
          const run = state().runs.find((candidate) => candidate.id === event.runId)
          if (run && isLiveRunStatus(run.status)) aborts.set(run.id, new AbortController())
        }
      }
    },
  }
}
