import {
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
  AttachmentId,
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
  QueueId,
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

export function createProfileId(value: string): ProfileId {
  return parsePrefixedId('profile', value)
}
export const parseProfileId = (value: unknown): ProfileId => parsePrefixedId('profile', value)

export function createProfileSnapshotId(value: string): ProfileSnapshotId {
  return parsePrefixedId('profileSnapshot', value)
}
export const parseProfileSnapshotId = (value: unknown): ProfileSnapshotId =>
  parsePrefixedId('profileSnapshot', value)

export function createCredentialRefId(value: string): CredentialRefId {
  return parsePrefixedId('credentialRef', value)
}
export const isCredentialRefId = (value: unknown): value is CredentialRefId =>
  isPrefixedId('credentialRef', value)

export function createConnectionId(value: string): ConnectionId {
  return parsePrefixedId('connection', value)
}
export const parseConnectionId = (value: unknown): ConnectionId =>
  parsePrefixedId('connection', value)

export function createConversationId(value: string): ConversationId {
  return parsePrefixedId('conversation', value)
}
export const parseConversationId = (value: unknown): ConversationId =>
  parsePrefixedId('conversation', value)

export function createBranchId(value: string): BranchId {
  return parsePrefixedId('branch', value)
}
export const parseBranchId = (value: unknown): BranchId => parsePrefixedId('branch', value)

export function createTurnId(value: string): TurnId {
  return parsePrefixedId('turn', value)
}
export const parseTurnId = (value: unknown): TurnId => parsePrefixedId('turn', value)

export function createRunId(value: string): RunId {
  return parsePrefixedId('run', value)
}
export const parseRunId = (value: unknown): RunId => parsePrefixedId('run', value)

export function createMessageId(value: string): MessageId {
  return parsePrefixedId('message', value)
}
export const parseMessageId = (value: unknown): MessageId => parsePrefixedId('message', value)
export const isMessageId = (value: unknown): value is MessageId => isPrefixedId('message', value)

export function createMessagePartId(value: string): MessagePartId {
  return parsePrefixedId('messagePart', value)
}
export const isMessagePartId = (value: unknown): value is MessagePartId =>
  isPrefixedId('messagePart', value)

export function createInteractionId(value: string): InteractionId {
  return parsePrefixedId('interaction', value)
}

export function createAnalysisId(value: string): AnalysisId {
  return parsePrefixedId('analysis', value)
}

export function createAnalysisRunId(value: string): AnalysisRunId {
  return parsePrefixedId('analysisRun', value)
}

export function createCitationId(value: string): CitationId {
  return parsePrefixedId('citation', value)
}

export function createAttachmentId(value: string): AttachmentId {
  return parsePrefixedId('attachment', value)
}

export function createFeedbackDecisionId(value: string): FeedbackDecisionId {
  return parsePrefixedId('feedbackDecision', value)
}

export function createTraceId(value: string): TraceId {
  return parsePrefixedId('trace', value)
}

export function createProviderSessionId(value: string): ProviderSessionId {
  return parsePrefixedId('providerSession', value)
}

export function createEnvironmentId(value: string): EnvironmentId {
  return parsePrefixedId('environment', value)
}
export const parseEnvironmentId = (value: unknown): EnvironmentId =>
  parsePrefixedId('environment', value)

export function createCheckpointId(value: string): CheckpointId {
  return parsePrefixedId('checkpoint', value)
}
export const parseCheckpointId = (value: unknown): CheckpointId =>
  parsePrefixedId('checkpoint', value)

export function createSupervisorId(value: string): SupervisorId {
  return parsePrefixedId('supervisor', value)
}

export function createWorkerId(value: string): WorkerId {
  return parsePrefixedId('worker', value)
}

export function createDraftId(value: string): DraftId {
  return parsePrefixedId('draft', value)
}

export function createQueueId(value: string): QueueId {
  return parsePrefixedId('queue', value)
}

export function createRuleId(value: string): RuleId {
  return parsePrefixedId('rule', value)
}
export const parseRuleId = (value: unknown): RuleId => parsePrefixedId('rule', value)

export function createGraphNodeId(value: string): GraphNodeId {
  return parsePrefixedId('graphNode', value)
}

export function createGraphEdgeId(value: string): GraphEdgeId {
  return parsePrefixedId('graphEdge', value)
}

export function createOperationId(value: string): OperationId {
  return parsePrefixedId('operation', value)
}
export const parseOperationId = (value: unknown): OperationId => parsePrefixedId('operation', value)
export const isOperationId = (value: unknown): value is OperationId =>
  isPrefixedId('operation', value)

export function createEffectId(value: string): EffectId {
  return parsePrefixedId('effect', value)
}

export function createEventId(value: string): EventId {
  return parsePrefixedId('event', value)
}
export const parseEventId = (value: unknown): EventId => parsePrefixedId('event', value)
export const isEventId = (value: unknown): value is EventId => isPrefixedId('event', value)

export function createDigest(value: string): Digest {
  return parseDigest(value)
}
export const parseDigestValue = parseDigest
export const isDigestValue = isDigest

export const parseReplayCursor = parseCursor
export const isReplayCursor = isCursor
