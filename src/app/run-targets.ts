import type { BraidRun, BraidState } from '../domain/state.js'
import { AppError } from './errors.js'

export interface ConversationTarget {
  readonly conversationId?: string
  readonly branchId?: string
}

export interface RunTarget extends ConversationTarget {
  readonly runId?: string
}

export interface ResolvedConversationTarget {
  readonly conversationId: string
  readonly branchId: string
}

/** Resolve identities without opening a conversation or changing foreground controls. */
export function resolveConversationTarget(
  state: BraidState,
  target: ConversationTarget,
  original?: ResolvedConversationTarget,
): ResolvedConversationTarget {
  validateCoordinates(target)
  if (original !== undefined) {
    assertSameTarget(target, original)
    return { conversationId: original.conversationId, branchId: original.branchId }
  }
  const explicitBranch =
    target.branchId === undefined
      ? undefined
      : state.branches.find((branch) => branch.id === target.branchId)
  if (target.branchId !== undefined && explicitBranch === undefined)
    throw new AppError('UNKNOWN_BRANCH', 'The requested branch is unavailable')
  const conversationId =
    target.conversationId ?? explicitBranch?.conversationId ?? state.conversationId
  const conversation = state.conversations.find(
    (candidate) => candidate.id === conversationId && candidate.deletedAt === undefined,
  )
  if (conversation === undefined)
    throw new AppError('UNKNOWN_CONVERSATION', 'The requested conversation is unavailable')
  const branchId =
    target.branchId ??
    (target.conversationId === undefined ? state.branchId : conversation.activeBranchId)
  const branch = state.branches.find((candidate) => candidate.id === branchId)
  if (branch === undefined)
    throw new AppError('UNKNOWN_BRANCH', 'The requested branch is unavailable')
  if (branch.conversationId !== conversationId)
    throw new AppError(
      'TARGET_CONFLICT',
      'The branch does not belong to the requested conversation',
    )
  return { conversationId, branchId }
}

/** A scope must identify exactly one live run; explicit/replayed run IDs need not be live. */
export function resolveRunTarget(
  state: BraidState,
  target: RunTarget,
  originalRunId?: string,
): BraidRun {
  validateCoordinates(target)
  if (originalRunId !== undefined && target.runId !== undefined && target.runId !== originalRunId)
    throw new AppError('OPERATION_CONFLICT', 'The operation is already bound to another run')
  const runId = originalRunId ?? target.runId
  if (runId !== undefined) {
    const run = state.runs.find((candidate) => candidate.id === runId)
    if (run === undefined) throw new AppError('UNKNOWN_RUN', `Run ${runId} is unavailable`)
    assertSameTarget(
      target,
      run,
      originalRunId === undefined ? 'TARGET_CONFLICT' : 'OPERATION_CONFLICT',
    )
    return run
  }
  // Validate supplied coordinates even when no run currently matches them.
  if (target.branchId !== undefined || target.conversationId !== undefined)
    resolveConversationTarget(state, target)
  const candidates = state.activeRuns.filter(
    (run) =>
      (target.conversationId === undefined || run.conversationId === target.conversationId) &&
      (target.branchId === undefined || run.branchId === target.branchId),
  )
  if (candidates.length === 0)
    throw new AppError('NO_ACTIVE_RUN', 'The requested scope has no active run')
  if (candidates.length !== 1)
    throw new AppError(
      'AMBIGUOUS_TARGET',
      'More than one run matches; supply runId or an exact branch',
    )
  const candidate = candidates[0]
  if (candidate === undefined) throw new AppError('NO_ACTIVE_RUN', 'No active run is available')
  return resolveRunTarget(state, { runId: candidate.runId })
}

function assertSameTarget(
  target: ConversationTarget,
  resolved: ResolvedConversationTarget,
  code = 'OPERATION_CONFLICT',
): void {
  if (
    (target.conversationId !== undefined && target.conversationId !== resolved.conversationId) ||
    (target.branchId !== undefined && target.branchId !== resolved.branchId)
  )
    throw new AppError(code, 'The supplied coordinates contradict the operation target')
}

function validateCoordinates(target: RunTarget): void {
  for (const name of ['runId', 'conversationId', 'branchId'] as const) {
    const value = target[name]
    if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0))
      throw new AppError('INVALID_PARAMS', `${name} must be a non-empty string`)
  }
}
