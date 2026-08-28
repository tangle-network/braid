import type {
  InteractionRequest,
  InteractionOutcome as ProtocolInteractionOutcome,
} from '@tangle-network/agent-interface'
import { messagesVisibleOnBranch } from '../../app/conversation-visibility.js'
import { selectedRunConfiguration } from '../../app/effective-run-configuration.js'
import { profileModelSettings } from '../../app/profile-model-settings.js'
import { isSensitiveFieldName } from '../../domain/bounded-structured.js'
import type { BraidEventEnvelope } from '../../domain/events.js'
import { interactionRemainingMs } from '../../domain/interaction-timeout.js'
import { activeRunForBranch, isActiveRunStatus, type BraidState } from '../../domain/state.js'
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
  WorkStripItemView,
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
  const active = activeRunForBranch(state, state.conversationId, state.branchId)
  if (active) return viewStatusForRun(active.status)
  const status = state.runs
    .filter((run) => run.conversationId === state.conversationId && run.branchId === state.branchId)
    .at(-1)?.status
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
    case 'starting':
      return 'starting'
    case 'streaming':
      return 'running'
    case 'reconnecting':
      return 'reconnecting'
    case 'cancelling':
      return 'cancelling'
    case 'detached':
      return 'detached'
    case 'cancelled':
      return 'cancelled'
    case 'expired':
      return 'expired'
    case 'unknown':
      return 'unknown'
    default:
      return 'unknown'
  }
}

function statusForRun(_state: BraidState, run: BraidState['runs'][number]): ViewStatus {
  return viewStatusForRun(run.status)
}

function viewStatusForRun(status: BraidState['runs'][number]['status']): ViewStatus {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'aborted':
      return 'cancelled'
    case 'blocked':
      return 'waiting'
    case 'starting':
      return 'starting'
    case 'streaming':
      return 'running'
    case 'reconnecting':
      return 'reconnecting'
    case 'cancelling':
      return 'cancelling'
    case 'detached':
      return 'detached'
    case 'cancelled':
      return 'cancelled'
    case 'expired':
      return 'expired'
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
    const elapsed = completedRunDurationMs(run)
    const profile = run.receipt.requested.profile
    const modelSettings = profileModelSettings(profile)
    const runner = run.receipt.requested.runner ?? run.receipt.provider
    const model = run.model ?? run.receipt.requested.model
    const connectionId = run.connectionId === undefined ? undefined : String(run.connectionId)
    const connection =
      connectionId === undefined
        ? undefined
        : state.connections.find((candidate) => String(candidate.id) === connectionId)
    return Object.freeze({
      id: run.id,
      turnId: run.turnId,
      conversationId: String(run.conversationId),
      branchId: String(run.branchId),
      operationId: run.operationId,
      status: statusForRun(state, run),
      ...(profile.name === undefined ? {} : { profileName: sanitizeTerminalText(profile.name) }),
      profileDigest: sanitizeTerminalText(run.receipt.profileDigest),
      ...(model === undefined ? {} : { model: sanitizeTerminalText(model) }),
      ...(modelSettings.reasoningEffort === undefined
        ? {}
        : { effort: sanitizeTerminalText(modelSettings.reasoningEffort) }),
      ...(modelSettings.maxVisibleOutputTokens === undefined
        ? {}
        : { maxVisibleOutputTokens: modelSettings.maxVisibleOutputTokens }),
      ...(modelSettings.maxReasoningTokens === undefined
        ? {}
        : { maxReasoningTokens: modelSettings.maxReasoningTokens }),
      ...(modelSettings.maxTotalOutputTokens === undefined
        ? {}
        : { maxTotalOutputTokens: modelSettings.maxTotalOutputTokens }),
      ...(run.error ? { error: sanitizeTerminalText(run.error) } : {}),
      ...(run.lastCursor ? { cursor: sanitizeTerminalText(run.lastCursor) } : {}),
      ...(run.providerSessionId
        ? { providerSessionId: sanitizeTerminalText(run.providerSessionId) }
        : {}),
      ...(run.harnessSessionId
        ? { harnessSessionId: sanitizeTerminalText(run.harnessSessionId) }
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
      ...(connectionId === undefined ? {} : { connectionId }),
      ...(connectionId === undefined
        ? {}
        : {
            connection: sanitizeTerminalText(connection?.name ?? connectionId),
          }),
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

/** Projects the compact multi-run strip without widening the transcript layout. */
export function workStripFor(state: BraidState): readonly WorkStripItemView[] | undefined {
  const runs = state.runs.filter((run) => isActiveRunStatus(run.status))
  const queued = state.queuedInputs.flatMap((entry) => {
    const run = state.runs.find((candidate) => candidate.id === entry.runId)
    return run === undefined ? [] : [{ entry, run }]
  })
  const focusedRunId = state.focusedRunId ?? state.activeRunId
  const items: WorkStripItemView[] = runs.map((run) => ({
    id: run.id,
    runId: run.id,
    conversationId: String(run.conversationId),
    branchId: String(run.branchId),
    state: viewStatusForRun(run.status),
    ...(run.receipt.requested.runner === undefined
      ? {}
      : { runner: sanitizeTerminalText(run.receipt.requested.runner) }),
    ...(run.model === undefined ? {} : { model: sanitizeTerminalText(run.model) }),
    interactionCount: run.interactions.filter((item) => item.status === 'pending').length,
    focused: run.id === focusedRunId,
    actions: {
      switch: true,
      ask: run.complete && (run.status === 'completed' || run.status === 'failed'),
      steer: run.capabilities.controls.steer,
      cancel: run.capabilities.controls.cancel,
    },
  }))
  for (const { entry, run } of queued) {
    items.push({
      id: entry.operationId,
      runId: run.id,
      conversationId: String(run.conversationId),
      branchId: String(run.branchId),
      state: 'queued',
      ...(run.receipt.requested.runner === undefined
        ? {}
        : { runner: sanitizeTerminalText(run.receipt.requested.runner) }),
      ...(run.model === undefined ? {} : { model: sanitizeTerminalText(run.model) }),
      interactionCount: run.interactions.filter((item) => item.status === 'pending').length,
      focused: false,
      queueOperationId: entry.operationId,
      actions: {
        switch: true,
        ask: run.complete && (run.status === 'completed' || run.status === 'failed'),
        steer: false,
        cancel: false,
      },
    })
  }
  return items.length < 2 ? undefined : Object.freeze(items)
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

export function interactionViews(state: BraidState, now = Date.now()): InteractionView[] {
  const views: Array<Omit<InteractionView, 'queueTotal'>> = []
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
      const remainingMs = interactionRemainingMs(
        request.timeoutMs,
        item.source.occurredAt,
        run.startedAt,
        now,
      )
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
        ...(remainingMs === undefined ? {} : { remainingMs }),
        queuePosition: views.length,
        secret: fields.some((field) => field.type === 'secret' || isSensitiveFieldName(field.name)),
        ...(run.providerSessionId === undefined ? {} : { providerSession: run.providerSessionId }),
      })
    }
  }
  return views.map((view) => ({ ...view, queueTotal: views.length }))
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
  const analyses = new Map(
    state.analyses.map((analysis) => [String(analysis.id), analysis] as const),
  )
  const workerDepth = new Map<string, number>()
  const runs = new Map(state.runs.map((run) => [String(run.id), run] as const))
  return queryActivity(state, { limit: MAX_VISIBLE_RUNS }).activity.map((item) => {
    const run = item.runId === undefined ? undefined : runs.get(item.runId)
    const worker = item.entityType === 'worker' ? workers.get(item.entityId ?? '') : undefined
    const analysis = item.entityType === 'analysis' ? analyses.get(item.entityId ?? '') : undefined
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
      ...(worker === undefined ? {} : { supervisorId: String(worker.supervisorId) }),
      ...(analysis === undefined
        ? {}
        : {
            analysisFindings: analysis.findings.map((finding) => ({
              id: finding.id,
              title: sanitizeTerminalText(finding.text),
              supported: finding.supported && finding.citations.length > 0,
            })),
          }),
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
  const semanticParents = new Map<string, Set<string>>()
  for (const edge of result.edges) {
    incoming.set(edge.destinationNodeId, edge.kind)
    const destination = `${edge.destinationType}:${edge.destination}`
    semanticIncoming.set(destination, edge.kind)
    const parents = semanticParents.get(destination) ?? new Set<string>()
    parents.add(`${edge.sourceType}:${edge.source}`)
    semanticParents.set(destination, parents)
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
    const parentIds = semanticParents.get(`${node.type}:${node.id}`)
    return {
      id: node.id,
      type: node.type,
      title: node.title,
      status: run ? statusForRun(state, run) : viewStatusForSemanticStatus(node.status),
      depth: node.depth,
      ...(edgeLabel === undefined ? {} : { edgeLabel }),
      ...(parentIds === undefined ? {} : { parentIds: Object.freeze([...parentIds].sort()) }),
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
  const replayCursorByRun = new Map(state.replayCursors.map((entry) => [entry.runId, entry]))
  const configuration = selectedRunConfiguration(state, state.profile)
  const modelSettings = profileModelSettings(configuration.profile)
  const branch = state.branches.find((candidate) => candidate.id === state.branchId)
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
    runConfiguration: {
      profileName: sanitizeTerminalText(configuration.profile.name ?? 'Unnamed profile'),
      runner: sanitizeTerminalText(configuration.profile.harness ?? 'automatic'),
      model: sanitizeTerminalText(configuration.profile.model?.default ?? 'automatic'),
      ...(modelSettings.reasoningEffort === undefined
        ? {}
        : { effort: sanitizeTerminalText(modelSettings.reasoningEffort) }),
      ...(modelSettings.maxVisibleOutputTokens === undefined
        ? {}
        : { maxVisibleOutputTokens: modelSettings.maxVisibleOutputTokens }),
      ...(modelSettings.maxReasoningTokens === undefined
        ? {}
        : { maxReasoningTokens: modelSettings.maxReasoningTokens }),
      ...(modelSettings.maxTotalOutputTokens === undefined
        ? {}
        : { maxTotalOutputTokens: modelSettings.maxTotalOutputTokens }),
      ...(configuration.mode === undefined
        ? {}
        : { mode: sanitizeTerminalText(configuration.mode) }),
      ...(configuration.connectionId === undefined
        ? {}
        : { connectionId: String(configuration.connectionId) }),
      overrides: {
        ...(branch?.overrides.runner === undefined
          ? {}
          : { runner: sanitizeTerminalText(branch.overrides.runner) }),
        ...(branch?.overrides.model === undefined
          ? {}
          : { model: sanitizeTerminalText(branch.overrides.model) }),
        ...(branch?.overrides.effort === undefined
          ? {}
          : { effort: sanitizeTerminalText(branch.overrides.effort) }),
        ...(branch?.overrides.mode === undefined
          ? {}
          : { mode: sanitizeTerminalText(branch.overrides.mode) }),
      },
    },
    draft: sanitizeTerminalText(state.draft),
    messages,
    runs: state.runs.slice(-MAX_VISIBLE_RUNS).map((run) => {
      const replayCursor = replayCursorByRun.get(run.id)
      const durationMs = completedRunDurationMs(run)
      return {
        id: run.id,
        turnId: run.turnId,
        operationId: run.operationId,
        status: run.status,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
        ...(run.terminalAt === undefined ? {} : { terminalAt: run.terminalAt }),
        ...(durationMs === undefined ? {} : { durationMs }),
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        tokensKnown: run.tokensKnown !== false,
        usdKnown: run.usdKnown !== false,
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
        ...(run.providerSessionId === undefined
          ? {}
          : { providerSessionId: run.providerSessionId }),
        ...(run.harnessSessionId === undefined ? {} : { harnessSessionId: run.harnessSessionId }),
        ...(run.environmentId === undefined ? {} : { environmentId: run.environmentId }),
        ...(run.controlRef === undefined ? {} : { controlRef: structuredClone(run.controlRef) }),
        ...(run.receipt.materializationDigest === undefined
          ? {}
          : { materializationDigest: run.receipt.materializationDigest }),
        ...(run.lastCursor === undefined ? {} : { cursor: run.lastCursor }),
        ...(replayCursor === undefined
          ? {}
          : { cursorCommittedSequence: replayCursor.committedSequence }),
        ...(run.contentBytes === undefined ? {} : { contentBytes: run.contentBytes }),
        ...(run.contentTruncated ? { contentTruncated: true } : {}),
        ...(run.activityTruncated ? { activityTruncated: true } : {}),
        ...(run.eventDetailsTruncated ? { eventDetailsTruncated: true } : {}),
        ...(run.interactionsTruncated ? { interactionsTruncated: true } : {}),
      }
    }),
    sessionUsage: sessionUsageFor(state),
    environments: Object.freeze(state.environments.map(environmentView)),
    interactions: interactionViews(state),
    queue: queueViews(state),
    activeRunId: state.activeRunId,
    focusedRunId: state.focusedRunId,
    activeRuns: state.activeRuns,
    lastError: state.lastError ? sanitizeTerminalText(state.lastError) : null,
    ...(storageFailure === undefined
      ? {}
      : { storageFailure: sanitizeTerminalText(storageFailure) }),
    ...(cleanupUncertain === undefined
      ? {}
      : { cleanupUncertain: sanitizeTerminalText(cleanupUncertain) }),
  })
}

function completedRunDurationMs(run: BraidState['runs'][number]): number | undefined {
  if (run.terminalAt === undefined) return undefined
  const duration = Date.parse(run.terminalAt) - Date.parse(run.startedAt)
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined
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
