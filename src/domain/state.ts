import type { AgentProfile } from '@tangle-network/agent-interface'
import type {
  AnalysisAttachmentRecord,
  AnalysisRecord,
  AppliedEventRecord,
  AutomationRuleRecord,
  BindingRecord,
  BraidMessage,
  BraidRun,
  BranchRecord,
  CheckpointRecord,
  ConnectionRecord,
  ConversationRecord,
  CredentialReference,
  DraftRecord,
  EffectRecord,
  EnvironmentRecord,
  FeedbackDecisionRecord,
  GraphEdgeRecord,
  GraphNodeRecord,
  MessagePartRecord,
  MissingHistoryRange,
  OperationRecord,
  ProfileRecord,
  ProfileSnapshotRecord,
  QueueEntryRecord,
  QueueRecord,
  ReplayCursorRecord,
  SupervisorRecord,
  TurnRecord,
  UnknownEventRecord,
  WorkerRecord,
  WorkspaceRecord,
} from './entities.js'
import type {
  BranchId,
  ConnectionId,
  ConversationId,
  Digest,
  ProfileId,
  RunId,
  WorkspaceId,
} from './ids.js'
import { createBranchId, createConversationId } from './ids.js'
import { redactProfile } from './redaction.js'
import type { QueuedInput } from './runtime-projection.js'

export type { BraidMessage, BraidRun, MessageRole, MessageStatus, RunStatus } from './entities.js'
export type {
  BraidActivity,
  BraidInteraction,
  MessagePartSource,
  QueuedInput,
  RuntimeMessagePart as BraidMessagePart,
  RuntimeMessagePartKind as MessagePartKind,
} from './runtime-projection.js'
export interface StateHealth {
  readonly status: 'healthy' | 'incomplete' | 'degraded'
  readonly lastError: string | null
  readonly missingHistoryCount: number
  readonly unknownEventCount: number
}

export interface BraidState {
  readonly schemaVersion: 2
  readonly revision: number
  readonly sequence: number

  /** Compatibility projection retained for the W0 terminal and RPC paths. */
  readonly workspace: string | null
  readonly workspaceId: WorkspaceId | null
  readonly conversationId: ConversationId
  readonly branchId: BranchId
  readonly selectedProfileId: ProfileId | null
  readonly selectedConnectionId: ConnectionId | null
  readonly profile: Readonly<AgentProfile>
  readonly draft: string
  readonly messages: readonly BraidMessage[]
  readonly messageParts: readonly MessagePartRecord[]
  readonly runs: readonly BraidRun[]
  readonly activeRunId: RunId | null
  readonly queuedInputs: readonly QueuedInput[]
  readonly lastError: string | null

  readonly workspaces: readonly WorkspaceRecord[]
  readonly profiles: readonly ProfileRecord[]
  readonly profileSnapshots: readonly ProfileSnapshotRecord[]
  readonly credentials: readonly CredentialReference[]
  readonly connections: readonly ConnectionRecord[]
  readonly conversations: readonly ConversationRecord[]
  readonly branches: readonly BranchRecord[]
  readonly turns: readonly TurnRecord[]
  readonly analyses: readonly AnalysisRecord[]
  readonly analysisAttachments: readonly AnalysisAttachmentRecord[]
  readonly environments: readonly EnvironmentRecord[]
  readonly checkpoints: readonly CheckpointRecord[]
  readonly supervisors: readonly SupervisorRecord[]
  readonly workers: readonly WorkerRecord[]
  readonly drafts: readonly DraftRecord[]
  readonly queues: readonly QueueRecord[]
  readonly queueEntries: readonly QueueEntryRecord[]
  readonly rules: readonly AutomationRuleRecord[]
  readonly bindings: readonly BindingRecord[]
  readonly graphNodes: readonly GraphNodeRecord[]
  readonly graphEdges: readonly GraphEdgeRecord[]
  readonly operations: readonly OperationRecord[]
  readonly effects: readonly EffectRecord[]
  readonly feedbackDecisions: readonly FeedbackDecisionRecord[]

  readonly replayCursors: readonly ReplayCursorRecord[]
  readonly missingHistory: readonly MissingHistoryRange[]
  readonly appliedEvents: readonly AppliedEventRecord[]
  readonly unknownEvents: readonly UnknownEventRecord[]
  readonly projectionChecksum: Digest | null
  readonly health: StateHealth
}

export function initialState(
  profile: Readonly<AgentProfile>,
  identity: { readonly conversationId?: ConversationId; readonly branchId?: BranchId } = {},
): BraidState {
  return {
    schemaVersion: 2,
    revision: 0,
    sequence: 0,
    workspace: null,
    workspaceId: null,
    conversationId: identity.conversationId ?? createConversationId('conv-1'),
    branchId: identity.branchId ?? createBranchId('branch-1'),
    selectedProfileId: null,
    selectedConnectionId: null,
    profile: redactProfile(profile),
    draft: '',
    messages: [],
    messageParts: [],
    runs: [],
    activeRunId: null,
    queuedInputs: [],
    lastError: null,
    workspaces: [],
    profiles: [],
    profileSnapshots: [],
    credentials: [],
    connections: [],
    conversations: [],
    branches: [],
    turns: [],
    analyses: [],
    analysisAttachments: [],
    environments: [],
    checkpoints: [],
    supervisors: [],
    workers: [],
    drafts: [],
    queues: [],
    queueEntries: [],
    rules: [],
    bindings: [],
    graphNodes: [],
    graphEdges: [],
    operations: [],
    effects: [],
    feedbackDecisions: [],
    replayCursors: [],
    missingHistory: [],
    appliedEvents: [],
    unknownEvents: [],
    projectionChecksum: null,
    health: {
      status: 'healthy',
      lastError: null,
      missingHistoryCount: 0,
      unknownEventCount: 0,
    },
  }
}
