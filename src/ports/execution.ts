import type {
  AgentEnvironmentCapabilities,
  AgentExactRunControlRef,
  AgentProfile,
  AgentWorkspaceBranching,
  AgentWorkspaceBranchingProvider,
  ConfidentialAttestationVerifier,
  ContextTransferRequest,
  ContextTransferResult,
  InteractionResponseCommand,
  NativeContextBoundaryProof,
  PortableContextPlanRequest,
  PortableContextPlanResult,
  WorkspaceRequest,
} from '@tangle-network/agent-interface'
import type { TurnUsage } from '../domain/entities.js'
import type { RunAdmissionReceipt } from '../domain/receipts.js'
import type {
  RequestedInteractions,
  RetainedRunAdmissionRecord,
  RetainedRunAdmissionRecorder,
  RunCapabilities,
} from '../domain/run-contracts.js'
import type { BraidRuntimeEvent, RuntimeEventEnvelope } from '../domain/runtime-events.js'
import type { RunStatus } from '../domain/state.js'

export type { RequestedInteractions, RunCapabilities } from '../domain/receipts.js'

export interface ExecuteTurnInput {
  readonly operationId: string
  readonly runId: string
  /** The durable turn identity shared by initial dispatch and recovery, when admitted. */
  readonly turnId?: string
  readonly text: string
  readonly profile: Readonly<AgentProfile>
  /** Selected branch mode captured before admission. */
  readonly mode?: string
  /** Exact per-turn interaction posture derived from admitted capabilities. */
  readonly interactions?: RequestedInteractions
  readonly connectionId?: string
  /** Provider-neutral remote workspace request. Separate from local workspaceRoot. */
  readonly workspaceRequest?: Readonly<WorkspaceRequest>
  readonly workspaceRoot?: string
  readonly signal: AbortSignal
  readonly sessionId?: string
  readonly after?: string
  readonly afterSequence?: number
  readonly contextBoundary?: string
  /** Exact provider proof required for one retry-safe same-session turn. */
  readonly nativeContextBoundaryProof?: NativeContextBoundaryProof
  /** Canonical context transfer request for a fresh destination session. */
  readonly contextTransfer?: ContextTransferRequest
  readonly onRetainedAdmission?: RetainedRunAdmissionRecorder
}

export type { RetainedRunAdmissionRecord, RetainedRunAdmissionRecorder }

export interface ExecutionAdmission {
  readonly capabilities?: RunCapabilities
  readonly provider?: string
  readonly environmentId?: string
  readonly providerSessionId?: string
  readonly materializationReceipt?: Readonly<Record<string, unknown>>
  readonly warnings?: readonly string[]
  readonly requestDigest?: string
  readonly profileDigest?: string
  readonly capabilitiesDigest?: string
  readonly materializationDigest?: string
}

/**
 * Optional provider-owned context planning and transfer operations.
 *
 * The payloads remain the canonical agent-interface contracts; this port only
 * describes how Braid reaches an adapter that implements them.
 */
export interface ContextTransferExecutionPort {
  readonly plan?: (input: PortableContextPlanRequest) => Promise<PortableContextPlanResult>
  readonly transfer?: (input: ContextTransferRequest) => Promise<ContextTransferResult>
  readonly lookup?: (input: ContextTransferRequest) => Promise<ContextTransferResult | undefined>
}

export interface ProviderRunSnapshot {
  readonly runId: string
  readonly status: RunStatus
  readonly sessionId?: string
  readonly cursor?: string
  readonly finalText?: string
  readonly usage?: TurnUsage
  readonly error?: string
  readonly detail?: string
}

/** Durable public data needed to reconstruct one retained execution after restart. */
export interface RetainedExecutionRecoveryContext {
  readonly retainedAdmission?: RetainedRunAdmissionRecord
  readonly receipt?: RunAdmissionReceipt
  /** Receipt-bound remote workspace request; absent on legacy receipts. */
  readonly workspaceRequest?: Readonly<WorkspaceRequest>
  readonly workspaceRoot?: string
}

export interface ControlAcknowledgement {
  readonly operationId: string
  readonly outcome: 'accepted' | 'already-applied' | 'rejected' | 'unknown'
  readonly detail?: string
}

export interface CancelRunInput extends RetainedExecutionRecoveryContext {
  readonly operationId: string
  readonly runId: string
  readonly providerSessionId?: string
  readonly controlRef?: AgentExactRunControlRef
  readonly reason?: string
}

export type CancelRunResult =
  | { readonly status: 'cancelled' }
  | { readonly status: 'unknown'; readonly reason: string }

export interface ExecutionCapabilities {
  readonly cancel: boolean
}

export interface ExecutionPort {
  /** Whether Braid must use the pending admission path for this adapter. */
  readonly admissionMode?: 'sync' | 'async'
  readonly capabilities?:
    | ExecutionCapabilities
    | ((input: ExecuteTurnInput) => RunCapabilities | Promise<RunCapabilities>)
  /** Current published agent-runtime path. Braid consumes normalized events only. */
  streamTurn(input: ExecuteTurnInput): AsyncIterable<BraidRuntimeEvent | RuntimeEventEnvelope>
  admit?(input: ExecuteTurnInput): ExecutionAdmission | Promise<ExecutionAdmission>
  cancelRun?(
    input: CancelRunInput & { readonly reason?: string; readonly signal?: AbortSignal },
  ): Promise<ControlAcknowledgement | CancelRunResult>
  detachRun?(
    input: {
      readonly runId: string
      readonly operationId: string
      readonly providerSessionId?: string
      readonly controlRef?: AgentExactRunControlRef
      readonly cursor?: string
      readonly signal?: AbortSignal
    } & RetainedExecutionRecoveryContext,
  ): Promise<ControlAcknowledgement>
  steerRun?(input: {
    readonly runId: string
    readonly operationId: string
    readonly text: string
    readonly signal?: AbortSignal
  }): Promise<ControlAcknowledgement>
  status?(
    input: {
      readonly runId: string
      readonly providerSessionId?: string
      readonly controlRef?: AgentExactRunControlRef
      readonly signal?: AbortSignal
    } & RetainedExecutionRecoveryContext,
  ): Promise<ProviderRunSnapshot | null>
  respondInteraction?(input: {
    readonly command: InteractionResponseCommand
    readonly signal?: AbortSignal
    readonly recovery?: RetainedExecutionRecoveryContext
  }): Promise<ControlAcknowledgement>
  reconnect?(
    input: {
      readonly runId: string
      readonly after?: string
      readonly afterSequence?: number
      readonly providerSessionId?: string
      readonly controlRef?: AgentExactRunControlRef
      readonly signal: AbortSignal
      readonly onRetainedAdmission?: RetainedRunAdmissionRecorder
    } & RetainedExecutionRecoveryContext,
  ): AsyncIterable<RuntimeEventEnvelope>
  nativeBoundary?(
    input: {
      readonly runId: string
      readonly sessionId: string
      readonly controlRef?: AgentExactRunControlRef
      readonly signal?: AbortSignal
    } & RetainedExecutionRecoveryContext,
  ): Promise<NativeContextBoundaryProof | null>
  environmentCapabilities?(): AgentEnvironmentCapabilities | Promise<AgentEnvironmentCapabilities>
  /** Provider-owned context planning and fresh-session transfer, when supported. */
  readonly context?: ContextTransferExecutionPort | undefined
  /** Alias retained for adapters that name the capability after its operation. */
  readonly contextTransfer?: ContextTransferExecutionPort | undefined
  /** Retry-safe checkpoint, fork, lookup, and cleanup operations, when supported. */
  readonly workspaceBranching?: AgentWorkspaceBranching | undefined
  /** Provider-owned source lookup used to reconstruct branching after restart. */
  readonly workspaceBranchingProvider?: AgentWorkspaceBranchingProvider | undefined
  /** External verifier required before Braid marks a confidential fork verified. */
  readonly confidentialAttestationVerifier?: ConfidentialAttestationVerifier | undefined
  /** Provider identity used when Braid builds a destination context plan. */
  readonly provider?: string | undefined
}

export const DEFAULT_RUN_CAPABILITIES: RunCapabilities = Object.freeze({
  streaming: { live: true, replay: false, detach: false, turnIdempotency: true },
  sessions: { continue: false, messages: false },
  controls: { cancel: true, steer: false, queue: true, status: false, recreate: false },
  events: { stableIdentity: false, sequence: true, cursor: false },
  usage: true,
})

export const UNKNOWN_RUN_CAPABILITIES: RunCapabilities = Object.freeze({
  streaming: { live: false, replay: false, detach: false, turnIdempotency: false },
  sessions: { continue: false, messages: false },
  controls: { cancel: false, steer: false, queue: false, status: false, recreate: false },
  events: { stableIdentity: false, sequence: false, cursor: false },
  usage: false,
})

/** Treat a published environment capability document as authoritative. */
/**
 * The runtime executes a response only when the environment document records
 * every acknowledgement, which is the same fact the runtime handle gates on.
 */
export function environmentSupportsInteractionResponse(
  environment: AgentEnvironmentCapabilities | undefined,
): boolean {
  return environment?.interactions?.responseIdempotency === true
}

export function supportsInteractionResponse(capabilities: RunCapabilities): boolean {
  return environmentSupportsInteractionResponse(capabilities.environment)
}

export function supportsNativeContinuation(capabilities: AgentEnvironmentCapabilities): boolean {
  return (
    capabilities.sessions.continue &&
    capabilities.nativeContinuation?.atomicBoundary === true &&
    capabilities.nativeContinuation.requestIdempotency === true &&
    capabilities.nativeContinuation.admissionControl === true
  )
}

/** A run can continue natively only when its environment proves safe replay and early control. */
export function runSupportsNativeContinuation(capabilities: RunCapabilities): boolean {
  return (
    capabilities.environment !== undefined && supportsNativeContinuation(capabilities.environment)
  )
}

export function capabilitiesFromEnvironment(
  capabilities: AgentEnvironmentCapabilities,
  cancellationSupported: boolean,
): RunCapabilities {
  return {
    // The provider may support replay or control methods that this port does
    // not expose. Only advertise the operations Braid can actually execute.
    streaming: {
      live: capabilities.streaming.live,
      replay: false,
      detach: false,
      turnIdempotency: capabilities.streaming.turnIdempotency,
    },
    sessions: {
      continue: capabilities.sessions.continue,
      messages: false,
    },
    controls: {
      cancel: cancellationSupported,
      steer: false,
      queue: false,
      status: false,
      recreate: false,
    },
    events: { stableIdentity: false, sequence: true, cursor: false },
    usage: capabilities.usage,
    environment: capabilities,
  }
}

export type NormalizedExecutionEvent = BraidRuntimeEvent | RuntimeEventEnvelope
