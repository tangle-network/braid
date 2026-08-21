import {
  assertCursor,
  assertDigest,
  assertPrefixedId,
  isCursor,
  isDigest,
  isPrefixedId,
  parseCursor,
  parseDigest,
  parsePrefixedId,
} from './ids-core.js'
import type {
  AnalysisId,
  AnalysisRunId,
  ArtifactId,
  AttachmentId,
  BindingId,
  BranchId,
  CheckpointId,
  CitationId,
  ConnectionId,
  ConversationId,
  CredentialRefId,
  Digest,
  DraftId,
  EffectId,
  EnvironmentId,
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
  ProviderSessionId,
  QueueEntryId,
  QueueId,
  ReceiptId,
  ReplayCursor,
  RuleId,
  RunId,
  SupervisorId,
  TraceId,
  TurnId,
  WorkerId,
  WorkspaceId,
} from './ids-types.js'

export function createWorkspaceId(value: string): WorkspaceId {
  return parsePrefixedId('workspace', value)
}

export const parseWorkspaceId = (value: unknown): WorkspaceId => parsePrefixedId('workspace', value)
export const isWorkspaceId = (value: unknown): value is WorkspaceId =>
  isPrefixedId('workspace', value)
export const assertWorkspaceId = (value: unknown): asserts value is WorkspaceId =>
  assertPrefixedId('workspace', value)

export function createProfileId(value: string): ProfileId {
  return parsePrefixedId('profile', value)
}
export const parseProfileId = (value: unknown): ProfileId => parsePrefixedId('profile', value)
export const isProfileId = (value: unknown): value is ProfileId => isPrefixedId('profile', value)
export const assertProfileId = (value: unknown): asserts value is ProfileId =>
  assertPrefixedId('profile', value)

export function createProfileSnapshotId(value: string): ProfileSnapshotId {
  return parsePrefixedId('profileSnapshot', value)
}
export const parseProfileSnapshotId = (value: unknown): ProfileSnapshotId =>
  parsePrefixedId('profileSnapshot', value)
export const isProfileSnapshotId = (value: unknown): value is ProfileSnapshotId =>
  isPrefixedId('profileSnapshot', value)
export const assertProfileSnapshotId = (value: unknown): asserts value is ProfileSnapshotId =>
  assertPrefixedId('profileSnapshot', value)

export function createCredentialRefId(value: string): CredentialRefId {
  return parsePrefixedId('credentialRef', value)
}
export const parseCredentialRefId = (value: unknown): CredentialRefId =>
  parsePrefixedId('credentialRef', value)
export const isCredentialRefId = (value: unknown): value is CredentialRefId =>
  isPrefixedId('credentialRef', value)
export const assertCredentialRefId = (value: unknown): asserts value is CredentialRefId =>
  assertPrefixedId('credentialRef', value)

export function createConnectionId(value: string): ConnectionId {
  return parsePrefixedId('connection', value)
}
export const parseConnectionId = (value: unknown): ConnectionId =>
  parsePrefixedId('connection', value)
export const isConnectionId = (value: unknown): value is ConnectionId =>
  isPrefixedId('connection', value)
export const assertConnectionId = (value: unknown): asserts value is ConnectionId =>
  assertPrefixedId('connection', value)

export function createConversationId(value: string): ConversationId {
  return parsePrefixedId('conversation', value)
}
export const parseConversationId = (value: unknown): ConversationId =>
  parsePrefixedId('conversation', value)
export const isConversationId = (value: unknown): value is ConversationId =>
  isPrefixedId('conversation', value)
export const assertConversationId = (value: unknown): asserts value is ConversationId =>
  assertPrefixedId('conversation', value)

export function createBranchId(value: string): BranchId {
  return parsePrefixedId('branch', value)
}
export const parseBranchId = (value: unknown): BranchId => parsePrefixedId('branch', value)
export const isBranchId = (value: unknown): value is BranchId => isPrefixedId('branch', value)
export const assertBranchId = (value: unknown): asserts value is BranchId =>
  assertPrefixedId('branch', value)

export function createTurnId(value: string): TurnId {
  return parsePrefixedId('turn', value)
}
export const parseTurnId = (value: unknown): TurnId => parsePrefixedId('turn', value)
export const isTurnId = (value: unknown): value is TurnId => isPrefixedId('turn', value)
export const assertTurnId = (value: unknown): asserts value is TurnId =>
  assertPrefixedId('turn', value)

export function createRunId(value: string): RunId {
  return parsePrefixedId('run', value)
}
export const parseRunId = (value: unknown): RunId => parsePrefixedId('run', value)
export const isRunId = (value: unknown): value is RunId => isPrefixedId('run', value)
export const assertRunId = (value: unknown): asserts value is RunId =>
  assertPrefixedId('run', value)

export function createMessageId(value: string): MessageId {
  return parsePrefixedId('message', value)
}
export const parseMessageId = (value: unknown): MessageId => parsePrefixedId('message', value)
export const isMessageId = (value: unknown): value is MessageId => isPrefixedId('message', value)
export const assertMessageId = (value: unknown): asserts value is MessageId =>
  assertPrefixedId('message', value)

export function createMessagePartId(value: string): MessagePartId {
  return parsePrefixedId('messagePart', value)
}
export const parseMessagePartId = (value: unknown): MessagePartId =>
  parsePrefixedId('messagePart', value)
export const isMessagePartId = (value: unknown): value is MessagePartId =>
  isPrefixedId('messagePart', value)
export const assertMessagePartId = (value: unknown): asserts value is MessagePartId =>
  assertPrefixedId('messagePart', value)

export function createArtifactId(value: string): ArtifactId {
  return parsePrefixedId('artifact', value)
}
export const parseArtifactId = (value: unknown): ArtifactId => parsePrefixedId('artifact', value)
export const isArtifactId = (value: unknown): value is ArtifactId => isPrefixedId('artifact', value)
export const assertArtifactId = (value: unknown): asserts value is ArtifactId =>
  assertPrefixedId('artifact', value)

export function createInteractionId(value: string): InteractionId {
  return parsePrefixedId('interaction', value)
}
export const parseInteractionId = (value: unknown): InteractionId =>
  parsePrefixedId('interaction', value)
export const isInteractionId = (value: unknown): value is InteractionId =>
  isPrefixedId('interaction', value)
export const assertInteractionId = (value: unknown): asserts value is InteractionId =>
  assertPrefixedId('interaction', value)

export function createAnalysisId(value: string): AnalysisId {
  return parsePrefixedId('analysis', value)
}
export const parseAnalysisId = (value: unknown): AnalysisId => parsePrefixedId('analysis', value)
export const isAnalysisId = (value: unknown): value is AnalysisId => isPrefixedId('analysis', value)
export const assertAnalysisId = (value: unknown): asserts value is AnalysisId =>
  assertPrefixedId('analysis', value)

export function createAnalysisRunId(value: string): AnalysisRunId {
  return parsePrefixedId('analysisRun', value)
}
export const parseAnalysisRunId = (value: unknown): AnalysisRunId =>
  parsePrefixedId('analysisRun', value)
export const isAnalysisRunId = (value: unknown): value is AnalysisRunId =>
  isPrefixedId('analysisRun', value)
export const assertAnalysisRunId = (value: unknown): asserts value is AnalysisRunId =>
  assertPrefixedId('analysisRun', value)

export function createCitationId(value: string): CitationId {
  return parsePrefixedId('citation', value)
}
export const parseCitationId = (value: unknown): CitationId => parsePrefixedId('citation', value)
export const isCitationId = (value: unknown): value is CitationId => isPrefixedId('citation', value)
export const assertCitationId = (value: unknown): asserts value is CitationId =>
  assertPrefixedId('citation', value)

export function createAttachmentId(value: string): AttachmentId {
  return parsePrefixedId('attachment', value)
}
export const parseAttachmentId = (value: unknown): AttachmentId =>
  parsePrefixedId('attachment', value)
export const isAttachmentId = (value: unknown): value is AttachmentId =>
  isPrefixedId('attachment', value)
export const assertAttachmentId = (value: unknown): asserts value is AttachmentId =>
  assertPrefixedId('attachment', value)

export function createFeedbackDecisionId(value: string): FeedbackDecisionId {
  return parsePrefixedId('feedbackDecision', value)
}
export const parseFeedbackDecisionId = (value: unknown): FeedbackDecisionId =>
  parsePrefixedId('feedbackDecision', value)
export const isFeedbackDecisionId = (value: unknown): value is FeedbackDecisionId =>
  isPrefixedId('feedbackDecision', value)
export const assertFeedbackDecisionId = (value: unknown): asserts value is FeedbackDecisionId =>
  assertPrefixedId('feedbackDecision', value)

export function createTraceId(value: string): TraceId {
  return parsePrefixedId('trace', value)
}
export const parseTraceId = (value: unknown): TraceId => parsePrefixedId('trace', value)
export const isTraceId = (value: unknown): value is TraceId => isPrefixedId('trace', value)
export const assertTraceId = (value: unknown): asserts value is TraceId =>
  assertPrefixedId('trace', value)

export function createProviderSessionId(value: string): ProviderSessionId {
  return parsePrefixedId('providerSession', value)
}
export const parseProviderSessionId = (value: unknown): ProviderSessionId =>
  parsePrefixedId('providerSession', value)
export const isProviderSessionId = (value: unknown): value is ProviderSessionId =>
  isPrefixedId('providerSession', value)
export const assertProviderSessionId = (value: unknown): asserts value is ProviderSessionId =>
  assertPrefixedId('providerSession', value)

export function createEnvironmentId(value: string): EnvironmentId {
  return parsePrefixedId('environment', value)
}
export const parseEnvironmentId = (value: unknown): EnvironmentId =>
  parsePrefixedId('environment', value)
export const isEnvironmentId = (value: unknown): value is EnvironmentId =>
  isPrefixedId('environment', value)
export const assertEnvironmentId = (value: unknown): asserts value is EnvironmentId =>
  assertPrefixedId('environment', value)

export function createCheckpointId(value: string): CheckpointId {
  return parsePrefixedId('checkpoint', value)
}
export const parseCheckpointId = (value: unknown): CheckpointId =>
  parsePrefixedId('checkpoint', value)
export const isCheckpointId = (value: unknown): value is CheckpointId =>
  isPrefixedId('checkpoint', value)
export const assertCheckpointId = (value: unknown): asserts value is CheckpointId =>
  assertPrefixedId('checkpoint', value)

export function createSupervisorId(value: string): SupervisorId {
  return parsePrefixedId('supervisor', value)
}
export const parseSupervisorId = (value: unknown): SupervisorId =>
  parsePrefixedId('supervisor', value)
export const isSupervisorId = (value: unknown): value is SupervisorId =>
  isPrefixedId('supervisor', value)
export const assertSupervisorId = (value: unknown): asserts value is SupervisorId =>
  assertPrefixedId('supervisor', value)

export function createWorkerId(value: string): WorkerId {
  return parsePrefixedId('worker', value)
}
export const parseWorkerId = (value: unknown): WorkerId => parsePrefixedId('worker', value)
export const isWorkerId = (value: unknown): value is WorkerId => isPrefixedId('worker', value)
export const assertWorkerId = (value: unknown): asserts value is WorkerId =>
  assertPrefixedId('worker', value)

export function createDraftId(value: string): DraftId {
  return parsePrefixedId('draft', value)
}
export const parseDraftId = (value: unknown): DraftId => parsePrefixedId('draft', value)
export const isDraftId = (value: unknown): value is DraftId => isPrefixedId('draft', value)
export const assertDraftId = (value: unknown): asserts value is DraftId =>
  assertPrefixedId('draft', value)

export function createQueueId(value: string): QueueId {
  return parsePrefixedId('queue', value)
}
export const parseQueueId = (value: unknown): QueueId => parsePrefixedId('queue', value)
export const isQueueId = (value: unknown): value is QueueId => isPrefixedId('queue', value)
export const assertQueueId = (value: unknown): asserts value is QueueId =>
  assertPrefixedId('queue', value)

export function createQueueEntryId(value: string): QueueEntryId {
  return parsePrefixedId('queueEntry', value)
}
export const parseQueueEntryId = (value: unknown): QueueEntryId =>
  parsePrefixedId('queueEntry', value)
export const isQueueEntryId = (value: unknown): value is QueueEntryId =>
  isPrefixedId('queueEntry', value)
export const assertQueueEntryId = (value: unknown): asserts value is QueueEntryId =>
  assertPrefixedId('queueEntry', value)

export function createRuleId(value: string): RuleId {
  return parsePrefixedId('rule', value)
}
export const parseRuleId = (value: unknown): RuleId => parsePrefixedId('rule', value)
export const isRuleId = (value: unknown): value is RuleId => isPrefixedId('rule', value)
export const assertRuleId = (value: unknown): asserts value is RuleId =>
  assertPrefixedId('rule', value)

export function createBindingId(value: string): BindingId {
  return parsePrefixedId('binding', value)
}
export const parseBindingId = (value: unknown): BindingId => parsePrefixedId('binding', value)
export const isBindingId = (value: unknown): value is BindingId => isPrefixedId('binding', value)
export const assertBindingId = (value: unknown): asserts value is BindingId =>
  assertPrefixedId('binding', value)

export function createGraphNodeId(value: string): GraphNodeId {
  return parsePrefixedId('graphNode', value)
}
export const parseGraphNodeId = (value: unknown): GraphNodeId => parsePrefixedId('graphNode', value)
export const isGraphNodeId = (value: unknown): value is GraphNodeId =>
  isPrefixedId('graphNode', value)
export const assertGraphNodeId = (value: unknown): asserts value is GraphNodeId =>
  assertPrefixedId('graphNode', value)

export function createGraphEdgeId(value: string): GraphEdgeId {
  return parsePrefixedId('graphEdge', value)
}
export const parseGraphEdgeId = (value: unknown): GraphEdgeId => parsePrefixedId('graphEdge', value)
export const isGraphEdgeId = (value: unknown): value is GraphEdgeId =>
  isPrefixedId('graphEdge', value)
export const assertGraphEdgeId = (value: unknown): asserts value is GraphEdgeId =>
  assertPrefixedId('graphEdge', value)

export function createOperationId(value: string): OperationId {
  return parsePrefixedId('operation', value)
}
export const parseOperationId = (value: unknown): OperationId => parsePrefixedId('operation', value)
export const isOperationId = (value: unknown): value is OperationId =>
  isPrefixedId('operation', value)
export const assertOperationId = (value: unknown): asserts value is OperationId =>
  assertPrefixedId('operation', value)

export function createEffectId(value: string): EffectId {
  return parsePrefixedId('effect', value)
}
export const parseEffectId = (value: unknown): EffectId => parsePrefixedId('effect', value)
export const isEffectId = (value: unknown): value is EffectId => isPrefixedId('effect', value)
export const assertEffectId = (value: unknown): asserts value is EffectId =>
  assertPrefixedId('effect', value)

export function createReceiptId(value: string): ReceiptId {
  return parsePrefixedId('receipt', value)
}
export const parseReceiptId = (value: unknown): ReceiptId => parsePrefixedId('receipt', value)
export const isReceiptId = (value: unknown): value is ReceiptId => isPrefixedId('receipt', value)
export const assertReceiptId = (value: unknown): asserts value is ReceiptId =>
  assertPrefixedId('receipt', value)

export function createEventId(value: string): EventId {
  return parsePrefixedId('event', value)
}
export const parseEventId = (value: unknown): EventId => parsePrefixedId('event', value)
export const isEventId = (value: unknown): value is EventId => isPrefixedId('event', value)
export const assertEventId = (value: unknown): asserts value is EventId =>
  assertPrefixedId('event', value)

export function createDigest(value: string): Digest {
  return parseDigest(value)
}
export const parseDigestValue = parseDigest
export const isDigestValue = isDigest
export const assertDigestValue = assertDigest

export function createReplayCursor(value: string): ReplayCursor {
  return parseCursor(value)
}
export const parseReplayCursor = parseCursor
export const isReplayCursor = isCursor
export const assertReplayCursor = assertCursor
