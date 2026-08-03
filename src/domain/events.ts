import type {
  AnalysisRecord,
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
  InteractionRecord,
  MessagePartRecord,
  MessageRecord,
  MissingHistoryRange,
  OperationRecord,
  ProfileRecord,
  ProfileSnapshotRecord,
  QueueEntryRecord,
  QueueRecord,
  RunLifecycleStatus,
  SupervisorRecord,
  TurnRecord,
  UnknownEventRecord,
  WorkerRecord,
  WorkspaceRecord,
} from './entities.js'
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
  InteractionId,
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

export type { TurnUsage } from './entities.js'
import type { TurnUsage } from './entities.js'

/**
 * The W0 stream used these five events before the complete domain existed.
 * Their identifiers remain strings so the existing deterministic adapter and
 * terminal proof continue to compile; the reducer validates and brands them
 * before they enter durable state.
 */
export type LegacyBraidEvent =
  | {
      readonly kind: 'workspace.opened'
      readonly workspace: string
    }
  | {
      readonly kind: 'draft.changed'
      readonly text: string
    }
  | {
      readonly kind: 'run.requested'
      readonly operationId: string
      readonly requestDigest?: string
      readonly runId: string
      readonly turnId: string
      readonly userMessageId: string
      readonly assistantMessageId: string
      readonly text: string
    }
  | {
      readonly kind: 'run.text.delta'
      readonly runId: string
      readonly text: string
    }
  | {
      readonly kind: 'run.finished'
      readonly runId: string
      readonly status: 'completed' | 'failed' | 'aborted' | 'blocked' | 'unknown'
      readonly finalText: string
      readonly usage: TurnUsage
      readonly error?: string
    }

export interface InteractionResponseRequested {
  readonly interactionId: InteractionId
  readonly operationId: OperationId
  readonly outcome: 'accepted' | 'declined' | 'cancelled'
  readonly publicData?: Readonly<Record<string, string | number | boolean | readonly string[]>>
  readonly dataDigest?: Digest
  readonly containsSecret: boolean
}

export interface DomainBraidEventMap {
  readonly 'workspace.recorded': { readonly workspace: WorkspaceRecord }
  readonly 'profile.registered': { readonly profile: ProfileRecord }
  readonly 'profile.selected': { readonly profileId: ProfileId }
  readonly 'profile.snapshot.created': { readonly snapshot: ProfileSnapshotRecord }
  readonly 'credential.reference.created': { readonly credential: CredentialReference }
  readonly 'connection.upserted': { readonly connection: ConnectionRecord }
  readonly 'connection.selected': { readonly connectionId: ConnectionId }
  readonly 'conversation.created': { readonly conversation: ConversationRecord }
  readonly 'conversation.updated': { readonly conversation: ConversationRecord }
  readonly 'conversation.selected': { readonly conversationId: ConversationId }
  readonly 'branch.created': { readonly branch: BranchRecord }
  readonly 'branch.updated': { readonly branch: BranchRecord }
  readonly 'branch.selected': {
    readonly conversationId: ConversationId
    readonly branchId: BranchId
  }
  readonly 'turn.created': { readonly turn: TurnRecord }
  readonly 'turn.updated': { readonly turn: TurnRecord }
  readonly 'message.created': { readonly message: MessageRecord }
  readonly 'message.part.updated': { readonly part: MessagePartRecord }
  readonly 'run.bound': { readonly runId: RunId; readonly bindingId: BindingId }
  readonly 'run.status.changed': {
    readonly runId: RunId
    readonly status: RunLifecycleStatus
    readonly error?: string
  }
  readonly 'run.reconciled': {
    readonly runId: RunId
    readonly status: RunLifecycleStatus
    readonly evidence: string
  }
  readonly 'history.missing': { readonly range: MissingHistoryRange }
  readonly 'interaction.requested': { readonly interaction: InteractionRecord }
  readonly 'interaction.response.requested': { readonly response: InteractionResponseRequested }
  readonly 'interaction.resolved': {
    readonly interactionId: InteractionId
    readonly resolution: InteractionRecord['resolution']
  }
  readonly 'interaction.cancelled': {
    readonly interactionId: InteractionId
    readonly operationId: OperationId
  }
  readonly 'interaction.expired': { readonly interactionId: InteractionId }
  readonly 'analysis.created': { readonly analysis: AnalysisRecord }
  readonly 'analysis.updated': { readonly analysis: AnalysisRecord }
  readonly 'analysis.completed': { readonly analysis: AnalysisRecord }
  readonly 'environment.upserted': { readonly environment: EnvironmentRecord }
  readonly 'checkpoint.upserted': { readonly checkpoint: CheckpointRecord }
  readonly 'supervisor.upserted': { readonly supervisor: SupervisorRecord }
  readonly 'worker.upserted': { readonly worker: WorkerRecord }
  readonly 'draft.recorded': { readonly draft: DraftRecord }
  readonly 'queue.upserted': { readonly queue: QueueRecord }
  readonly 'queue.entry.upserted': { readonly entry: QueueEntryRecord }
  readonly 'rule.upserted': { readonly rule: import('./entities.js').AutomationRuleRecord }
  readonly 'binding.upserted': { readonly binding: BindingRecord }
  readonly 'graph.node.upserted': { readonly node: GraphNodeRecord }
  readonly 'graph.edge.upserted': { readonly edge: GraphEdgeRecord }
  readonly 'operation.requested': { readonly operation: OperationRecord }
  readonly 'operation.updated': { readonly operation: OperationRecord }
  readonly 'effect.upserted': { readonly effect: EffectRecord }
  readonly 'feedback.decision.recorded': { readonly decision: FeedbackDecisionRecord }
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
    case 'run.finished':
    case 'run.bound':
    case 'run.status.changed':
    case 'run.reconciled':
      return event.runId as RunId
    case 'history.missing':
      return event.range.runId
    case 'replay.cursor.advanced':
      return event.runId
    case 'workspace.opened':
    case 'draft.changed':
    case 'workspace.recorded':
    case 'profile.registered':
    case 'profile.selected':
    case 'profile.snapshot.created':
    case 'credential.reference.created':
    case 'connection.upserted':
    case 'connection.selected':
    case 'conversation.created':
    case 'conversation.updated':
    case 'conversation.selected':
    case 'branch.created':
    case 'branch.updated':
    case 'branch.selected':
    case 'turn.created':
    case 'turn.updated':
    case 'message.created':
    case 'message.part.updated':
    case 'interaction.requested':
    case 'interaction.response.requested':
    case 'interaction.resolved':
    case 'interaction.cancelled':
    case 'interaction.expired':
    case 'analysis.created':
    case 'analysis.updated':
    case 'analysis.completed':
    case 'environment.upserted':
    case 'checkpoint.upserted':
    case 'supervisor.upserted':
    case 'worker.upserted':
    case 'draft.recorded':
    case 'queue.upserted':
    case 'queue.entry.upserted':
    case 'rule.upserted':
    case 'binding.upserted':
    case 'graph.node.upserted':
    case 'graph.edge.upserted':
    case 'operation.requested':
    case 'operation.updated':
    case 'effect.upserted':
    case 'feedback.decision.recorded':
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
