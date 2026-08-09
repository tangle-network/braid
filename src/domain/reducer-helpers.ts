import { canonicalDigest } from './canonical.js'
import type {
  BraidMessage,
  BranchRecord,
  ConversationRecord,
  DraftRecord,
  MessagePartRecord,
  MessageRecord,
  OperationRecord,
  RunRecord,
} from './entities.js'
import type { BraidEvent, BraidEventEnvelope } from './events.js'
import {
  type BranchId,
  createDraftId,
  createMessagePartId,
  createQueueId,
  createWorkspaceId,
  type EventId,
  type MessageId,
  type MessagePartId,
  type OperationId,
  parseDigestValue,
  type RunId,
} from './ids.js'
import { DomainInvariantError } from './invariants.js'
import type { BraidState } from './state.js'
import { createAdmissionReceipt } from './receipts.js'
import { LEGACY_RUN_CAPABILITIES } from './runtime-projection.js'
import { graphEdge, graphNode } from './graph-records.js'

export class SequenceGapError extends Error {
  readonly code = 'SEQUENCE_GAP'
  readonly expectedSequence: number
  readonly actualSequence: number
  readonly expectedRevision: number
  readonly actualRevision: number

  constructor(state: BraidState, envelope: BraidEventEnvelope) {
    super(
      `Event sequence ${envelope.sequence} does not follow ${state.sequence}; ` +
        `revision ${envelope.revision} does not follow ${state.revision}`,
    )
    this.name = 'SequenceGapError'
    this.expectedSequence = state.sequence + 1
    this.actualSequence = envelope.sequence
    this.expectedRevision = state.revision + 1
    this.actualRevision = envelope.revision
  }
}

export class DuplicateEventConflictError extends Error {
  readonly code = 'DUPLICATE_EVENT_CONFLICT'

  constructor(eventId: EventId) {
    super(`Event ${eventId} was replayed with a different position or payload`)
    this.name = 'DuplicateEventConflictError'
  }
}

export function upsert<T extends { readonly id: string }>(
  items: readonly T[],
  item: T,
): readonly T[] {
  const index = items.findIndex((entry) => entry.id === item.id)
  if (index === -1) return [...items, item]
  return items.map((entry, candidate) => (candidate === index ? item : entry))
}

export function upsertBy<T>(items: readonly T[], key: (item: T) => string, item: T): readonly T[] {
  const value = key(item)
  const index = items.findIndex((entry) => key(entry) === value)
  if (index === -1) return [...items, item]
  return items.map((entry, candidate) => (candidate === index ? item : entry))
}

export function find<T extends { readonly id: string }>(
  items: readonly T[],
  id: string,
  name: string,
): T {
  const item = items.find((entry) => entry.id === id)
  if (!item) throw new DomainInvariantError(`${name} ${id} does not exist`)
  return item
}

export function dateAt(envelope: BraidEventEnvelope): string {
  return envelope.occurredAt
}

export function defaultWorkspaceId(workspace: string) {
  return createWorkspaceId(`workspace-${canonicalDigest({ root: workspace }).slice(0, 32)}`)
}

export function defaultPartId(messageId: MessageId): MessagePartId {
  return createMessagePartId(`part-${messageId}`)
}

export function defaultDraft(branchId: BranchId, at: string): DraftRecord {
  return {
    id: createDraftId(`draft-${branchId}`),
    branchId,
    text: '',
    updatedAt: at,
  }
}

export function defaultQueue(branchId: BranchId, at: string) {
  return {
    id: createQueueId(`queue-${branchId}`),
    branchId,
    entryIds: [],
    createdAt: at,
    updatedAt: at,
  }
}

export function ensureWorkspaceGraph(state: BraidState, workspace: string, at: string): BraidState {
  const workspaceId = defaultWorkspaceId(workspace)
  const existingWorkspace = state.workspaces.find((entry) => entry.id === workspaceId)
  const workspaceRecord = existingWorkspace ?? {
    id: workspaceId,
    root: workspace,
    trusted: false,
    createdAt: at,
    updatedAt: at,
  }
  const conversation: ConversationRecord = {
    id: state.conversationId,
    workspaceId,
    title: 'New conversation',
    activeBranchId: state.branchId,
    createdAt: at,
    updatedAt: at,
    archived: false,
    retention: {},
  }
  const draft = defaultDraft(state.branchId, at)
  const queue = defaultQueue(state.branchId, at)
  const branch: BranchRecord = {
    id: state.branchId,
    conversationId: state.conversationId,
    overrides: {},
    draftId: draft.id,
    queueId: queue.id,
    status: 'active',
    createdAt: at,
    updatedAt: at,
  }
  const workspaceNode = graphNode({ kind: 'workspace', id: workspaceId }, at, workspace)
  const conversationNode = graphNode(
    { kind: 'conversation', id: conversation.id },
    at,
    conversation.title,
  )
  const branchNode = graphNode({ kind: 'branch', id: branch.id }, at, 'Main')
  const workspaceConversation = graphEdge({
    kind: 'attached',
    source: workspaceNode.reference,
    destination: conversationNode.reference,
    at,
  })
  const conversationBranch = graphEdge({
    kind: 'attached',
    source: conversationNode.reference,
    destination: branchNode.reference,
    at,
  })
  return {
    ...state,
    workspace,
    workspaceId,
    workspaces: upsert(state.workspaces, workspaceRecord),
    conversations: state.conversations.some((entry) => entry.id === conversation.id)
      ? state.conversations
      : [...state.conversations, conversation],
    branches: state.branches.some((entry) => entry.id === branch.id)
      ? state.branches
      : [...state.branches, branch],
    drafts: state.drafts.some((entry) => entry.id === draft.id)
      ? state.drafts
      : [...state.drafts, draft],
    queues: state.queues.some((entry) => entry.id === queue.id)
      ? state.queues
      : [...state.queues, queue],
    graphNodes: [workspaceNode, conversationNode, branchNode].reduce(upsert, state.graphNodes),
    graphEdges: [workspaceConversation, conversationBranch].reduce(upsert, state.graphEdges),
  }
}

export function legacyMessage(
  state: BraidState,
  id: MessageId,
  role: BraidMessage['role'],
  text: string,
  runId: RunId,
  turnId: import('./ids.js').TurnId,
  status: BraidMessage['status'],
  at: string,
): MessageRecord {
  const partId = defaultPartId(id)
  return {
    id,
    conversationId: state.conversationId,
    branchId: state.branchId,
    role,
    text,
    partIds: [partId],
    parts: [{ id: partId, kind: 'text', text }],
    status,
    turnId,
    runId,
    createdAt: at,
    updatedAt: at,
    complete: status === 'complete',
  }
}

export function legacyRunFields(
  state: BraidState,
  event: Extract<BraidEvent, { readonly kind: 'run.requested' }>,
  at: string,
) {
  return {
    receipt: createAdmissionReceipt({
      runId: event.runId,
      turnId: event.turnId,
      operationId: event.operationId,
      conversationId: state.conversationId,
      branchId: state.branchId,
      admittedAt: at,
      profile: state.profile,
      text: event.text,
      capabilities: LEGACY_RUN_CAPABILITIES,
    }),
    capabilities: LEGACY_RUN_CAPABILITIES,
    lastProviderSequence: 0,
    eventCount: 0,
    interactions: [],
    activity: [],
    eventDetails: [],
  } as const
}

export function legacyTextPart(message: MessageRecord, at: string): MessagePartRecord {
  return {
    id: message.partIds[0] as MessagePartId,
    messageId: message.id,
    ordinal: 0,
    kind: 'text',
    text: message.text,
    createdAt: at,
    updatedAt: at,
  }
}

export function runStatusTerminal(status: RunRecord['status']): boolean {
  return (
    status === 'completed' ||
    status === 'cancelled' ||
    status === 'failed' ||
    status === 'expired' ||
    status === 'unknown' ||
    status === 'aborted' ||
    status === 'blocked'
  )
}

export function canTransition(from: RunRecord['status'], to: RunRecord['status']): boolean {
  if (from === to) return true
  if (runStatusTerminal(from)) return from === 'unknown' && to !== 'running' && to !== 'starting'
  switch (from) {
    case 'prepared':
      return to === 'starting' || to === 'cancelled' || to === 'aborted'
    case 'starting':
      return [
        'running',
        'streaming',
        'waiting',
        'detached',
        'reconnecting',
        'cancelling',
        'completed',
        'cancelled',
        'failed',
        'expired',
        'unknown',
        'blocked',
        'aborted',
      ].includes(to)
    case 'running':
    case 'streaming':
      return [
        'waiting',
        'detached',
        'reconnecting',
        'cancelling',
        'completed',
        'cancelled',
        'failed',
        'expired',
        'unknown',
        'blocked',
        'aborted',
      ].includes(to)
    case 'waiting':
      return [
        'running',
        'streaming',
        'detached',
        'reconnecting',
        'cancelling',
        'completed',
        'cancelled',
        'failed',
        'expired',
        'unknown',
        'blocked',
        'aborted',
      ].includes(to)
    case 'detached':
      return [
        'reconnecting',
        'cancelling',
        'completed',
        'cancelled',
        'failed',
        'expired',
        'unknown',
        'aborted',
        'blocked',
      ].includes(to)
    case 'reconnecting':
      return [
        'running',
        'streaming',
        'waiting',
        'detached',
        'cancelling',
        'completed',
        'cancelled',
        'failed',
        'expired',
        'unknown',
        'aborted',
        'blocked',
      ].includes(to)
    case 'cancelling':
      return [
        'completed',
        'cancelled',
        'failed',
        'expired',
        'unknown',
        'aborted',
        'blocked',
      ].includes(to)
    default:
      return false
  }
}

export function updateRun(state: BraidState, run: RunRecord, at: string): BraidState {
  const previous = state.runs.find((entry) => entry.id === run.id)
  if (previous && previous.status !== run.status && !canTransition(previous.status, run.status)) {
    throw new DomainInvariantError(
      `Run ${run.id} cannot transition from ${previous.status} to ${run.status}`,
    )
  }
  const terminal = runStatusTerminal(run.status)
  const nextRun: RunRecord = {
    ...run,
    complete: terminal ? run.complete : false,
    updatedAt: at,
    ...(terminal && run.terminalAt === undefined ? { terminalAt: at } : {}),
  }
  const activeRunId = terminal && state.activeRunId === run.id ? null : state.activeRunId
  return {
    ...state,
    runs: upsert(state.runs, nextRun),
    activeRunId,
  }
}

export function updateMessage(state: BraidState, message: MessageRecord): BraidState {
  return {
    ...state,
    messages: upsert(state.messages, message),
  }
}

export function updateMessageText(
  state: BraidState,
  runId: RunId,
  text: string,
  at: string,
): BraidState {
  const message = state.messages.find(
    (entry) => entry.runId === runId && entry.role === 'assistant',
  )
  if (!message) throw new DomainInvariantError(`Assistant message for run ${runId} does not exist`)
  const nextMessage = { ...message, text: `${message.text}${text}`, updatedAt: at }
  const partId = message.partIds[0]
  const part = state.messageParts.find((entry) => entry.id === partId)
  const nextPart: MessagePartRecord =
    part?.kind === 'text'
      ? { ...part, text: nextMessage.text, updatedAt: at }
      : legacyTextPart(nextMessage, at)
  return {
    ...updateMessage(state, nextMessage),
    messageParts: upsert(state.messageParts, nextPart),
  }
}

export function updateMessageFinal(
  state: BraidState,
  runId: RunId,
  text: string,
  status: BraidMessage['status'],
  at: string,
): BraidState {
  const message = state.messages.find(
    (entry) => entry.runId === runId && entry.role === 'assistant',
  )
  if (!message) throw new DomainInvariantError(`Assistant message for run ${runId} does not exist`)
  const nextMessage = {
    ...message,
    text: text || message.text,
    status,
    complete: status === 'complete',
    updatedAt: at,
  }
  const part = state.messageParts.find((entry) => entry.id === message.partIds[0])
  const nextPart: MessagePartRecord =
    part?.kind === 'text'
      ? { ...part, text: nextMessage.text, updatedAt: at }
      : legacyTextPart(nextMessage, at)
  return {
    ...updateMessage(state, nextMessage),
    messageParts: upsert(state.messageParts, nextPart),
  }
}

export function operationForRun(
  state: BraidState,
  operationId: OperationId,
  runId: RunId,
  event: BraidEvent,
  at: string,
): OperationRecord {
  const existing = state.operations.find((entry) => entry.id === operationId)
  const requestDigest =
    event.kind === 'run.requested' && event.requestDigest !== undefined
      ? parseDigestValue(event.requestDigest)
      : canonicalDigest(event)
  return (
    existing ?? {
      id: operationId,
      kind: 'send',
      requestDigest,
      status: 'pending',
      target: { kind: 'run', id: runId },
      createdAt: at,
      updatedAt: at,
    }
  )
}

export function withHealth(state: BraidState): BraidState {
  const missingHistoryCount = state.missingHistory.length
  const unknownEventCount = state.unknownEvents.length
  return {
    ...state,
    health: {
      status:
        missingHistoryCount > 0 ? 'incomplete' : unknownEventCount > 0 ? 'degraded' : 'healthy',
      lastError: state.lastError,
      missingHistoryCount,
      unknownEventCount,
    },
  }
}
