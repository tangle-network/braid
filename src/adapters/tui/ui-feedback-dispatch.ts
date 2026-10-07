import { AppError } from '../../app/errors.js'
import type { TaskFeedbackScope } from '../../app/task-feedback.js'
import type { BraidIntent, UiDispatchResult } from '../../views/shared/intents.js'
import type { EntityBrowserDocument } from '../../views/tui/entity-browser.js'
import type { UiDispatchContext } from './ui-dispatch-context.js'

export async function dispatchFeedbackCommand(
  intent: Extract<BraidIntent, { readonly type: 'run-command' }>,
  context: UiDispatchContext,
): Promise<UiDispatchResult> {
  const [action, ...reason] = intent.args
  if (action === 'list' && reason.length === 0) {
    const state = context.app.state()
    const trajectories = await context.app.feedback.list({ conversationId: state.conversationId })
    const document: EntityBrowserDocument = {
      title: 'Task feedback',
      context: 'This conversation · explicit task judgments',
      emptyMessage: 'No task feedback. After a run, use /feedback accept or /feedback reject.',
      rows: trajectories
        .map((trajectory) => ({
          id: trajectory.id,
          kind: 'feedback',
          title: trajectory.task.intent,
          status: trajectory.labels[0]?.kind === 'approve' ? 'accepted' : 'rejected',
          ...(trajectory.tags?.runId === undefined ? {} : { runId: trajectory.tags.runId }),
          meta: trajectory.tags?.runner ?? 'runner unavailable',
          detailLines: [
            `Task: ${trajectory.task.intent}`,
            `Decision: ${trajectory.labels[0]?.kind === 'approve' ? 'accepted' : 'rejected'}`,
            `Reason: ${trajectory.labels[0]?.reason ?? 'No reason supplied; no preference lesson generated.'}`,
            `Run: ${trajectory.tags?.runId ?? 'unavailable'}`,
            `Runner: ${trajectory.tags?.runner ?? 'unavailable'}`,
            `Requested model: ${trajectory.tags?.requestedModel ?? 'unavailable'}`,
            `Reported model: ${trajectory.tags?.reportedModel ?? 'unavailable'}`,
            `Profile: ${trajectory.tags?.profileDigest ?? 'unavailable'}`,
            `Recorded: ${trajectory.createdAt}`,
          ],
        }))
        .reverse(),
    }
    return { kind: 'accepted', revision: state.revision, data: document }
  }
  if (action !== 'accept' && action !== 'reject')
    throw new AppError(
      'INVALID_PARAMS',
      'Use /feedback accept|reject [reason...] or /feedback list',
    )
  const state = context.app.state()
  const run =
    state.focusedRunId !== null
      ? state.runs.find((item) => item.id === state.focusedRunId)
      : [...state.runs]
          .reverse()
          .find(
            (item) =>
              item.conversationId === state.conversationId && item.branchId === state.branchId,
          )
  if (run === undefined)
    throw new AppError('UNKNOWN_RUN', 'Select a finished run before recording task feedback')
  const trajectory = await context.app.feedback.record({
    operationId: intent.operationId ?? '',
    runId: run.id,
    outcome: action,
    ...(reason.length === 0 ? {} : { reason: reason.join(' ') }),
  })
  context.setNotice(
    `Task ${action === 'accept' ? 'accepted' : 'rejected'} · feedback saved · /feedback list`,
  )
  context.notify()
  return { kind: 'accepted', revision: context.app.state().revision, data: trajectory }
}

export async function dispatchFeedbackHeadlessCommand(
  intent: Extract<BraidIntent, { readonly type: 'headless-command' }>,
  context: UiDispatchContext,
): Promise<UiDispatchResult | undefined> {
  if (intent.command === 'list_feedback') {
    const { scope, conversationId, runId } = intent.params
    if (scope !== undefined && scope !== 'conversation' && scope !== 'workspace')
      throw new AppError('INVALID_PARAMS', 'Feedback scope must be conversation or workspace')
    const selected: TaskFeedbackScope = {
      ...(scope === undefined ? {} : { scope }),
      ...(conversationId === undefined ? {} : { conversationId: text(conversationId) }),
      ...(runId === undefined ? {} : { runId: text(runId) }),
    }
    return {
      kind: 'accepted',
      revision: context.app.state().revision,
      data: await context.app.feedback.list(selected),
    }
  }
  if (intent.command !== 'record_feedback') return undefined
  const { outcome, reason } = intent.params
  if (outcome !== 'accept' && outcome !== 'reject')
    throw new AppError('INVALID_PARAMS', 'Feedback outcome must be accept or reject')
  const trajectory = await context.app.feedback.record({
    operationId: intent.operationId ?? '',
    runId: text(intent.params.runId),
    outcome,
    ...(reason === undefined ? {} : { reason: text(reason) }),
  })
  return { kind: 'accepted', revision: context.app.state().revision, data: trajectory }
}

function text(value: unknown): string {
  if (typeof value !== 'string')
    throw new AppError('INVALID_PARAMS', 'Feedback parameters must be strings')
  return value
}
