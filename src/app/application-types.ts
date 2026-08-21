import type { BraidControlKind, BraidEventEnvelope } from '../domain/events.js'
import type {
  ContextTransferReceipt,
  NativeContextBoundaryProof,
  PortableContextPlan,
  RunAdmissionReceipt,
} from '../domain/receipts.js'
import type { BraidState, RunStatus } from '../domain/state.js'
import type { ControlAcknowledgement } from '../ports/execution.js'

export type AppSubscriber = (state: BraidState, envelope: BraidEventEnvelope) => void

export interface SendInput {
  readonly operationId: string
  readonly text: string
  /** One-run execution mode override. It does not mutate the branch selection. */
  readonly mode?: string
  readonly conversationId?: string
  readonly branchId?: string
  readonly sessionId?: string
  readonly contextPlan?: PortableContextPlan
  readonly contextTransfer?: ContextTransferReceipt
  readonly nativeContextBoundaryProof?: NativeContextBoundaryProof
}

export interface SendReceipt {
  readonly operationId: string
  readonly runId: string
  readonly revision: number
  readonly replayed: boolean
  readonly admission: RunAdmissionReceipt
  /** Resolves when admission and run.requested are durably committed. */
  readonly admissionReady?: Promise<void>
  readonly completion: Promise<BraidState>
}

export interface QueueReceipt {
  readonly operationId: string
  readonly runId: string
  readonly position: number
  readonly revision: number
  readonly completion?: Promise<void>
}

export interface ControlReceipt {
  readonly operationId: string
  readonly runId: string
  readonly control: BraidControlKind
  readonly replayed: boolean
  readonly acknowledgement: ControlAcknowledgement
  readonly status: RunStatus
  readonly completion: Promise<BraidState>
}

export interface ShutdownReceipt {
  readonly operationId: string
  readonly revision: number
  readonly replayed: boolean
  readonly outcome?: 'idle' | 'detached' | 'cancelled' | 'waiting'
  readonly runId?: string
  readonly state?: BraidState
  readonly completion: Promise<BraidState>
}

export interface ShutdownRecord {
  readonly digest: string
  readonly completion: Promise<BraidState>
}

export interface OperationRecord {
  readonly digest: string
  readonly runId: string
  readonly admission: RunAdmissionReceipt
  completion: Promise<unknown>
}

export interface ControlOperationRecord {
  readonly digest: string
  readonly runId: string
  readonly control: BraidControlKind
  readonly completion: Promise<BraidState>
  readonly acknowledgement: Promise<ControlAcknowledgement>
  /** Resolves after the bounded foreground result has been durably recorded. */
  readonly lateSettlementReady?: Promise<void>
  /** Coalesces duplicate late provider callbacks for one operation. */
  readonly lateSettlement?: Promise<void>
  readonly providerSessionId?: string
  readonly reason?: string
  readonly text?: string
  readonly cursor?: string
}

export interface InteractionReceipt {
  readonly operationId: string
  readonly runId: string
  readonly interactionId: string
  readonly replayed: boolean
  readonly acknowledgement: ControlAcknowledgement
  readonly completion: Promise<BraidState>
}
