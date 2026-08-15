import type { AgentProfile } from '@tangle-network/agent-interface'
import type {
  AnalysisAttachmentRecord,
  AnalysisRecord,
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
  OperationRecord,
  ProfileRecord,
  ProfileSnapshotRecord,
  QueueEntryRecord,
  QueueRecord,
  ReplayCursorRecord,
  SupervisorRecord,
  TurnRecord,
  WorkerRecord,
  WorkspaceRecord,
} from './entities.js'
import type { BranchId, ConversationId, RunId, WorkspaceId } from './ids.js'
import type { BraidState } from './state.js'

export interface MaterializedState {
  readonly schemaVersion: BraidState['schemaVersion']
  readonly workspace: string | null
  readonly workspaceId: WorkspaceId | null
  readonly conversationId: ConversationId
  readonly branchId: BranchId
  readonly selectedProfileId: BraidState['selectedProfileId']
  readonly selectedConnectionId: BraidState['selectedConnectionId']
  readonly profile: Readonly<AgentProfile>
  readonly draft: string
  readonly messages: readonly BraidMessage[]
  readonly messageParts: readonly MessagePartRecord[]
  readonly runs: readonly BraidRun[]
  readonly activeRunId: RunId | null
  readonly queuedInputs: BraidState['queuedInputs']
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
  readonly rules: BraidState['rules']
  readonly bindings: readonly BindingRecord[]
  readonly graphNodes: readonly GraphNodeRecord[]
  readonly graphEdges: readonly GraphEdgeRecord[]
  readonly operations: readonly OperationRecord[]
  readonly effects: readonly EffectRecord[]
  readonly feedbackDecisions: readonly FeedbackDecisionRecord[]
  readonly replayCursors: readonly ReplayCursorRecord[]
  readonly missingHistory: readonly BraidState['missingHistory'][number][]
}
