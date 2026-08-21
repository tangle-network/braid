import type { IsoDateTime, JsonObject, JsonValue } from './entities-base.js'
import type { MessageRecord, RunOverrides } from './entities-core.js'
import type {
  ArtifactId,
  BindingId,
  BranchId,
  ConnectionId,
  ConversationId,
  Digest,
  EnvironmentId,
  MessageId,
  MessagePartId,
  OperationId,
  ProfileSnapshotId,
  ProviderSessionId,
  ReceiptId,
  ReplayCursor,
  RunId,
  TurnId,
} from './ids.js'
import type { RuntimeRunFields } from './runtime-projection.js'

interface MessagePartBase {
  readonly id: MessagePartId
  readonly messageId: MessageId
  readonly ordinal: number
  readonly createdAt: IsoDateTime
  readonly updatedAt: IsoDateTime
}

export interface TextPartRecord extends MessagePartBase {
  readonly kind: 'text'
  readonly text: string
}

export interface ReasoningPartRecord extends MessagePartBase {
  readonly kind: 'reasoning'
  readonly text: string
}

export interface ToolCallPartRecord extends MessagePartBase {
  readonly kind: 'tool-call'
  readonly name: string
  readonly arguments: JsonObject
  readonly callId?: string
  readonly status: 'pending' | 'running' | 'completed' | 'failed'
}

export interface ToolResultPartRecord extends MessagePartBase {
  readonly kind: 'tool-result'
  readonly callId?: string
  readonly summary: string
  readonly output?: JsonValue
  readonly status: 'completed' | 'failed'
}

export interface ArtifactPartRecord extends MessagePartBase {
  readonly kind: 'artifact'
  readonly artifactId: ArtifactId
  readonly summary: string
}

export interface FilePartRecord extends MessagePartBase {
  readonly kind: 'file'
  readonly path?: string
  readonly filename?: string
  readonly mediaType?: string
}

export interface ImagePartRecord extends MessagePartBase {
  readonly kind: 'image'
  readonly artifactId?: ArtifactId
  readonly mediaType?: string
  readonly altText?: string
}

export interface WarningPartRecord extends MessagePartBase {
  readonly kind: 'warning'
  readonly message: string
}

export interface ErrorPartRecord extends MessagePartBase {
  readonly kind: 'error'
  readonly message: string
  readonly retryable: boolean
}

export interface UnknownPartRecord extends MessagePartBase {
  readonly kind: 'unknown'
  readonly namespace: string
  readonly type: string
  readonly summary: string
}

export type MessagePartRecord =
  | TextPartRecord
  | ReasoningPartRecord
  | ToolCallPartRecord
  | ToolResultPartRecord
  | ArtifactPartRecord
  | FilePartRecord
  | ImagePartRecord
  | WarningPartRecord
  | ErrorPartRecord
  | UnknownPartRecord

export type RunLifecycleStatus =
  | 'prepared'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'detached'
  | 'reconnecting'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'expired'
  | 'unknown'

export type RunStatus = RunLifecycleStatus | 'streaming' | 'aborted' | 'blocked'

export interface RunReceipt {
  readonly id: ReceiptId
  readonly operationId: OperationId
  readonly runId: RunId
  readonly turnId: TurnId
  readonly branchId: BranchId
  readonly profileSnapshotId?: ProfileSnapshotId
  readonly connectionId?: ConnectionId
  readonly profileDigest?: Digest
  readonly requested: RunOverrides
  readonly effective: RunOverrides
  readonly capabilitiesDigest?: Digest
  readonly completeness: 'complete' | 'incomplete' | 'unknown'
  readonly createdAt: IsoDateTime
}

export interface RunRecord extends RuntimeRunFields {
  readonly id: RunId
  readonly conversationId: ConversationId
  readonly branchId: BranchId
  readonly turnId: TurnId
  readonly operationId: OperationId
  readonly status: RunStatus
  readonly inputTokens: number
  readonly outputTokens: number
  /** False means inputTokens and outputTokens are only an observed floor. */
  readonly tokensKnown?: false
  readonly costUsd?: number
  /** False means costUsd is absent or only an observed floor. */
  readonly usdKnown?: false
  readonly estimatedCostUsd?: number
  readonly promptCache?: Readonly<Record<string, number>>
  readonly llmCalls?: number
  readonly llmLatencyMs?: number
  readonly model?: string
  readonly error?: string
  readonly profileSnapshotId?: ProfileSnapshotId
  readonly connectionId?: ConnectionId
  readonly providerSessionId?: ProviderSessionId
  /** Session identifier reported by the harness inside a retained provider run. */
  readonly harnessSessionId?: string
  readonly environmentId?: EnvironmentId
  readonly bindingId?: BindingId
  readonly receiptId?: ReceiptId
  readonly replayCursor?: ReplayCursor
  readonly complete: boolean
  readonly startedAt: IsoDateTime
  readonly updatedAt: IsoDateTime
  readonly terminalAt?: IsoDateTime
}

export type BraidMessage = MessageRecord
export type BraidRun = RunRecord
