import type {
  AgentEnvironmentCapabilities,
  AgentExactRunControlRef,
  AgentProfile,
  RequestedInteractions,
} from '@tangle-network/agent-interface'
import type {
  RetainedInteractiveAdmission,
  RetainedRunAdmission,
} from '@tangle-network/agent-runtime/kernel'

export type { RequestedInteractions } from '@tangle-network/agent-interface'

/** Canonical Runtime recovery data that Braid persists before Runtime may proceed. */
export type RetainedRunAdmissionRecord = RetainedRunAdmission | RetainedInteractiveAdmission

export type RetainedRunAdmissionRecorder = (admission: RetainedRunAdmissionRecord) => Promise<void>

export interface RunControlCapabilities {
  readonly cancel: boolean
  readonly steer: boolean
  readonly queue: boolean
  readonly status: boolean
  readonly recreate: boolean
}

export interface RunEventCapabilities {
  readonly stableIdentity: boolean
  readonly sequence: boolean
  readonly cursor: boolean
}

export interface RunCapabilities {
  readonly streaming: {
    readonly live: boolean
    readonly replay: boolean
    readonly detach: boolean
    readonly turnIdempotency: boolean
  }
  readonly sessions: {
    readonly continue: boolean
    readonly messages: boolean
  }
  readonly controls: RunControlCapabilities
  readonly events: RunEventCapabilities
  readonly usage: boolean
  readonly environment?: Readonly<AgentEnvironmentCapabilities>
}

export interface PortableContextMessage {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'system' | 'tool'
  readonly parts: readonly PortableContextPart[]
}

export interface PortableAnalysisCitation {
  readonly id: string
  readonly eventId?: string
  readonly messageId?: string
  readonly partId?: string
  readonly start?: number
  readonly end?: number
  readonly quote?: string
}

export interface PortableAnalysisAttachment {
  readonly analysisId: string
  readonly analysisRunId?: string
  readonly sourceDigest: string
  readonly sourceRunId?: string
  readonly findings: readonly {
    readonly id: string
    readonly text: string
    readonly citations: readonly PortableAnalysisCitation[]
  }[]
  readonly provenance: Readonly<{
    readonly analystProfileDigest?: string
    readonly model?: string
    readonly runner?: string
    readonly agentEvalVersion?: string
  }>
}

export type PortableContextPart =
  | { readonly id: string; readonly type: 'text'; readonly text: string }
  | { readonly id: string; readonly type: 'reasoning'; readonly text: string }
  | {
      readonly id: string
      readonly type: 'file'
      readonly uri: string
      readonly mediaType?: string
    }
  | {
      readonly id: string
      readonly type: 'artifact'
      readonly uri: string
      readonly mediaType?: string
    }
  | { readonly id: string; readonly type: 'unknown'; readonly summary: string }

export interface PortableContextPlan {
  readonly sourceRunId: string
  readonly sourceBoundary: string
  readonly destinationRunner?: string
  readonly messages: readonly PortableContextMessage[]
  readonly analysisAttachments?: readonly PortableAnalysisAttachment[]
  readonly omittedPartIds: readonly string[]
  readonly transformedPartIds: readonly string[]
  readonly complete: boolean
  readonly tokenEstimate?: number
  readonly digest: string
}

export interface ContextTransferReceipt {
  readonly planDigest: string
  readonly sourceRunId: string
  readonly destinationRunId: string
  readonly destinationSessionId?: string
  readonly acceptedAt: string
}

export interface NativeContextBoundaryProof {
  readonly runId: string
  readonly providerSessionId: string
  readonly boundary: string
  readonly revision?: string
  readonly digest: string
}

export interface RunAdmissionReceipt {
  readonly version: 1
  readonly runId: string
  readonly turnId: string
  readonly operationId: string
  readonly conversationId: string
  readonly branchId: string
  readonly admittedAt: string
  readonly profileDigest: string
  readonly requested: {
    readonly text: string
    readonly profile: Readonly<AgentProfile>
    readonly connectionId?: string
    readonly mode?: string
    readonly interactions?: RequestedInteractions
    readonly model?: string
    readonly runner?: string
    readonly contextPlanDigest?: string
  }
  readonly capabilities: RunCapabilities
  readonly provider?: string
  readonly requestedSessionId?: string
  readonly environmentId?: string
  readonly providerSessionId?: string
  readonly materializationReceipt?: Readonly<Record<string, unknown>>
  readonly contextTransfer?: ContextTransferReceipt
  readonly nativeContextBoundaryProof?: NativeContextBoundaryProof
  readonly warnings?: readonly string[]
  readonly admissionStatus?: 'admitted' | 'pending' | 'unavailable'
  readonly requestDigest: string
  readonly capabilitiesDigest: string
  readonly materializationDigest?: string
  readonly digest: string
}
