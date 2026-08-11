import type {
  AgentExactRunControlRef,
  AgentEnvironmentCapabilities,
  AgentProfile,
  InteractionResponseCommand,
} from '@tangle-network/agent-interface'
import type { RunCapabilities } from '../domain/receipts.js'
import type { BraidRuntimeEvent, RuntimeEventEnvelope } from '../domain/runtime-events.js'
import type { TurnUsage } from '../domain/entities.js'
import type { RunStatus } from '../domain/state.js'

export type { RunCapabilities } from '../domain/receipts.js'

export interface ExecuteTurnInput {
  readonly operationId: string
  readonly runId: string
  readonly text: string
  readonly profile: Readonly<AgentProfile>
  readonly connectionId?: string
  readonly workspaceRoot?: string
  readonly signal: AbortSignal
  readonly sessionId?: string
  readonly after?: string
  readonly afterSequence?: number
  readonly contextBoundary?: string
}

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

export interface ControlAcknowledgement {
  readonly operationId: string
  readonly outcome: 'accepted' | 'already-applied' | 'rejected' | 'unknown'
  readonly detail?: string
}

export interface CancelRunInput {
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
  detachRun?(input: {
    readonly runId: string
    readonly operationId: string
    readonly providerSessionId?: string
    readonly controlRef?: AgentExactRunControlRef
    readonly cursor?: string
    readonly signal?: AbortSignal
  }): Promise<ControlAcknowledgement>
  steerRun?(input: {
    readonly runId: string
    readonly operationId: string
    readonly text: string
    readonly signal?: AbortSignal
  }): Promise<ControlAcknowledgement>
  status?(input: {
    readonly runId: string
    readonly providerSessionId?: string
    readonly controlRef?: AgentExactRunControlRef
    readonly signal?: AbortSignal
  }): Promise<ProviderRunSnapshot | null>
  respondInteraction?(input: {
    readonly command: InteractionResponseCommand
    readonly signal?: AbortSignal
  }): Promise<ControlAcknowledgement>
  reconnect?(input: {
    readonly runId: string
    readonly after?: string
    readonly afterSequence?: number
    readonly providerSessionId?: string
    readonly controlRef?: AgentExactRunControlRef
    readonly signal: AbortSignal
  }): AsyncIterable<RuntimeEventEnvelope>
  nativeBoundary?(input: {
    readonly runId: string
    readonly sessionId: string
    readonly signal?: AbortSignal
  }): Promise<{
    readonly boundary: string
    readonly digest: string
    readonly revision?: string
  } | null>
  environmentCapabilities?(): AgentEnvironmentCapabilities | Promise<AgentEnvironmentCapabilities>
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
