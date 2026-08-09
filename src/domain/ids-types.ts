/**
 * Nominal identifiers used by Braid's durable graph.
 *
 * A provider identifier is represented by the provider-specific field on its
 * Braid binding.  It is never interchangeable with the Braid identifier that
 * points at that binding.
 */

declare const ID_BRAND: unique symbol

export type BrandedId<Name extends string> = string & {
  /**
   * The optional marker keeps the public W0 string API source-compatible while
   * making branded values from different domains incompatible with each other.
   */
  readonly [ID_BRAND]?: Name
}

export type WorkspaceId = BrandedId<'WorkspaceId'>
export type ProfileId = BrandedId<'ProfileId'>
export type ProfileSnapshotId = BrandedId<'ProfileSnapshotId'>
export type CredentialRefId = BrandedId<'CredentialRefId'>
export type ConnectionId = BrandedId<'ConnectionId'>
export type ConversationId = BrandedId<'ConversationId'>
export type BranchId = BrandedId<'BranchId'>
export type TurnId = BrandedId<'TurnId'>
export type RunId = BrandedId<'RunId'>
export type MessageId = BrandedId<'MessageId'>
export type MessagePartId = BrandedId<'MessagePartId'>
export type ArtifactId = BrandedId<'ArtifactId'>
export type InteractionId = BrandedId<'InteractionId'>
export type AnalysisId = BrandedId<'AnalysisId'>
export type AnalysisRunId = BrandedId<'AnalysisRunId'>
export type CitationId = BrandedId<'CitationId'>
export type AttachmentId = BrandedId<'AttachmentId'>
export type FeedbackDecisionId = BrandedId<'FeedbackDecisionId'>
export type TraceId = BrandedId<'TraceId'>
export type ProviderSessionId = BrandedId<'ProviderSessionId'>
export type EnvironmentId = BrandedId<'EnvironmentId'>
export type CheckpointId = BrandedId<'CheckpointId'>
export type SupervisorId = BrandedId<'SupervisorId'>
export type WorkerId = BrandedId<'WorkerId'>
export type DraftId = BrandedId<'DraftId'>
export type QueueId = BrandedId<'QueueId'>
export type QueueEntryId = BrandedId<'QueueEntryId'>
export type RuleId = BrandedId<'RuleId'>
export type BindingId = BrandedId<'BindingId'>
export type GraphNodeId = BrandedId<'GraphNodeId'>
export type GraphEdgeId = BrandedId<'GraphEdgeId'>
export type OperationId = BrandedId<'OperationId'>
export type EffectId = BrandedId<'EffectId'>
export type ReceiptId = BrandedId<'ReceiptId'>
export type EventId = BrandedId<'EventId'>

export type Digest = BrandedId<'Digest'>
export type ReplayCursor = BrandedId<'ReplayCursor'>

export type IdKind =
  | 'workspace'
  | 'profile'
  | 'profileSnapshot'
  | 'credentialRef'
  | 'connection'
  | 'conversation'
  | 'branch'
  | 'turn'
  | 'run'
  | 'message'
  | 'messagePart'
  | 'artifact'
  | 'interaction'
  | 'analysis'
  | 'analysisRun'
  | 'citation'
  | 'attachment'
  | 'feedbackDecision'
  | 'trace'
  | 'providerSession'
  | 'environment'
  | 'checkpoint'
  | 'supervisor'
  | 'worker'
  | 'draft'
  | 'queue'
  | 'queueEntry'
  | 'rule'
  | 'binding'
  | 'graphNode'
  | 'graphEdge'
  | 'operation'
  | 'effect'
  | 'receipt'
  | 'event'

export type IdForKind<K extends IdKind> = {
  workspace: WorkspaceId
  profile: ProfileId
  profileSnapshot: ProfileSnapshotId
  credentialRef: CredentialRefId
  connection: ConnectionId
  conversation: ConversationId
  branch: BranchId
  turn: TurnId
  run: RunId
  message: MessageId
  messagePart: MessagePartId
  artifact: ArtifactId
  interaction: InteractionId
  analysis: AnalysisId
  analysisRun: AnalysisRunId
  citation: CitationId
  attachment: AttachmentId
  feedbackDecision: FeedbackDecisionId
  trace: TraceId
  providerSession: ProviderSessionId
  environment: EnvironmentId
  checkpoint: CheckpointId
  supervisor: SupervisorId
  worker: WorkerId
  draft: DraftId
  queue: QueueId
  queueEntry: QueueEntryId
  rule: RuleId
  binding: BindingId
  graphNode: GraphNodeId
  graphEdge: GraphEdgeId
  operation: OperationId
  effect: EffectId
  receipt: ReceiptId
  event: EventId
}[K]
