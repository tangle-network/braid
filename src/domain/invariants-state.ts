import {
  canonicalAgentProfileDigest,
  snapshotAgentProfile,
} from '../adapters/agent-interface/profile-runtime.js'
import { isId } from './ids.js'
import {
  assertAppliedEventRecord,
  assertEntityId,
  assertFeedbackDecisionRecord,
  assertMissingHistory,
  assertReplayCursorRecord,
  assertUniqueIds,
  assertUnknownEventRecord,
  DomainInvariantError,
  fail,
} from './invariants-base.js'
import {
  assertBranchRecord,
  assertConversationRecord,
  assertMessagePartRecord,
  assertMessageRecord,
  assertTurnRecord,
} from './invariants-conversation.js'
import {
  assertCanonicalProfile,
  assertConnectionRecord,
  assertCredentialReference,
  assertProfileRecord,
  assertProfileSnapshotRecord,
  assertWorkspaceRecord,
} from './invariants-profile.js'
import { assertStateRelations } from './invariants-relations.js'
import {
  assertAnalysisAttachment,
  assertAnalysisRecord,
  assertInteractionRecord,
  assertRunRecord,
} from './invariants-run.js'
import {
  assertAutomationRuleRecord,
  assertBindingRecord,
  assertCheckpointRecord,
  assertDraftRecord,
  assertEffectRecord,
  assertEnvironmentRecord,
  assertGraphEdgeRecord,
  assertGraphNodeRecord,
  assertOperationRecord,
  assertQueueEntryRecord,
  assertQueueRecord,
  assertSupervisorRecord,
  assertWorkerRecord,
} from './invariants-runtime.js'
import type { BraidState } from './state.js'

export function assertBraidState(state: BraidState): void {
  if (state.schemaVersion < 2) fail('state.schemaVersion is unsupported')
  if (!Number.isInteger(state.revision) || state.revision < 0) fail('state.revision is invalid')
  if (!Number.isInteger(state.sequence) || state.sequence < 0) fail('state.sequence is invalid')
  if (state.workspaceId !== null)
    assertEntityId('workspace', state.workspaceId, 'state.workspaceId')
  if (state.conversationId !== null)
    assertEntityId('conversation', state.conversationId, 'state.conversationId')
  if (state.branchId !== null) assertEntityId('branch', state.branchId, 'state.branchId')
  if (state.activeRunId !== null) assertEntityId('run', state.activeRunId, 'state.activeRunId')
  try {
    const snapshot = snapshotAgentProfile(state.profile)
    assertCanonicalProfile(state.profile, canonicalAgentProfileDigest(snapshot), 'state.profile')
  } catch (error) {
    if (error instanceof DomainInvariantError) throw error
    fail('state.profile is not a canonical AgentProfile')
  }
  assertUniqueIds(
    state.workspaces.map((record) => record.id),
    'state.workspaces',
  )
  assertUniqueIds(
    state.profiles.map((record) => record.id),
    'state.profiles',
  )
  assertUniqueIds(
    state.profileSnapshots.map((record) => record.id),
    'state.profileSnapshots',
  )
  assertUniqueIds(
    state.credentials.map((record) => record.id),
    'state.credentials',
  )
  assertUniqueIds(
    state.connections.map((record) => record.id),
    'state.connections',
  )
  assertUniqueIds(
    state.conversations.map((record) => record.id),
    'state.conversations',
  )
  assertUniqueIds(
    state.branches.map((record) => record.id),
    'state.branches',
  )
  assertUniqueIds(
    state.turns.map((record) => record.id),
    'state.turns',
  )
  assertUniqueIds(
    state.messages.map((record) => record.id),
    'state.messages',
  )
  assertUniqueIds(
    state.messageParts.map((record) => record.id),
    'state.messageParts',
  )
  assertUniqueIds(
    state.runs.map((record) => record.id),
    'state.runs',
  )
  assertUniqueIds(
    state.interactions.map((record) => record.id),
    'state.interactions',
  )
  assertUniqueIds(
    state.analyses.map((record) => record.id),
    'state.analyses',
  )
  assertUniqueIds(
    state.analysisAttachments.map((record) => record.id),
    'state.analysisAttachments',
  )
  assertUniqueIds(
    state.environments.map((record) => record.id),
    'state.environments',
  )
  assertUniqueIds(
    state.checkpoints.map((record) => record.id),
    'state.checkpoints',
  )
  assertUniqueIds(
    state.supervisors.map((record) => record.id),
    'state.supervisors',
  )
  assertUniqueIds(
    state.workers.map((record) => record.id),
    'state.workers',
  )
  assertUniqueIds(
    state.drafts.map((record) => record.id),
    'state.drafts',
  )
  assertUniqueIds(
    state.queues.map((record) => record.id),
    'state.queues',
  )
  assertUniqueIds(
    state.queueEntries.map((record) => record.id),
    'state.queueEntries',
  )
  assertUniqueIds(
    state.rules.map((record) => record.id),
    'state.rules',
  )
  assertUniqueIds(
    state.bindings.map((record) => record.id),
    'state.bindings',
  )
  assertUniqueIds(
    state.graphNodes.map((record) => record.id),
    'state.graphNodes',
  )
  assertUniqueIds(
    state.graphEdges.map((record) => record.id),
    'state.graphEdges',
  )
  assertUniqueIds(
    state.operations.map((record) => record.id),
    'state.operations',
  )
  assertUniqueIds(
    state.effects.map((record) => record.id),
    'state.effects',
  )
  assertUniqueIds(
    state.feedbackDecisions.map((record) => record.id),
    'state.feedbackDecisions',
  )
  assertUniqueIds(
    state.appliedEvents.map((record) => record.id),
    'state.appliedEvents',
  )
  assertUniqueIds(
    state.unknownEvents.map((record) => record.id),
    'state.unknownEvents',
  )
  if (state.activeRunId !== null && !state.runs.some((run) => run.id === state.activeRunId)) {
    fail('state.activeRunId must reference a known run')
  }
  for (const record of state.workspaces) assertWorkspaceRecord(record)
  for (const record of state.profiles) assertProfileRecord(record)
  for (const record of state.profileSnapshots) assertProfileSnapshotRecord(record)
  for (const record of state.credentials) assertCredentialReference(record)
  for (const record of state.connections) assertConnectionRecord(record)
  for (const record of state.conversations) assertConversationRecord(record)
  for (const record of state.branches) assertBranchRecord(record)
  for (const record of state.turns) assertTurnRecord(record)
  for (const record of state.messages) assertMessageRecord(record)
  for (const record of state.messageParts) assertMessagePartRecord(record)
  for (const record of state.runs) assertRunRecord(record)
  for (const record of state.interactions) assertInteractionRecord(record)
  for (const record of state.analyses) assertAnalysisRecord(record)
  for (const record of state.analysisAttachments) assertAnalysisAttachment(record)
  for (const record of state.environments) assertEnvironmentRecord(record)
  for (const record of state.checkpoints) assertCheckpointRecord(record)
  for (const record of state.supervisors) assertSupervisorRecord(record)
  for (const record of state.workers) assertWorkerRecord(record)
  for (const record of state.drafts) assertDraftRecord(record)
  for (const record of state.queues) assertQueueRecord(record, state.queueEntries)
  for (const record of state.queueEntries) assertQueueEntryRecord(record)
  for (const record of state.rules) assertAutomationRuleRecord(record)
  for (const record of state.bindings) assertBindingRecord(record)
  for (const record of state.graphNodes) assertGraphNodeRecord(record)
  for (const record of state.graphEdges) assertGraphEdgeRecord(record)
  const graphNodeIds = new Set(state.graphNodes.map((node) => node.id))
  const graphAdjacency = new Map<string, string[]>()
  for (const edge of state.graphEdges) {
    if (!graphNodeIds.has(edge.source) || !graphNodeIds.has(edge.destination)) {
      fail(`graph edge ${edge.id} references a missing node`)
    }
    if (edge.source === edge.destination) fail(`graph edge ${edge.id} cannot point to itself`)
    const destinations = graphAdjacency.get(edge.source) ?? []
    destinations.push(edge.destination)
    graphAdjacency.set(edge.source, destinations)
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) fail(`graph contains a cycle at ${nodeId}`)
    if (visited.has(nodeId)) return
    visiting.add(nodeId)
    for (const destination of graphAdjacency.get(nodeId) ?? []) visit(destination)
    visiting.delete(nodeId)
    visited.add(nodeId)
  }
  for (const nodeId of graphNodeIds) visit(nodeId)
  for (const record of state.operations) assertOperationRecord(record)
  for (const record of state.effects) assertEffectRecord(record)
  assertUniqueIds(
    state.replayCursors.map((record) => record.runId),
    'state.replayCursors',
  )
  for (const cursor of state.replayCursors) assertReplayCursorRecord(cursor)
  for (const event of state.appliedEvents) assertAppliedEventRecord(event)
  for (const event of state.unknownEvents) assertUnknownEventRecord(event)
  for (const range of state.missingHistory) assertMissingHistory(range)
  for (const decision of state.feedbackDecisions) assertFeedbackDecisionRecord(decision)
  assertStateRelations(state)
}

export function assertIdKind(kind: Parameters<typeof isId>[0], value: unknown): void {
  if (!isId(kind, value)) fail(`value is not a valid ${kind} identifier`)
}
