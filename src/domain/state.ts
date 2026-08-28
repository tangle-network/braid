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
  RunStatus,
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

/** Identifies one run that is still able to produce work. */
export interface ActiveRunRef {
  readonly runId: RunId
  readonly conversationId: ConversationId
  readonly branchId: BranchId
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
  /** All non-terminal runs, grouped by their immutable conversation and branch identity. */
  readonly activeRuns: readonly ActiveRunRef[]
  /** The run that owns foreground controls and the current work focus. */
  readonly focusedRunId: RunId | null
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
    activeRuns: [],
    focusedRunId: null,
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

const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'completed',
  'failed',
  'aborted',
  'cancelled',
  'blocked',
  'expired',
  'unknown',
]

/** Returns true while a run can still receive provider or user work. */
export function isActiveRunStatus(status: RunStatus): boolean {
  return !TERMINAL_RUN_STATUSES.includes(status)
}

/** Returns true while Braid still owns a live local execution operation. */
export function isLiveRunStatus(status: RunStatus): boolean {
  return isActiveRunStatus(status) && status !== 'detached'
}

/** Derives the branch-scoped active run index from canonical run records. */
export function activeRunRefs(state: BraidState): readonly ActiveRunRef[] {
  return state.runs
    .filter((run) => isActiveRunStatus(run.status))
    .map((run) => ({
      runId: run.id,
      conversationId: run.conversationId,
      branchId: run.branchId,
    }))
}

/** Returns the active run for one branch without using the compatibility focus alias. */
export function activeRunForBranch(
  state: BraidState,
  conversationId: string,
  branchId: string,
): BraidRun | undefined {
  return state.runs.find(
    (run) =>
      run.conversationId === conversationId &&
      run.branchId === branchId &&
      isActiveRunStatus(run.status),
  )
}

/** Rebuilds active-run refs and keeps the old activeRunId field as a focused-run alias. */
export function normalizeActiveRuns(state: BraidState, preferredRunId?: RunId | null): BraidState {
  const activeRuns = activeRunRefs(state)
  const activeIds = new Set(activeRuns.map((run) => run.runId))
  const existingFocus = state.focusedRunId ?? state.activeRunId
  const requestedFocus = preferredRunId === undefined ? existingFocus : preferredRunId
  const focusedRun =
    requestedFocus !== null && requestedFocus !== undefined
      ? state.runs.find((run) => run.id === requestedFocus)
      : undefined
  const fallback = activeRuns.at(-1)?.runId
  const focusedRunId = focusedRun?.id ?? fallback ?? null
  return {
    ...state,
    activeRuns,
    focusedRunId,
    activeRunId: focusedRunId !== null && activeIds.has(focusedRunId) ? focusedRunId : null,
  }
}
