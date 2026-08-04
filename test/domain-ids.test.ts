import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createAnalysisId,
  createAnalysisRunId,
  createArtifactId,
  createAttachmentId,
  createBindingId,
  createBranchId,
  createCheckpointId,
  createCitationId,
  createConnectionId,
  createConversationId,
  createCredentialRefId,
  createDigest,
  createDraftId,
  createEffectId,
  createEnvironmentId,
  createEventId,
  createFeedbackDecisionId,
  createGraphEdgeId,
  createGraphNodeId,
  createInteractionId,
  createMessageId,
  createMessagePartId,
  createOperationId,
  createProfileId,
  createProfileSnapshotId,
  createProviderSessionId,
  createQueueEntryId,
  createQueueId,
  createReceiptId,
  createReplayCursor,
  createRuleId,
  createRunId,
  createSupervisorId,
  createTraceId,
  createTurnId,
  createWorkerId,
  createWorkspaceId,
  isConversationId,
  isRunId,
  parseConversationId,
  parseRunId,
} from '../src/domain/ids.js'
import type { ConversationId } from '../src/domain/ids.js'

test('every domain identifier has a constructor and a nominal runtime prefix', () => {
  const constructors: readonly [(value: string) => string, string][] = [
    [createWorkspaceId, 'workspace-'],
    [createProfileId, 'profile-'],
    [createProfileSnapshotId, 'profile-snapshot-'],
    [createCredentialRefId, 'credential-'],
    [createConnectionId, 'connection-'],
    [createConversationId, 'conv-'],
    [createBranchId, 'branch-'],
    [createTurnId, 'turn-'],
    [createRunId, 'run-'],
    [createMessageId, 'message-'],
    [createMessagePartId, 'part-'],
    [createArtifactId, 'artifact-'],
    [createInteractionId, 'interaction-'],
    [createAnalysisId, 'analysis-'],
    [createAnalysisRunId, 'analysis-run-'],
    [createCitationId, 'citation-'],
    [createAttachmentId, 'attachment-'],
    [createFeedbackDecisionId, 'feedback-'],
    [createTraceId, 'trace-'],
    [createProviderSessionId, 'session-'],
    [createEnvironmentId, 'env-'],
    [createCheckpointId, 'checkpoint-'],
    [createSupervisorId, 'supervisor-'],
    [createWorkerId, 'worker-'],
    [createDraftId, 'draft-'],
    [createQueueId, 'queue-'],
    [createQueueEntryId, 'queue-entry-'],
    [createRuleId, 'rule-'],
    [createBindingId, 'binding-'],
    [createGraphNodeId, 'node-'],
    [createGraphEdgeId, 'edge-'],
    [createOperationId, 'op-'],
    [createEffectId, 'effect-'],
    [createReceiptId, 'receipt-'],
    [createEventId, 'event-'],
  ]

  for (const [index, [createId, prefix]] of constructors.entries()) {
    assert.equal(createId(`${prefix}value-${index}`), `${prefix}value-${index}`)
  }

  const digest = createDigest('a'.repeat(64))
  assert.equal(digest.length, 64)
  assert.equal(createReplayCursor('cursor-1'), 'cursor-1')
})

test('identifier validators reject values from another domain', () => {
  const run = createRunId('run-1')
  const conversation = createConversationId('conv-1')

  assert.equal(isRunId(run), true)
  assert.equal(isConversationId(conversation), true)
  assert.equal(isRunId(conversation), false)
  assert.equal(isConversationId(run), false)
  assert.throws(() => parseRunId('branch-1'), /Invalid run identifier/u)
  assert.throws(() => parseConversationId('run-1'), /Invalid conversation identifier/u)
})

test('brands prevent accidental compile-time substitution', () => {
  const run = createRunId('run-compile')
  // @ts-expect-error RunId and ConversationId are intentionally nominally distinct.
  const wrong: ConversationId = run
  assert.equal(typeof wrong, 'string')
})
