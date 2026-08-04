import type { RunAdmissionReceipt } from '../domain/receipts.js'
import type { Clock } from '../ports/clock.js'
import type { ExecutionPort } from '../ports/execution.js'
import type { IdSource } from '../ports/ids.js'
import type {
  AdmissionPort,
  AsyncAdmissionPort,
  ControlPort,
  ExecutionRunPort,
  IngestionPort,
  JournalWriter,
  NativeContinuationPort,
  QueuePort,
  ReplayPort,
  RestartPort,
  StateReader,
  StatusPort,
} from './application-ports.js'
import type { SendInput, SendReceipt } from './application-types.js'
import type { SerializedEffectCoordinator } from './effect-coordinator.js'
import type { RunExecutionSnapshot } from './run-execution-snapshot.js'
import { ingestRuntimeEvent } from './run-ingestion.js'
import type { RunLedger } from './run-ledger.js'
import { reconnectRun } from './run-replay.js'

export interface PortViews {
  readonly state: StateReader
  readonly journal: JournalWriter
  readonly restart: RestartPort
  readonly queue: QueuePort
  readonly control: ControlPort
  readonly ingestion: IngestionPort
  readonly replay: ReplayPort
  readonly status: StatusPort
  readonly executionRun: ExecutionRunPort
  readonly admission: AdmissionPort
  readonly asyncAdmission: AsyncAdmissionPort
  readonly nativeContinuation: NativeContinuationPort
}

export interface PortBuilderInput {
  readonly state: StateReader
  readonly journal: JournalWriter
  readonly execution: ExecutionPort
  readonly ledger: RunLedger
  readonly effects: SerializedEffectCoordinator
  readonly clock: Clock
  readonly ids: IdSource
  readonly flush: () => Promise<void>
  readonly storageFailure: () => unknown
  readonly executeControl: (
    input: import('./application-ports.js').ControlEffectRequest,
  ) => Promise<import('../ports/execution.js').ControlAcknowledgement>
  readonly admitPersistedSend: (operationId: string, digest: string) => SendReceipt | undefined
  readonly fingerprint: AdmissionPort['fingerprint']
  readonly startRun: (
    context: ExecutionRunPort,
    input: RunExecutionSnapshot,
    admission: RunAdmissionReceipt,
    abort: AbortController,
    requestDigest: string,
  ) => Promise<unknown>
  readonly send: (input: SendInput) => SendReceipt
}

export function buildPortViews(input: PortBuilderInput): PortViews {
  const restart: RestartPort = {
    ...input.state,
    ...input.journal,
    execution: input.execution,
  }
  const queue: QueuePort = { ...input.state, ...input.journal }
  const control: ControlPort = {
    ...input.state,
    ...input.journal,
    execution: input.execution,
    ledger: input.ledger,
    executeControl: input.executeControl,
    currentEffect: (operationId) => input.effects.current(operationId),
  }
  const ingestion: IngestionPort = { ...input.state, ...input.journal, ledger: input.ledger }
  const replay: ReplayPort = {
    ...input.state,
    ...input.journal,
    execution: input.execution,
    ledger: input.ledger,
    ingestRuntimeEvent: (envelope) => ingestRuntimeEvent(ingestion, envelope),
  }
  const status: StatusPort = { ...input.state, ledger: input.ledger }
  const executionRun: ExecutionRunPort = {
    ...input.state,
    ...input.journal,
    flush: input.flush,
    storageFailure: input.storageFailure,
    clock: input.clock,
    execution: input.execution,
    ledger: input.ledger,
    ingestRuntimeEvent: (envelope) => ingestRuntimeEvent(ingestion, envelope),
    reconnectRun: (request) => reconnectRun(replay, request),
    send: input.send,
  }
  const admission: AdmissionPort = {
    ...input.state,
    ...input.journal,
    clock: input.clock,
    ids: input.ids,
    execution: input.execution,
    ledger: input.ledger,
    admitPersistedSend: input.admitPersistedSend,
    fingerprint: input.fingerprint,
    startRun: (runInput, receipt, abort, requestDigest) =>
      input.startRun(executionRun, runInput, receipt, abort, requestDigest),
  }
  return {
    state: input.state,
    journal: input.journal,
    restart,
    queue,
    control,
    ingestion,
    replay,
    status,
    executionRun,
    admission,
    asyncAdmission: { ...admission, flush: input.flush },
    nativeContinuation: { ...input.state, execution: input.execution, send: input.send },
  }
}
