import type { AgentExactRunControlRef } from '@tangle-network/agent-interface'
import type { AgentTurnResult } from '@tangle-network/agent-interface/environment-provider'
import type { RetainedRunHandle } from '@tangle-network/agent-runtime/kernel'
import type { TurnUsage } from '../../domain/entities.js'
import type { ExecutionEnvironmentObservation } from '../../domain/execution-observation.js'
import type { RuntimeEventEnvelope } from '../../domain/runtime-events.js'
import type {
  ExecuteTurnInput,
  ProviderRunSnapshot,
  RetainedExecutionRecoveryContext,
  RetainedRunAdmissionRecord,
  RetainedRunAdmissionRecorder,
  RunCapabilities,
} from '../../ports/execution.js'

export interface RetainedResultProjection {
  readonly text: string
  readonly usage: TurnUsage
  readonly error?: string
}

/** Provider-specific facts and operations needed by the retained lifecycle. */
export interface RetainedExecutionPlan {
  readonly providerName: string
  /** False when the provider cannot bind status to this exact execution. */
  readonly exactStatus?: boolean
  /** Unknown until a provider with server-issued ids admits the first run. */
  readonly environmentId?: string
  readonly providerSessionId?: string
  readonly model: string
  readonly capabilities: RunCapabilities
  readonly materializationReceipt: Readonly<Record<string, unknown>>
  readonly start: (input: ExecuteTurnInput) => Promise<RetainedRunHandle>
  readonly reconnect: (
    controlRef: AgentExactRunControlRef,
    signal?: AbortSignal,
  ) => Promise<RetainedRunHandle | null>
  /** Recover a persisted intent or pre-dispatch admission with Runtime. */
  readonly recover?: (
    input: RetainedExecutionRecoveryContext & {
      readonly admission: RetainedRunAdmissionRecord
      readonly onRetainedAdmission?: RetainedRunAdmissionRecorder
      readonly signal?: AbortSignal
    },
  ) => Promise<RetainedRunHandle | null>
  readonly discover: (
    braidRunId: string,
    signal?: AbortSignal,
  ) => Promise<AgentExactRunControlRef | null>
  readonly observe: () => Promise<ExecutionEnvironmentObservation | undefined>
  readonly projectStatus: (input: {
    readonly status: string | null
    readonly detached: boolean
  }) => ProviderRunSnapshot['status']
  readonly isTerminalStatus: (status: ProviderRunSnapshot['status']) => boolean
  readonly projectResult: (result: AgentTurnResult) => RetainedResultProjection
  readonly projectFinal: (input: {
    readonly runId: string
    readonly sequence: number
    readonly result: AgentTurnResult
  }) => RuntimeEventEnvelope
}

export interface RetainedExecutionDriver {
  readonly resolve: (input: ExecuteTurnInput) => Promise<RetainedExecutionPlan>
  readonly recover: (
    input: {
      readonly runId: string
      readonly providerSessionId?: string
      readonly controlRef?: AgentExactRunControlRef
      readonly signal?: AbortSignal
    } & RetainedExecutionRecoveryContext,
  ) => Promise<RetainedExecutionPlan>
}
