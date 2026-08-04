import type { BraidEvent } from '../domain/events.js'
import { graphNodeId } from '../domain/graph-records.js'
import type { BraidState } from '../domain/state.js'
import { messagesVisibleOnBranch } from './conversation-context.js'
import { AppError } from './errors.js'

type ConversationImportedEvent = Extract<BraidEvent, { readonly kind: 'conversation.imported' }>

export function assertConversationImportReferences(event: ConversationImportedEvent): void {
  const branches = new Map(event.branches.map((branch) => [branch.id, branch] as const))
  const turns = new Map(event.turns.map((turn) => [turn.id, turn] as const))
  const runs = new Map(event.runs.map((run) => [run.id, run] as const))
  const messages = new Map(event.messages.map((message) => [message.id, message] as const))
  const parts = new Map(event.messageParts.map((part) => [part.id, part] as const))
  if (!branches.has(event.conversation.activeBranchId)) {
    throw new AppError('IMPORT_INVALID', 'Conversation import has no active branch')
  }
  for (const branch of event.branches) {
    if (branch.conversationId !== event.conversation.id) {
      throw new AppError('IMPORT_INVALID', `Branch ${branch.id} is outside the conversation`)
    }
    if (branch.source !== undefined) {
      if (
        branch.source.conversationId !== event.conversation.id ||
        !branches.has(branch.source.branchId)
      ) {
        throw new AppError('IMPORT_INVALID', `Branch ${branch.id} has a missing source branch`)
      }
      if (branch.source.throughTurnId !== undefined && !turns.has(branch.source.throughTurnId)) {
        throw new AppError('IMPORT_INVALID', `Branch ${branch.id} has a missing source turn`)
      }
    }
  }
  const referencedRuns = new Set<string>()
  for (const turn of event.turns) {
    if (turn.conversationId !== event.conversation.id || !branches.has(turn.branchId)) {
      throw new AppError('IMPORT_INVALID', `Turn ${turn.id} is outside the conversation`)
    }
    const userMessage = messages.get(turn.userMessageId)
    if (userMessage === undefined || userMessage.turnId !== turn.id) {
      throw new AppError('IMPORT_INVALID', `Turn ${turn.id} has a missing user message`)
    }
    for (const runId of turn.runIds) {
      const run = runs.get(runId)
      if (run === undefined || run.turnId !== turn.id) {
        throw new AppError('IMPORT_INVALID', `Turn ${turn.id} has a missing run`)
      }
      referencedRuns.add(runId)
    }
    if (turn.selectedRunId !== undefined && !turn.runIds.includes(turn.selectedRunId)) {
      throw new AppError('IMPORT_INVALID', `Turn ${turn.id} selects a run outside the turn`)
    }
  }
  for (const run of event.runs) {
    if (
      run.conversationId !== event.conversation.id ||
      !branches.has(run.branchId) ||
      !turns.has(run.turnId) ||
      !referencedRuns.has(run.id)
    ) {
      throw new AppError('IMPORT_INVALID', `Run ${run.id} is not attached to an imported turn`)
    }
  }
  const graphReferences = new Set([
    `workspace:${event.conversation.workspaceId}`,
    `conversation:${event.conversation.id}`,
    ...event.branches.map((record) => `branch:${record.id}`),
    ...event.turns.map((record) => `turn:${record.id}`),
    ...event.runs.map((record) => `run:${record.id}`),
    ...event.messages.map((record) => `message:${record.id}`),
    ...event.analyses.map((record) => `analysis:${record.id}`),
  ])
  for (const analysis of event.analyses) {
    if (
      analysis.source.conversationId !== event.conversation.id ||
      !branches.has(analysis.source.branchId)
    ) {
      throw new AppError('IMPORT_INVALID', `Analysis ${analysis.id} references a missing branch`)
    }
    if (analysis.source.runId !== undefined && !runs.has(analysis.source.runId)) {
      throw new AppError('IMPORT_INVALID', `Analysis ${analysis.id} references a missing run`)
    }
    if (
      analysis.source.missingHistory !== undefined &&
      !runs.has(analysis.source.missingHistory.runId)
    ) {
      throw new AppError('IMPORT_INVALID', `Analysis ${analysis.id} has a missing history run`)
    }
    if (
      analysis.source.throughMessageId !== undefined &&
      !messages.has(analysis.source.throughMessageId)
    ) {
      throw new AppError('IMPORT_INVALID', `Analysis ${analysis.id} references a missing message`)
    }
    for (const citation of analysis.findings.flatMap((finding) => finding.citations)) {
      if (citation.messageId !== undefined && !messages.has(citation.messageId)) {
        throw new AppError('IMPORT_INVALID', `Analysis ${analysis.id} has a dangling citation`)
      }
      if (citation.partId !== undefined && !parts.has(citation.partId)) {
        throw new AppError('IMPORT_INVALID', `Analysis ${analysis.id} has a dangling citation part`)
      }
      if (
        citation.messageId !== undefined &&
        citation.partId !== undefined &&
        parts.get(citation.partId)?.messageId !== citation.messageId
      ) {
        throw new AppError(
          'IMPORT_INVALID',
          `Analysis ${analysis.id} has a citation whose message and part disagree`,
        )
      }
    }
  }
  for (const message of event.messages) {
    if (message.conversationId !== event.conversation.id || !branches.has(message.branchId)) {
      throw new AppError('IMPORT_INVALID', `Message ${message.id} is outside the conversation`)
    }
    if (message.turnId !== undefined && !turns.has(message.turnId)) {
      throw new AppError('IMPORT_INVALID', `Message ${message.id} has a missing turn`)
    }
    if (message.runId !== undefined && !runs.has(message.runId)) {
      throw new AppError('IMPORT_INVALID', `Message ${message.id} has a missing run`)
    }
    if (message.missingHistory !== undefined && !runs.has(message.missingHistory.runId)) {
      throw new AppError('IMPORT_INVALID', `Message ${message.id} has a missing history run`)
    }
  }
  for (const node of event.graphNodes) {
    if (!graphReferences.has(`${node.reference.kind}:${node.reference.id}`)) {
      throw new AppError('IMPORT_INVALID', `Graph node ${node.id} references missing imported data`)
    }
  }
}

export function assertConversationImportNavigable(
  state: BraidState,
  event: ConversationImportedEvent,
): void {
  try {
    for (const branch of event.branches) messagesVisibleOnBranch(state, branch.id)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid branch ancestry'
    throw new AppError('IMPORT_INVALID', `Conversation import cannot be navigated: ${detail}`)
  }
}

export function assertConversationImportIdsAvailable(
  state: BraidState,
  event: ConversationImportedEvent,
): void {
  const groups: readonly [
    string,
    readonly { readonly id: string }[],
    readonly { readonly id: string }[],
  ][] = [
    ['conversation', state.conversations, [event.conversation]],
    ['branch', state.branches, event.branches],
    ['draft', state.drafts, event.drafts],
    ['queue', state.queues, event.queues],
    ['message', state.messages, event.messages],
    ['message part', state.messageParts, event.messageParts],
    ['turn', state.turns, event.turns],
    ['run', state.runs, event.runs],
    ['analysis', state.analyses, event.analyses],
    ['feedback', state.feedbackDecisions, event.feedbackDecisions],
  ]
  for (const [label, current, imported] of groups) {
    const existing = new Set(current.map((record) => record.id))
    if (imported.some((record) => existing.has(record.id))) {
      throw new AppError('IMPORT_ID_COLLISION', `Imported ${label} ID already exists`)
    }
  }
  const workspaceNodeId =
    state.workspaceId === null
      ? undefined
      : graphNodeId({ kind: 'workspace', id: state.workspaceId })
  const currentNodeIds = new Set(state.graphNodes.map((node) => node.id))
  if (event.graphNodes.some((node) => node.id !== workspaceNodeId && currentNodeIds.has(node.id))) {
    throw new AppError('IMPORT_ID_COLLISION', 'Imported graph node ID already exists')
  }
  const currentEdgeIds = new Set(state.graphEdges.map((edge) => edge.id))
  if (event.graphEdges.some((edge) => currentEdgeIds.has(edge.id))) {
    throw new AppError('IMPORT_ID_COLLISION', 'Imported graph edge ID already exists')
  }
}
