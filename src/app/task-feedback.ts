import type { FeedbackTrajectory, PreferenceMemoryEntry } from '@tangle-network/agent-eval'
import { canonicalDigest, canonicalJson } from '../domain/canonical.js'
import type { FeedbackDecisionRecord, OperationRecord } from '../domain/entities.js'
import type { BraidEvent } from '../domain/events.js'
import { createFeedbackDecisionId, parseDigestValue } from '../domain/ids.js'
import { redactSensitiveText } from '../domain/redaction.js'
import type { BraidState } from '../domain/state.js'
import { stripTerminalControls } from '../domain/terminal-sanitizer.js'
import { SerializedActionQueue } from './action-serialization.js'
import { operationId } from './application-guards.js'
import { AppError } from './errors.js'
import type { OperationFingerprintPort } from './operation-fingerprint.js'

export interface RecordTaskFeedbackInput {
  readonly operationId: string
  readonly runId: string
  readonly outcome: 'accept' | 'reject'
  readonly reason?: string
}

export interface TaskFeedbackScope {
  /** Defaults to the selected conversation. Workspace scope must be explicit. */
  readonly scope?: 'conversation' | 'workspace'
  readonly conversationId?: string
  readonly runId?: string
}

export interface TaskFeedbackActions {
  record(input: RecordTaskFeedbackInput): Promise<FeedbackTrajectory>
  list(scope?: TaskFeedbackScope): Promise<FeedbackTrajectory[]>
  preferenceMemory(
    scope?: TaskFeedbackScope & { readonly maxEntries?: number },
  ): Promise<PreferenceMemoryEntry[]>
}

interface FeedbackHost extends OperationFingerprintPort {
  state(): BraidState
  now(): string
  commit(event: BraidEvent, expectedRevision: number): Promise<void>
}

/** Only explicit task judgments enter learning. Permission decisions remain operational history. */
export function taskFeedbackTrajectories(
  state: BraidState,
  scope: TaskFeedbackScope = {},
): FeedbackTrajectory[] {
  if (scope.scope === 'workspace' && scope.conversationId !== undefined)
    throw new AppError('INVALID_PARAMS', 'Workspace feedback cannot also select a conversation')
  const conversationId =
    scope.scope === 'workspace' ? undefined : (scope.conversationId ?? state.conversationId)
  if (
    conversationId !== undefined &&
    !state.conversations.some((item) => item.id === conversationId && item.deletedAt === undefined)
  )
    throw new AppError('UNKNOWN_CONVERSATION', 'The feedback conversation is unavailable')
  if (
    scope.runId !== undefined &&
    !state.runs.some(
      (run) =>
        run.id === scope.runId &&
        (conversationId === undefined || run.conversationId === conversationId),
    )
  )
    throw new AppError('UNKNOWN_RUN', 'The feedback run is unavailable in this scope')
  return state.feedbackDecisions.flatMap((decision) =>
    decision.taskTrajectory !== undefined &&
    !decision.automated &&
    (conversationId === undefined || decision.conversationId === conversationId) &&
    (scope.runId === undefined || decision.runId === scope.runId)
      ? [structuredClone(decision.taskTrajectory)]
      : [],
  )
}

export function createTaskFeedbackActions(host: FeedbackHost): TaskFeedbackActions {
  const queue = new SerializedActionQueue()
  return {
    record: (input) => queue.run(() => recordTaskFeedback(host, input)),
    list: async (scope) => taskFeedbackTrajectories(host.state(), scope),
    preferenceMemory: async (scope = {}) => {
      const { summarizePreferenceMemory } = await import('@tangle-network/agent-eval')
      return summarizePreferenceMemory(taskFeedbackTrajectories(host.state(), scope), {
        ...(scope.maxEntries === undefined ? {} : { maxEntries: scope.maxEntries }),
      })
    },
  }
}

async function recordTaskFeedback(
  host: FeedbackHost,
  input: RecordTaskFeedbackInput,
): Promise<FeedbackTrajectory> {
  const id = operationId(input.operationId, 'record_feedback')
  if (input.outcome !== 'accept' && input.outcome !== 'reject')
    throw new AppError('INVALID_PARAMS', 'Feedback outcome must be accept or reject')
  if (
    input.reason !== undefined &&
    (typeof input.reason !== 'string' || Buffer.byteLength(input.reason, 'utf8') > 4096)
  )
    throw new AppError('INVALID_PARAMS', 'Feedback reason must be at most 4096 UTF-8 bytes')
  const requestDigest = parseDigestValue(
    host.fingerprint({
      effectKind: 'task-feedback',
      request: { runId: input.runId, outcome: input.outcome, reason: input.reason ?? null },
    }),
  )
  const { createFeedbackTrajectory } = await import('@tangle-network/agent-eval')
  const state = host.state()
  const existing = state.operations.find((item) => item.id === id)
  if (existing !== undefined) {
    const decision = state.feedbackDecisions.find((item) => item.operationId === id)
    if (
      existing.kind !== 'custom' ||
      existing.requestDigest !== requestDigest ||
      decision?.taskTrajectory === undefined
    )
      throw new AppError(
        'OPERATION_CONFLICT',
        'The operation identifier already belongs to different input',
      )
    return structuredClone(decision.taskTrajectory)
  }
  const run = state.runs.find((item) => item.id === input.runId)
  if (run === undefined) throw new AppError('UNKNOWN_RUN', 'The feedback run is unavailable')
  if (!['completed', 'failed', 'cancelled', 'expired', 'aborted'].includes(run.status))
    throw new AppError(
      'FEEDBACK_RUN_NOT_FINISHED',
      'Finish the selected run before recording task feedback',
    )
  const reason =
    input.reason === undefined
      ? undefined
      : stripTerminalControls(redactSensitiveText(input.reason)).trim()
  const createdAt = host.now()
  const decisionId = createFeedbackDecisionId(
    `feedback-${canonicalDigest({ operationId: id }).slice(0, 48)}`,
  )
  // Eval returns optional undefined properties; omit them before journal redaction.
  const trajectory = JSON.parse(
    canonicalJson(
      createFeedbackTrajectory({
        id: String(decisionId),
        ...(state.workspaceId === null ? {} : { projectId: String(state.workspaceId) }),
        scenarioId: String(run.turnId),
        task: { intent: stripTerminalControls(redactSensitiveText(run.receipt.requested.text)) },
        attempts: [
          {
            id: String(run.id),
            stepIndex: 0,
            artifactType: 'other',
            artifact: { runId: String(run.id), receiptDigest: run.receipt.digest },
            createdAt: run.startedAt,
          },
        ],
        labels: [
          {
            id: String(decisionId),
            source: 'user',
            kind: input.outcome === 'accept' ? 'approve' : 'reject',
            value: input.outcome === 'accept',
            ...(reason ? { reason } : {}),
            createdAt,
          },
        ],
        tags: {
          source: 'braid.task-feedback',
          conversationId: String(run.conversationId),
          branchId: String(run.branchId),
          runId: String(run.id),
          profileDigest: run.receipt.profileDigest,
          ...(run.profileSnapshotId === undefined
            ? {}
            : { profileSnapshotId: String(run.profileSnapshotId) }),
          ...(run.receipt.requested.runner === undefined
            ? {}
            : { runner: run.receipt.requested.runner }),
          ...(run.receipt.requested.model === undefined
            ? {}
            : { requestedModel: run.receipt.requested.model }),
          ...(run.model === undefined ? {} : { recordedModel: run.model }),
          ...(run.connectionId === undefined ? {} : { connectionId: String(run.connectionId) }),
        },
        metadata: {
          runStatus: run.status,
          sourceComplete: run.complete,
          modelProvenance: 'provider-or-request-fallback',
          receiptDigest: run.receipt.digest,
        },
        createdAt,
      }),
    ),
  ) as FeedbackTrajectory
  const decision: FeedbackDecisionRecord = {
    id: decisionId,
    conversationId: run.conversationId,
    operationId: id,
    runId: run.id,
    category: input.outcome === 'accept' ? 'approval' : 'rejection',
    chosenOption: input.outcome,
    ...(reason ? { feedback: reason } : {}),
    automated: false,
    createdAt,
    taskTrajectory: trajectory,
  }
  const operation: OperationRecord = {
    id,
    kind: 'custom',
    requestDigest,
    status: 'terminal',
    terminalOutcome: 'completed',
    target: { kind: 'run', id: run.id },
    result: { feedbackId: String(decisionId) },
    createdAt,
    updatedAt: createdAt,
  }
  await host.commit({ kind: 'feedback.decision.recorded', decision, operation }, state.revision)
  return structuredClone(trajectory)
}
