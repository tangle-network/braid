import type { AgentExactRunControlRef } from '@tangle-network/agent-interface'
import type {
  AnalysisAttachmentRecord,
  AnalysisRecord,
  AutomationAuditRecord,
  BindingRecord,
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
  MessageRecord,
  MissingHistoryRange,
  OperationRecord,
  ProfileRecord,
  ProfileSnapshotRecord,
  QueueEntryRecord,
  QueueRecord,
  RunRecord,
  SupervisorRecord,
  TurnRecord,
  UnknownEventRecord,
  WorkerRecord,
  WorkspaceRecord,
} from './entities.js'
import type { LegacyBraidEvent, ProviderEventMeta } from './events-legacy.js'
import type { ExecutionEnvironmentObservation } from './execution-observation.js'
import type {
  AnalysisId,
  AnalysisRunId,
  BindingId,
  BranchId,
  CheckpointId,
  ConnectionId,
  ConversationId,
  CredentialRefId,
  Digest,
  DraftId,
  EffectId,
  EventId,
  FeedbackDecisionId,
  GraphEdgeId,
  GraphNodeId,
  MessageId,
  MessagePartId,
  OperationId,
  ProfileId,
  ProfileSnapshotId,
  ReplayCursor,
  RunId,
  SupervisorId,
  TurnId,
  WorkerId,
} from './ids.js'
import type { RunStatus } from './state.js'
import type { RetainedRunAdmissionRecord } from './run-contracts.js'

export type { TurnUsage } from './entities.js'
export type {
  BraidControlKind,
  LegacyBraidEvent,
  ProviderEventMeta,
  RunTerminalStatus,
} from './events-legacy.js'

interface RunReconciledPayload {
  readonly runId: RunId
  readonly status: RunStatus
  readonly evidence: Digest
  readonly from?: RunStatus
  readonly to?: RunStatus
  readonly detail?: string
}

type RunReconciledEventPayload =
  | (RunReconciledPayload & {
      readonly correction?: never
      readonly operationId?: never
    })
  | (RunReconciledPayload & {
      readonly correction: 'cancellation-confirmed'
      readonly operationId: OperationId
    })

export interface DomainBraidEventMap {
  readonly 'workspace.recorded': { readonly workspace: WorkspaceRecord }
  readonly 'profile.registered': { readonly profile: ProfileRecord }
  readonly 'profile.selected': { readonly profileId: ProfileId }
  readonly 'profile.snapshot.created': { readonly snapshot: ProfileSnapshotRecord }
  readonly 'credential.reference.created': { readonly credential: CredentialReference }
  readonly 'connection.upserted': { readonly connection: ConnectionRecord }
  readonly 'connection.selected': { readonly connectionId: ConnectionId }
  readonly 'connection.removed': {
    readonly connectionId: ConnectionId
    readonly operation: OperationRecord
  }
  readonly 'conversation.created': {
    readonly conversation: ConversationRecord
    readonly branch?: BranchRecord
    readonly draft?: DraftRecord
    readonly queue?: QueueRecord
    readonly graphNodes?: readonly GraphNodeRecord[]
    readonly graphEdges?: readonly GraphEdgeRecord[]
    readonly operation?: OperationRecord
  }
  readonly 'conversation.imported': {
    readonly conversation: ConversationRecord
    readonly branches: readonly BranchRecord[]
    readonly drafts: readonly DraftRecord[]
    readonly queues: readonly QueueRecord[]
    readonly messages: readonly MessageRecord[]
    readonly messageParts: readonly MessagePartRecord[]
    readonly turns: readonly TurnRecord[]
    readonly runs: readonly RunRecord[]
    readonly analyses: readonly AnalysisRecord[]
    readonly graphNodes: readonly GraphNodeRecord[]
    readonly graphEdges: readonly GraphEdgeRecord[]
    readonly feedbackDecisions: readonly FeedbackDecisionRecord[]
    readonly sourceContentDigest: Digest
    readonly operation: OperationRecord
  }
  readonly 'conversation.updated': {
    readonly conversation: ConversationRecord
    readonly operation?: OperationRecord
  }
  readonly 'conversation.selected': {
    readonly conversationId: ConversationId
    readonly branchId?: BranchId
    readonly conversation?: ConversationRecord
    readonly operation?: OperationRecord
  }
  readonly 'conversation.deleted': {
    readonly conversation: ConversationRecord
    readonly selectedConversation: ConversationRecord
    readonly replacementBranch?: BranchRecord
    readonly replacementDraft?: DraftRecord
    readonly replacementQueue?: QueueRecord
    readonly graphNodes?: readonly GraphNodeRecord[]
    readonly graphEdges?: readonly GraphEdgeRecord[]
    readonly operation: OperationRecord
  }
  readonly 'branch.created': {
    readonly branch: BranchRecord
    readonly conversation?: ConversationRecord
    readonly draft?: DraftRecord
    readonly queue?: QueueRecord
    readonly graphNodes?: readonly GraphNodeRecord[]
    readonly graphEdges?: readonly GraphEdgeRecord[]
    readonly operation?: OperationRecord
  }
  readonly 'branch.updated': {
    readonly branch: BranchRecord
    readonly operation: OperationRecord
  }
  readonly 'branch.selected': {
    readonly conversationId: ConversationId
    readonly branchId: BranchId
    readonly operation?: OperationRecord
  }
  readonly 'turn.created': { readonly turn: TurnRecord }
  readonly 'turn.updated': { readonly turn: TurnRecord }
  readonly 'message.created': { readonly message: MessageRecord }
  readonly 'message.part.updated': { readonly part: MessagePartRecord }
  readonly 'run.bound': { readonly runId: RunId; readonly bindingId: BindingId }
  readonly 'run.retained.admitted': {
    readonly runId: RunId
    readonly admission: RetainedRunAdmissionRecord
  }
  readonly 'run.status.changed': {
    readonly runId: RunId
    readonly status: RunStatus
    readonly error?: string
    readonly detail?: string
    readonly provider?: ProviderEventMeta
  }
  /**
   * A cancellation correction must carry the durable cancel operation id.
   * Ordinary provider reconciliation has no operation id.
   */
  readonly 'run.reconciled': RunReconciledEventPayload
  readonly 'run.environment.observed': {
    readonly runId: RunId
    readonly observation: ExecutionEnvironmentObservation
    readonly controlRef?: AgentExactRunControlRef
    readonly provider: ProviderEventMeta
  }
  readonly 'history.missing': { readonly range: MissingHistoryRange }
  readonly 'analysis.created': { readonly analysis: AnalysisRecord }
  readonly 'analysis.updated': { readonly analysis: AnalysisRecord }
  readonly 'analysis.completed': { readonly analysis: AnalysisRecord }
  readonly 'analysis.attachment.created': { readonly attachment: AnalysisAttachmentRecord }
  readonly 'environment.upserted': { readonly environment: EnvironmentRecord }
  readonly 'checkpoint.upserted': { readonly checkpoint: CheckpointRecord }
  readonly 'supervisor.upserted': { readonly supervisor: SupervisorRecord }
  readonly 'worker.upserted': { readonly worker: WorkerRecord }
  readonly 'draft.recorded': {
    readonly draft: DraftRecord
    readonly operation?: OperationRecord
  }
  readonly 'queue.upserted': { readonly queue: QueueRecord }
  readonly 'queue.entry.upserted': { readonly entry: QueueEntryRecord }
  readonly 'rule.upserted': {
    readonly rule: import('./entities.js').AutomationRuleRecord
    readonly operation?: OperationRecord
  }
  readonly 'rule.deleted': {
    readonly ruleId: import('./ids.js').RuleId
    readonly operation: OperationRecord
  }
  readonly 'interaction.automation.audited': { readonly audit: AutomationAuditRecord }
  readonly 'binding.upserted': { readonly binding: BindingRecord }
  readonly 'graph.node.upserted': { readonly node: GraphNodeRecord }
  readonly 'graph.edge.upserted': { readonly edge: GraphEdgeRecord }
  readonly 'operation.requested': { readonly operation: OperationRecord }
  readonly 'operation.updated': { readonly operation: OperationRecord }
  readonly 'effect.upserted': { readonly effect: EffectRecord }
  readonly 'feedback.decision.recorded': { readonly decision: FeedbackDecisionRecord }
  readonly 'content.unavailable': {
    readonly conversationId: ConversationId
    readonly originalKind: string
    readonly reason: 'content-key-unavailable' | 'deleted' | 'redacted'
  }
  readonly 'replay.cursor.advanced': { readonly runId: RunId; readonly cursor: ReplayCursor }
  readonly 'unknown.event': { readonly unknown: UnknownEventRecord }
}

type DomainEvent = {
  [K in keyof DomainBraidEventMap]: { readonly kind: K } & DomainBraidEventMap[K]
}[keyof DomainBraidEventMap]

export type BraidEvent = LegacyBraidEvent | DomainEvent

export interface BraidEventEnvelope {
  /** Optional for W0 compatibility; durable writers must provide it. */
  readonly eventId?: EventId
  readonly sequence: number
  readonly revision: number
  readonly occurredAt: string
  readonly cursor?: ReplayCursor
  readonly event: BraidEvent
}

export interface JournalEventEnvelope extends BraidEventEnvelope {
  readonly eventId: EventId
}

export function isDomainEvent<K extends keyof DomainBraidEventMap>(
  event: BraidEvent,
  kind: K,
): event is Extract<BraidEvent, { readonly kind: K }> {
  return event.kind === kind
}

export function eventRunId(event: BraidEvent): RunId | undefined {
  switch (event.kind) {
    case 'run.requested':
    case 'run.text.delta':
    case 'run.part.updated':
    case 'run.reasoning.delta':
    case 'run.tool.call':
    case 'run.tool.result':
    case 'run.artifact':
    case 'run.proposal':
    case 'run.warning':
    case 'run.usage':
    case 'run.cost':
    case 'run.error':
    case 'run.interaction':
    case 'run.interaction.cancelled':
    case 'run.interaction.response.requested':
    case 'run.interaction.responded':
    case 'run.provider.event':
    case 'run.cancel.requested':
    case 'run.finished':
    case 'run.control.requested':
    case 'run.control.acknowledged':
    case 'run.queue.added':
    case 'run.queue.removed':
    case 'run.detached':
    case 'run.reconnecting':
    case 'run.unknown':
    case 'run.bound':
    case 'run.retained.admitted':
    case 'run.status.changed':
    case 'run.reconciled':
    case 'run.environment.observed':
      return event.runId as RunId
    case 'history.missing':
      return event.range.runId
    case 'replay.cursor.advanced':
      return event.runId
    case 'workspace.opened':
    case 'draft.changed':
    case 'application.shutdown.requested':
    case 'workspace.recorded':
    case 'profile.registered':
    case 'profile.selected':
    case 'profile.snapshot.created':
    case 'credential.reference.created':
    case 'connection.upserted':
    case 'connection.selected':
    case 'connection.removed':
    case 'conversation.created':
    case 'conversation.imported':
    case 'conversation.updated':
    case 'conversation.selected':
    case 'conversation.deleted':
    case 'branch.created':
    case 'branch.updated':
    case 'branch.selected':
    case 'turn.created':
    case 'turn.updated':
    case 'message.created':
    case 'message.part.updated':
      return undefined
    case 'interaction.automation.audited':
      return event.audit.runId
    case 'analysis.created':
    case 'analysis.updated':
    case 'analysis.completed':
    case 'analysis.attachment.created':
    case 'environment.upserted':
    case 'checkpoint.upserted':
    case 'supervisor.upserted':
    case 'worker.upserted':
    case 'draft.recorded':
    case 'queue.upserted':
    case 'queue.entry.upserted':
    case 'rule.upserted':
    case 'rule.deleted':
    case 'binding.upserted':
    case 'graph.node.upserted':
    case 'graph.edge.upserted':
    case 'operation.requested':
    case 'operation.updated':
    case 'effect.upserted':
    case 'feedback.decision.recorded':
    case 'content.unavailable':
    case 'unknown.event':
      return undefined
    default: {
      const exhaustive: never = event
      return exhaustive
    }
  }
}

export type {
  AnalysisId,
  AnalysisRunId,
  CheckpointId,
  CredentialRefId,
  DraftId,
  EffectId,
  EventId,
  FeedbackDecisionId,
  GraphEdgeId,
  GraphNodeId,
  MessageId,
  MessagePartId,
  ProfileSnapshotId,
  SupervisorId,
  TurnId,
  WorkerId,
}

export function providerEventKey(event: BraidEvent): string | undefined {
  const provider = providerMetaForEvent(event)
  if (provider === undefined || !('runId' in event)) return undefined
  return `${event.runId}:${provider.eventId}`
}

export function providerMetaForEvent(event: BraidEvent): ProviderEventMeta | undefined {
  return 'provider' in event && event.provider ? event.provider : undefined
}
