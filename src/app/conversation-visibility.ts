import type { MessageRecord } from '../domain/entities.js'
import type { BranchId, MessageId } from '../domain/ids.js'
import type { BraidState } from '../domain/state.js'
import { AppError } from './errors.js'

export function messagesVisibleOnBranch(
  state: BraidState,
  branchId: BranchId,
): readonly MessageRecord[] {
  return visibleForBranch(state, branchId, new Set())
}

function visibleForBranch(
  state: BraidState,
  branchId: BranchId,
  visiting: Set<string>,
): readonly MessageRecord[] {
  if (visiting.has(branchId))
    throw new AppError('GRAPH_CYCLE', `Branch ancestry includes ${branchId}`)
  const branch = state.branches.find((candidate) => candidate.id === branchId)
  if (!branch) throw new AppError('UNKNOWN_BRANCH', `Branch ${branchId} does not exist`)
  visiting.add(branchId)
  try {
    const inherited = branch.source
      ? messagesThroughBoundary(
          visibleForBranch(state, branch.source.branchId, visiting),
          branch.source.throughMessageId,
        )
      : []
    const local = state.messages.filter((message) => message.branchId === branchId)
    const seen = new Set(inherited.map((message) => message.id))
    return [...inherited, ...local.filter((message) => !seen.has(message.id))]
  } finally {
    visiting.delete(branchId)
  }
}

export function messagesThroughBoundary(
  messages: readonly MessageRecord[],
  throughMessageId: MessageId | undefined,
): readonly MessageRecord[] {
  if (throughMessageId === undefined) return []
  const index = messages.findIndex((message) => message.id === throughMessageId)
  if (index < 0) {
    throw new AppError(
      'UNKNOWN_MESSAGE_BOUNDARY',
      `Message ${throughMessageId} is not visible on the source branch`,
    )
  }
  return messages.slice(0, index + 1)
}
