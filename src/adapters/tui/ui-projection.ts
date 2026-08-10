import type {
  InteractionRequest,
  InteractionOutcome as ProtocolInteractionOutcome,
} from '@tangle-network/agent-interface'
import { messagesVisibleOnBranch } from '../../app/conversation-visibility.js'
import { isSensitiveFieldName } from '../../domain/bounded-structured.js'
import type { BraidEventEnvelope } from '../../domain/events.js'
import type { BraidState } from '../../domain/state.js'
import { environmentView } from '../../views/shared/environment-presentation.js'
import type { UiEvent } from '../../views/shared/intents.js'
import type {
  ActivityItemView,
  GraphNodeView,
  HeadlessState,
  InteractionOutcome,
  InteractionView,
  MessageView,
  RunView,
  TranscriptPartView,
  ViewStatus,
} from '../../views/shared/models.js'
import { freezeView } from '../../views/shared/models.js'
import {
  boundVisibleText,
  redactStructuredValue,
  sanitizeTerminalText,
} from '../../views/shared/sanitize.js'
import { queryActivity } from '../../views/shared/semantic-activity.js'
import { queryGraph } from '../../views/shared/semantic-graph.js'
import { projectSemanticEvent, semanticPart } from '../../views/shared/semantic-projection.js'
import {
  type GraphQueryResult,
  viewStatusForSemanticStatus,
} from '../../views/shared/semantic-query-types.js'
import { sessionUsageFor, usageForRun } from '../../views/shared/usage-projection.js'

export const MAX_VISIBLE_MESSAGES = 200
export const MAX_VISIBLE_RUNS = 500

const ALL_PROTOCOL_INTERACTION_OUTCOMES = [
  'accepted',
  'declined',
  'cancelled',
] as const satisfies readonly ProtocolInteractionOutcome[]

export function statusFor(state: BraidState): ViewStatus {
  if (state.activeRunId) {
    const active = state.runs.find((run) => run.id === state.activeRunId)
    return active?.status === 'cancelling' ? 'cancelling' : 'running'
  }
  const status = state.runs.at(-1)?.status
  if (!status) return state.messages.length === 0 ? 'empty' : 'ready'
  switch (status) {
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'aborted':
      return 'cancelled'
    case 'blocked':
      return 'waiting'
    case 'streaming':
      return 'running'
    case 'cancelling':
      return 'cancelling'
    case 'unknown':
      return 'unknown'
    default:
      return 'unknown'
  }
}

function statusForRun(state: BraidState, run: BraidState['runs'][number]): ViewStatus {
  if (state.activeRunId === run.id) return run.status === 'cancelling' ? 'cancelling' : 'running'
  switch (run.status) {
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'aborted':
      return 'cancelled'
    case 'blocked':
      return 'waiting'
    case 'streaming':
      return 'running'
    default:
      return 'unknown'
  }
}

function partFor(
  message: BraidState['messages'][number],
  visibleMessageText: string,
): TranscriptPartView[] {
  const parts = message.parts.map((part) =>
    semanticPart(
      part,
      part.kind === 'text' && part.text === message.text ? visibleMessageText : undefined,
    ),
  )
  if (parts.length > 0) return parts
  return visibleMessageText
    ? [
        {
          id: `${message.id}:text`,
          kind: 'text' as const,
          text: visibleMessageText,
          status: message.status === 'streaming' ? ('running' as const) : ('complete' as const),
        },
      ]
    : []
}

function messagesFor(
  state: BraidState,
  options: { readonly completeText?: boolean } = {},
): MessageView[] {
  const branchExists = state.branches.some((branch) => branch.id === state.branchId)
  const visible = branchExists ? messagesVisibleOnBranch(state, state.branchId) : state.messages
  return visible.slice(-MAX_VISIBLE_MESSAGES).map((message) => {
    // Canonical message text is sanitized and byte-bounded before it enters state.
    // The terminal keeps that complete value so history navigation can restore it;
    // headless snapshots retain the smaller display projection by default.
    const text = options.completeText ? message.text : boundVisibleText(message.text)
    return Object.freeze({
      id: message.id,
      role: message.role,
      text,
      status:
        message.status === 'aborted'
          ? ('cancelled' as const)
          : message.status === 'incomplete'
            ? ('incomplete' as const)
            : message.status,
      ...(message.runId ? { runId: message.runId } : {}),
      parts: Object.freeze(partFor(message, text)),
      ...(message.partsTruncated ? { partsTruncated: true } : {}),
    })
  })
}

export function runViews(state: BraidState): RunView[] {
  return state.runs.slice(-MAX_VISIBLE_RUNS).map((run) => {
    const elapsed =
      run.terminalAt === undefined
        ? undefined
        : Date.parse(run.terminalAt) - Date.parse(run.startedAt)
    const runner = run.receipt.requested.runner ?? run.receipt.provider
    return Object.freeze({
      id: run.id,
      turnId: run.turnId,
      operationId: run.operationId,
      status: statusForRun(state, run),
      ...(run.error ? { error: sanitizeTerminalText(run.error) } : {}),
      ...(run.lastCursor ? { cursor: sanitizeTerminalText(run.lastCursor) } : {}),
      ...(run.providerSessionId
        ? { providerSessionId: sanitizeTerminalText(run.providerSessionId) }
        : {}),
      ...(run.receipt.requestedSessionId === undefined
        ? {}
        : { requestedSessionId: sanitizeTerminalText(run.receipt.requestedSessionId) }),
      usage: usageForRun(
        run,
        elapsed === undefined || !Number.isFinite(elapsed) || elapsed < 0 ? undefined : elapsed,
      ),
      ...(runner === undefined ? {} : { runner: sanitizeTerminalText(runner) }),
      ...(run.receipt.provider === undefined
        ? {}
        : { provider: sanitizeTerminalText(run.receipt.provider) }),
      ...(run.connectionId === undefined ? {} : { connection: String(run.connectionId) }),
      ...(run.environmentId === undefined ? {} : { environmentId: String(run.environmentId) }),
      completeness: completenessFor(state, run),
      ...(run.contentBytes === undefined ? {} : { contentBytes: run.contentBytes }),
      ...(run.contentTruncated ? { contentTruncated: true } : {}),
      ...(run.activityTruncated ? { activityTruncated: true } : {}),
      ...(run.eventDetailsTruncated ? { eventDetailsTruncated: true } : {}),
      ...(run.interactionsTruncated ? { interactionsTruncated: true } : {}),
    })
  })
}

function completenessFor(
  state: BraidState,
  run: BraidState['runs'][number],
): RunView['completeness'] {
  if (run.status === 'unknown') return 'unknown'
  if (state.missingHistory.some((range) => range.runId === run.id)) return 'missing-history'
  if (run.status === 'failed') return 'failed'
  if (!run.complete) return run.status === 'streaming' ? 'incomplete' : 'incomplete'
  if (!run.capabilities.events.stableIdentity && !run.capabilities.streaming.replay)
    return 'unavailable'
  return 'complete'
}

export function interactionViews(state: BraidState): InteractionView[] {
  const views: InteractionView[] = []
  for (const run of state.runs) {
    for (const item of run.interactions) {
      if (item.status !== 'pending') continue
      const request = item.request
      const fields = Array.isArray(request.answerSpec?.fields) ? request.answerSpec.fields : []
      const answerSpec = answerSpecFor(fields, request.kind)
      const subject = request.subject
        ? {
            type: request.subject.type,
            title: sanitizeTerminalText(
              request.subject.type === 'tool'
                ? request.subject.toolName
                : request.subject.type === 'file'
                  ? request.subject.path
                  : request.subject.type === 'command'
                    ? request.subject.command
                    : request.subject.uri,
            ),
          }
        : undefined
      const requesterProfile =
        run.receipt.requested.profile.name ?? state.profile.name ?? 'unnamed profile'
      const requesterRunner = run.receipt.requested.runner ?? run.receipt.requested.profile.harness
      views.push({
        runId: run.id,
        interactionId: request.id,
        profileName: sanitizeTerminalText(requesterProfile),
        ...(requesterRunner === undefined ? {} : { runner: sanitizeTerminalText(requesterRunner) }),
        kind: sanitizeTerminalText(request.kind),
        prompt: sanitizeTerminalText(request.body ?? request.title),
        ...(subject === undefined ? {} : { subject }),
        answerSpec,
        allowedOutcomes: allowedOutcomesFor(request),
        responseScopes: (request.responseScopes ?? ['interaction']).map((scope) =>
          scope === 'interaction' ? 'once' : scope,
        ),
        ...(request.timeoutMs === undefined ? {} : { remainingMs: request.timeoutMs }),
        queuePosition: views.length,
        secret: fields.some((field) => field.type === 'secret' || isSensitiveFieldName(field.name)),
        ...(run.providerSessionId === undefined ? {} : { providerSession: run.providerSessionId }),
      })
    }
  }
  return views
}

function answerSpecFor(
  fields: ReturnType<typeof fieldsOf>,
  kind: string,
): NonNullable<InteractionView['answerSpec']> {
  const field = fields.length === 1 ? fields[0] : undefined
  if (fields.length > 1) {
    return {
      kind: 'form',
      fields: fields.slice(0, 64).map((candidate) => ({
        name: sanitizeTerminalText(candidate.name),
        label: sanitizeTerminalText(candidate.label),
        type:
          candidate.type === 'text' && isSensitiveFieldName(candidate.name)
            ? 'secret'
            : candidate.type,
        required: candidate.required ?? false,
        ...(candidate.type === 'select'
          ? {
              options: candidate.options.slice(0, 128).map((option) => ({
                value: sanitizeTerminalText(option.value),
                label: sanitizeTerminalText(option.label),
              })),
            }
          : {}),
        ...(candidate.type === 'number' && candidate.min !== undefined
          ? { minimum: candidate.min }
          : {}),
        ...(candidate.type === 'number' && candidate.max !== undefined
          ? { maximum: candidate.max }
          : {}),
      })),
    }
  }
  if (!field) return { kind: 'unknown', label: `${kind} response`, safeToCancel: true }
  switch (field.type) {
    case 'text':
      return {
        kind: 'text',
        required: field.required ?? false,
        secret: isSensitiveFieldName(field.name),
      }
    case 'number':
      return {
        kind: 'number',
        required: field.required ?? false,
        ...(field.min === undefined ? {} : { minimum: field.min }),
        ...(field.max === undefined ? {} : { maximum: field.max }),
      }
    case 'boolean':
      return {
        kind: 'boolean',
        required: field.required ?? false,
        ...(field.default === undefined ? {} : { defaultValue: field.default }),
      }
    case 'select':
      return {
        kind: 'select',
        required: field.required ?? false,
        options: field.options.slice(0, 128).map((option) => ({
          value: sanitizeTerminalText(option.value),
          label: sanitizeTerminalText(option.label),
        })),
      }
    case 'secret':
      return { kind: 'secret', required: field.required ?? false }
    default:
      return { kind: 'unknown', label: `${kind} response`, safeToCancel: true }
  }
}

function allowedOutcomesFor(request: InteractionRequest): readonly InteractionOutcome[] {
  const outcomes = request.allowedOutcomes ?? ALL_PROTOCOL_INTERACTION_OUTCOMES
  return outcomes.map(uiOutcomeForProtocolOutcome)
}

function uiOutcomeForProtocolOutcome(outcome: ProtocolInteractionOutcome): InteractionOutcome {
  switch (outcome) {
    case 'accepted':
      return 'accept'
    case 'declined':
      return 'reject'
    case 'cancelled':
      return 'cancel'
  }
}

function fieldsOf(request: BraidState['runs'][number]['interactions'][number]['request']) {
  return Array.isArray(request.answerSpec?.fields) ? request.answerSpec.fields : []
}

function queueViews(state: BraidState): readonly {
  readonly operationId: string
  readonly runId: string
  readonly text: string
  readonly position: number
  readonly status: 'queued' | 'blocked' | 'unknown'
}[] {
  return state.queuedInputs.map((entry) => ({
    operationId: entry.operationId,
    runId: entry.runId,
    text: sanitizeTerminalText(entry.text),
    position: entry.position,
    status:
      state.runs.find((run) => run.id === entry.runId)?.status === 'unknown'
        ? ('unknown' as const)
        : state.missingHistory.some((range) => range.runId === entry.runId)
          ? ('blocked' as const)
          : ('queued' as const),
  }))
}

export function activityFor(state: BraidState): ActivityItemView[] {
  const workers = new Map(state.workers.map((worker) => [String(worker.id), worker] as const))
  const workerDepth = new Map<string, number>()
  const runs = new Map(state.runs.map((run) => [String(run.id), run] as const))
  return queryActivity(state, { limit: MAX_VISIBLE_RUNS }).activity.map((item) => {
    const run = item.runId === undefined ? undefined : runs.get(item.runId)
    const worker = item.entityType === 'worker' ? workers.get(item.entityId ?? '') : undefined
    const parentId =
      worker?.parentRuntimeRef !== undefined && worker.parentWorkerId === undefined
        ? undefined
        : (worker?.parentWorkerId ?? worker?.supervisorId)
    const depth =
      item.entityType === 'supervisor'
        ? 0
        : item.entityType === 'worker' && item.entityId !== undefined
          ? depthForWorker(item.entityId, workers, workerDepth)
          : undefined
    return {
      id: item.id,
      kind: item.kind,
      title: item.title,
      status:
        run !== undefined && item.entityType === 'run'
          ? statusForRun(state, run)
          : viewStatusForSemanticStatus(item.status),
      ...(item.detail === undefined ? {} : { detail: item.detail }),
      ...(item.elapsedMs === undefined ? {} : { elapsedMs: item.elapsedMs }),
      ...(item.startedAt === undefined ? {} : { startedAt: item.startedAt }),
      occurredAt: item.occurredAt,
      ...(item.sourceEventId === undefined ? {} : { sourceEventId: item.sourceEventId }),
      ...(item.runId === undefined ? {} : { runId: item.runId }),
      ...(item.entityType === undefined ? {} : { entityType: item.entityType }),
      ...(item.entityId === undefined ? {} : { entityId: item.entityId }),
      ...(parentId === undefined ? {} : { parentId: String(parentId) }),
      ...(depth === undefined ? {} : { depth }),
    }
  })
}

function depthForWorker(
  workerId: string,
  workers: ReadonlyMap<string, BraidState['workers'][number]>,
  memo: Map<string, number>,
): number {
  const known = memo.get(workerId)
  if (known !== undefined) return known
  const path: string[] = []
  const seen = new Set<string>()
  let cursor: string | undefined = workerId
  let depth = 0
  while (cursor !== undefined) {
    const previous = memo.get(cursor)
    if (previous !== undefined) {
      depth = previous
      break
    }
    if (seen.has(cursor) || path.length >= 256) break
    seen.add(cursor)
    path.push(cursor)
    cursor = workers.get(cursor)?.parentWorkerId
  }
  for (let index = path.length - 1; index >= 0; index -= 1) {
    depth += 1
    const id = path[index]
    if (id !== undefined) memo.set(id, depth)
  }
  return memo.get(workerId) ?? 1
}

export function graphFor(
  state: BraidState,
  result: GraphQueryResult = queryGraph(state),
): GraphNodeView[] {
  const runs = new Map(state.runs.map((run) => [String(run.id), run] as const))
  const canonicalNodes: Map<string, BraidState['graphNodes'][number]> = new Map(
    state.graphNodes.map((node) => [`${node.reference.kind}:${node.reference.id}`, node] as const),
  )
  const incoming: Map<string, string> = new Map()
  const semanticIncoming: Map<string, string> = new Map()
  for (const edge of result.edges) {
    incoming.set(edge.destinationNodeId, edge.kind)
    semanticIncoming.set(`${edge.destinationType}:${edge.destination}`, edge.kind)
  }
  const canonicalIncoming: Map<string, string> = new Map(
    state.graphEdges.map((edge) => [edge.destination, edge.kind]),
  )
  return result.nodes.map((node) => {
    const run = node.type === 'run' ? runs.get(node.id) : undefined
    const canonicalNode = canonicalNodes.get(`${node.type}:${node.id}`)
    const edgeLabel =
      (canonicalNode === undefined
        ? semanticIncoming.get(`${node.type}:${node.id}`)
        : (canonicalIncoming.get(canonicalNode.id) ?? incoming.get(canonicalNode.id))) ?? undefined
    return {
      id: node.id,
      type: node.type,
      title: node.title,
      status: run ? statusForRun(state, run) : viewStatusForSemanticStatus(node.status),
      depth: node.depth,
      ...(edgeLabel === undefined ? {} : { edgeLabel }),
      ...(node.runner === undefined ? {} : { runner: node.runner }),
      ...(node.elapsedMs === undefined ? {} : { elapsedMs: node.elapsedMs }),
      startedAt: node.createdAt,
      ...(node.costUsd === undefined ? {} : { costUsd: node.costUsd }),
    }
  })
}

export function toHeadlessState(
  state: BraidState,
  storageFailure?: string,
  cleanupUncertain?: string,
): HeadlessState {
  const messages = messagesFor(state)
  return freezeView({
    schemaVersion: state.schemaVersion,
    revision: state.revision,
    sequence: state.sequence,
    workspace: state.workspace ? sanitizeTerminalText(state.workspace) : null,
    conversationId: state.conversationId,
    branchId: state.branchId,
    conversations: state.conversations
      .filter((conversation) => conversation.deletedAt === undefined)
      .map((conversation) => ({
        id: conversation.id,
        title: sanitizeTerminalText(conversation.title),
        branchId: conversation.activeBranchId,
        archived: conversation.archived,
        updatedAt: conversation.updatedAt,
      })),
    profile: redactStructuredValue(state.profile, undefined, {
      maxBytes: 16 * 1024 * 1024,
    }) as Readonly<Record<string, unknown>>,
    draft: sanitizeTerminalText(state.draft),
    messages,
    runs: state.runs.slice(-MAX_VISIBLE_RUNS).map((run) => ({
      id: run.id,
      turnId: run.turnId,
      operationId: run.operationId,
      status: run.status,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      tokenStatus: usageForRun(run).tokenStatus ?? 'unknown',
      ...(run.reasoningTokens === undefined ? {} : { reasoningTokens: run.reasoningTokens }),
      ...(run.costUsd === undefined ? {} : { costUsd: run.costUsd }),
      ...(run.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: run.estimatedCostUsd }),
      costStatus: usageForRun(run).costStatus ?? 'unknown',
      ...(run.promptCache === undefined ? {} : { promptCache: run.promptCache }),
      ...(run.llmCalls === undefined ? {} : { llmCalls: run.llmCalls }),
      ...(run.llmLatencyMs === undefined ? {} : { llmLatencyMs: run.llmLatencyMs }),
      ...(run.model === undefined ? {} : { model: sanitizeTerminalText(run.model) }),
      ...(run.receipt.provider === undefined
        ? {}
        : { provider: sanitizeTerminalText(run.receipt.provider) }),
      ...(run.receipt.requested.runner === undefined
        ? {}
        : { runner: sanitizeTerminalText(run.receipt.requested.runner) }),
      ...(run.connectionId === undefined ? {} : { connectionId: String(run.connectionId) }),
      ...(run.receipt.requestedSessionId === undefined
        ? {}
        : { requestedSessionId: sanitizeTerminalText(run.receipt.requestedSessionId) }),
      ...(run.error === undefined ? {} : { error: sanitizeTerminalText(run.error) }),
      completeness: completenessFor(state, run),
      ...(run.providerSessionId === undefined ? {} : { providerSessionId: run.providerSessionId }),
      ...(run.environmentId === undefined ? {} : { environmentId: run.environmentId }),
      ...(run.receipt.materializationDigest === undefined
        ? {}
        : { materializationDigest: run.receipt.materializationDigest }),
      ...(run.lastCursor === undefined ? {} : { cursor: run.lastCursor }),
      ...(run.contentBytes === undefined ? {} : { contentBytes: run.contentBytes }),
      ...(run.contentTruncated ? { contentTruncated: true } : {}),
      ...(run.activityTruncated ? { activityTruncated: true } : {}),
      ...(run.eventDetailsTruncated ? { eventDetailsTruncated: true } : {}),
      ...(run.interactionsTruncated ? { interactionsTruncated: true } : {}),
    })),
    sessionUsage: sessionUsageFor(state),
    environments: Object.freeze(state.environments.map(environmentView)),
    interactions: interactionViews(state),
    queue: queueViews(state),
    activeRunId: state.activeRunId,
    lastError: state.lastError ? sanitizeTerminalText(state.lastError) : null,
    ...(storageFailure === undefined
      ? {}
      : { storageFailure: sanitizeTerminalText(storageFailure) }),
    ...(cleanupUncertain === undefined
      ? {}
      : { cleanupUncertain: sanitizeTerminalText(cleanupUncertain) }),
  })
}

export function toEvent(envelope: BraidEventEnvelope): UiEvent {
  const payload = projectSemanticEvent(envelope)
  return freezeView({
    sequence: envelope.sequence,
    revision: envelope.revision,
    kind: envelope.event.kind,
    payload: Object.freeze(payload),
  })
}

export { messagesFor, queueViews }
