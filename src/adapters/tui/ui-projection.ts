import { messagesVisibleOnBranch } from '../../app/conversation-visibility.js'
import type { BraidEventEnvelope } from '../../domain/events.js'
import type { BraidState } from '../../domain/state.js'
import type { UiEvent } from '../../views/shared/intents.js'
import type {
  ActivityItemView,
  GraphNodeView,
  HeadlessState,
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
import { viewStatusForSemanticStatus } from '../../views/shared/semantic-query-types.js'

export const MAX_VISIBLE_MESSAGES = 200
export const MAX_VISIBLE_RUNS = 500

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

function partFor(message: BraidState['messages'][number]): TranscriptPartView[] {
  const parts = message.parts.map(semanticPart)
  if (parts.length > 0) return parts
  const text = boundVisibleText(message.text)
  return text
    ? [
        {
          id: `${message.id}:text`,
          kind: 'text' as const,
          text,
          status: message.status === 'streaming' ? ('running' as const) : ('complete' as const),
        },
      ]
    : []
}

function messagesFor(state: BraidState): MessageView[] {
  const branchExists = state.branches.some((branch) => branch.id === state.branchId)
  const visible = branchExists ? messagesVisibleOnBranch(state, state.branchId) : state.messages
  return visible.slice(-MAX_VISIBLE_MESSAGES).map((message) =>
    Object.freeze({
      id: message.id,
      role: message.role,
      text: sanitizeTerminalText(boundVisibleText(message.text)),
      status:
        message.status === 'aborted'
          ? ('cancelled' as const)
          : message.status === 'incomplete'
            ? ('incomplete' as const)
            : message.status,
      ...(message.runId ? { runId: message.runId } : {}),
      parts: Object.freeze(partFor(message)),
      ...(message.partsTruncated ? { partsTruncated: true } : {}),
    }),
  )
}

export function runViews(state: BraidState): RunView[] {
  return state.runs.slice(-MAX_VISIBLE_RUNS).map((run) =>
    Object.freeze({
      id: run.id,
      turnId: run.turnId,
      operationId: run.operationId,
      status: statusForRun(state, run),
      ...(run.error ? { error: sanitizeTerminalText(run.error) } : {}),
      ...(run.lastCursor ? { cursor: sanitizeTerminalText(run.lastCursor) } : {}),
      ...(run.providerSessionId
        ? { providerSessionId: sanitizeTerminalText(run.providerSessionId) }
        : {}),
      ...(run.costUsd === undefined && run.model === undefined
        ? {}
        : {
            usage: {
              ...(run.costUsd === undefined ? {} : { costUsd: run.costUsd }),
              ...(run.model === undefined ? {} : { model: run.model }),
            },
          }),
      completeness: completenessFor(state, run),
      ...(run.contentBytes === undefined ? {} : { contentBytes: run.contentBytes }),
      ...(run.contentTruncated ? { contentTruncated: true } : {}),
      ...(run.activityTruncated ? { activityTruncated: true } : {}),
      ...(run.eventDetailsTruncated ? { eventDetailsTruncated: true } : {}),
      ...(run.interactionsTruncated ? { interactionsTruncated: true } : {}),
    }),
  )
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
      const knownKind = request.kind === 'question' || request.kind === 'permission'
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
        allowedOutcomes: knownKind ? ['accept', 'reject', 'cancel'] : ['deny', 'cancel'],
        ...(request.timeoutMs === undefined ? {} : { remainingMs: request.timeoutMs }),
        queuePosition: views.length,
        secret: fields.some(
          (field) => field.type === 'secret' || field.name.toLowerCase().includes('secret'),
        ),
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
        type: candidate.type,
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
      return { kind: 'text', required: field.required ?? false, secret: false }
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
  return queryActivity(state)
    .activity.slice(-MAX_VISIBLE_RUNS)
    .map((item) => {
      const run =
        item.runId === undefined
          ? undefined
          : state.runs.find((candidate) => candidate.id === item.runId)
      return {
        id: item.id,
        kind: item.kind,
        title: item.title,
        status:
          run === undefined ? viewStatusForSemanticStatus(item.status) : statusForRun(state, run),
        ...(item.detail === undefined ? {} : { detail: item.detail }),
        ...(item.elapsedMs === undefined ? {} : { elapsedMs: item.elapsedMs }),
      }
    })
}

export function graphFor(state: BraidState): GraphNodeView[] {
  const result = queryGraph(state)
  const incoming = new Map<string, string>()
  for (const edge of result.edges) {
    incoming.set(edge.destinationNodeId, edge.kind)
  }
  const canonicalIncoming = new Map(state.graphEdges.map((edge) => [edge.destination, edge.kind]))
  return result.nodes.map((node) => {
    const run =
      node.type === 'run' ? state.runs.find((candidate) => candidate.id === node.id) : undefined
    const canonicalNode = state.graphNodes.find(
      (candidate) => candidate.reference.kind === node.type && candidate.reference.id === node.id,
    )
    const edgeLabel =
      (canonicalNode === undefined
        ? result.edges.find(
            (edge) => edge.destinationType === node.type && edge.destination === node.id,
          )?.kind
        : (canonicalIncoming.get(canonicalNode.id) ?? incoming.get(canonicalNode.id))) ?? undefined
    return {
      id: node.id,
      type: node.type,
      title: node.title,
      status: run ? statusForRun(state, run) : viewStatusForSemanticStatus(node.status),
      depth: node.depth,
      ...(edgeLabel === undefined ? {} : { edgeLabel }),
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
      ...(run.costUsd === undefined ? {} : { costUsd: run.costUsd }),
      ...(run.model === undefined ? {} : { model: sanitizeTerminalText(run.model) }),
      ...(run.error === undefined ? {} : { error: sanitizeTerminalText(run.error) }),
      completeness: completenessFor(state, run),
      ...(run.providerSessionId === undefined ? {} : { providerSessionId: run.providerSessionId }),
      ...(run.lastCursor === undefined ? {} : { cursor: run.lastCursor }),
      ...(run.contentBytes === undefined ? {} : { contentBytes: run.contentBytes }),
      ...(run.contentTruncated ? { contentTruncated: true } : {}),
      ...(run.activityTruncated ? { activityTruncated: true } : {}),
      ...(run.eventDetailsTruncated ? { eventDetailsTruncated: true } : {}),
      ...(run.interactionsTruncated ? { interactionsTruncated: true } : {}),
    })),
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
