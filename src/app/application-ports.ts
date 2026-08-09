import type { AgentProfile } from '@tangle-network/agent-interface'
import type { BraidEvent } from '../domain/events.js'
import type { RunAdmissionReceipt } from '../domain/receipts.js'
import type { BraidRun, BraidState, RunStatus } from '../domain/state.js'
import type { Clock } from '../ports/clock.js'
import type { EffectRecord } from '../ports/effect-storage.js'
import type { ControlAcknowledgement, ExecutionPort } from '../ports/execution.js'
import type { IdSource } from '../ports/ids.js'
import type { SendInput, SendReceipt } from './application-types.js'
import type { RunExecutionSnapshot } from './run-execution-snapshot.js'
import type { RunLedger } from './run-ledger.js'

export interface StateReader {
  readonly currentState: () => BraidState
  readonly profile: () => Readonly<AgentProfile>
  readonly findRun: (runId: string) => BraidRun
  readonly isTerminal: (
    status: RunStatus,
  ) => status is Extract<
    RunStatus,
    'completed' | 'failed' | 'aborted' | 'cancelled' | 'blocked' | 'expired' | 'unknown'
  >
}

export interface JournalWriter {
  readonly commit: (event: BraidEvent) => void
  readonly commitAndWait: (event: BraidEvent) => void | Promise<void>
  /** Retry one recovery event after a durable write has already failed. */
  readonly commitAndWaitRecovery?: (event: BraidEvent) => void | Promise<void>
}

export interface DurabilityWaiter {
  readonly flush: () => Promise<void>
  readonly storageFailure?: () => unknown
}

export interface ClockAccess {
  readonly clock: Clock
}

export interface IdentityAccess {
  readonly ids: IdSource
}

export interface ExecutionAccess {
  readonly execution: ExecutionPort
}

export interface LedgerAccess {
  readonly ledger: RunLedger
}

export interface AdmissionReplayAccess {
  readonly admitPersistedSend: (operationId: string, digest: string) => SendReceipt | undefined
  readonly fingerprint: (input: {
    readonly effectKind: string
    readonly request: unknown
  }) => string
}

export interface RunStarter {
  readonly startRun: (
    input: RunExecutionSnapshot,
    admission: RunAdmissionReceipt,
    abort: AbortController,
    requestDigest: string,
  ) => Promise<unknown>
}

export interface SendAccess {
  readonly send: (input: SendInput) => SendReceipt
}

export interface RuntimeIngestionAccess {
  readonly ingestRuntimeEvent: (
    envelope: RuntimeEventEnvelopeLike,
  ) => RuntimeEventIngestionResult | Promise<RuntimeEventIngestionResult>
}

export interface ReconnectAccess {
  readonly reconnectRun: (input: ReconnectInput) => Promise<BraidState>
}

export interface WaitAccess {
  readonly waitForRun: (runId: string) => Promise<BraidState>
}

export interface ControlDispatchAccess {
  readonly executeControl: (input: ControlEffectRequest) => Promise<ControlAcknowledgement>
}

export interface CancelTimingAccess {
  readonly cancelTimeoutMs: number
}

export type AdmissionPort = StateReader &
  JournalWriter &
  ClockAccess &
  IdentityAccess &
  ExecutionAccess &
  LedgerAccess &
  AdmissionReplayAccess &
  RunStarter

export type AsyncAdmissionPort = AdmissionPort & DurabilityWaiter

export type NativeContinuationPort = StateReader & ExecutionAccess & SendAccess

export type ExecutionRunPort = StateReader &
  JournalWriter &
  DurabilityWaiter &
  ClockAccess &
  ExecutionAccess &
  LedgerAccess &
  RuntimeIngestionAccess &
  ReconnectAccess &
  SendAccess

export type ControlPort = StateReader &
  JournalWriter &
  ExecutionAccess &
  LedgerAccess &
  ControlDispatchAccess & {
    readonly currentEffect: (operationId: string) => EffectRecord | undefined
  }

export type QueuePort = StateReader & JournalWriter

export type IngestionPort = StateReader & JournalWriter & LedgerAccess

export type ReplayPort = StateReader &
  JournalWriter &
  ExecutionAccess &
  LedgerAccess &
  RuntimeIngestionAccess

export type StatusPort = StateReader & LedgerAccess

export type RestartPort = StateReader & JournalWriter & ExecutionAccess

export interface ControlEffectRequest {
  readonly operationId: string
  readonly runId: string
  readonly control: 'cancel' | 'steer' | 'detach'
  readonly providerSessionId?: string
  readonly reason?: string
  readonly text?: string
  readonly cursor?: string
}

export type RuntimeEventEnvelopeLike = import('../domain/runtime-events.js').RuntimeEventEnvelope

export interface RuntimeEventIngestionResult {
  readonly accepted: boolean
  readonly duplicate: boolean
  readonly sequenceGap?: { readonly from: number; readonly to: number }
}

export interface ReconnectInput {
  readonly operationId: string
  readonly runId: string
}
