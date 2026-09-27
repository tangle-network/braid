import type { AgentProfile } from '@tangle-network/agent-interface'
import type { BraidState } from '../domain/state.js'
import type { SendInput } from './application-types.js'
import { AppError } from './errors.js'
import { resolveEffectiveProfile } from './profile-selection.js'
import { resolveConversationTarget } from './run-targets.js'

export interface EffectiveRunConfiguration {
  readonly profile: Readonly<AgentProfile>
  readonly connectionId?: string
  readonly mode?: string
}

/** Project the selected configuration before a workspace creates its first conversation. */
export function selectedRunConfiguration(
  state: BraidState,
  authoredProfile: Readonly<AgentProfile>,
): EffectiveRunConfiguration {
  const conversation = state.conversations.find(
    (candidate) => candidate.id === state.conversationId && candidate.deletedAt === undefined,
  )
  const branch = state.branches.find(
    (candidate) => candidate.id === state.branchId && candidate.conversationId === conversation?.id,
  )
  if (conversation !== undefined && branch !== undefined) {
    return effectiveRunConfiguration(state, authoredProfile, {})
  }
  return Object.freeze({
    profile: authoredProfile,
    ...(state.selectedConnectionId === null
      ? {}
      : { connectionId: String(state.selectedConnectionId) }),
  })
}

/** Resolve one branch's durable choices into the immutable profile sent to agent-runtime. */
export function effectiveRunConfiguration(
  state: BraidState,
  authoredProfile: Readonly<AgentProfile>,
  input: Pick<SendInput, 'conversationId' | 'branchId' | 'mode'> & {
    readonly operationId?: string
  },
): EffectiveRunConfiguration {
  const original =
    input.operationId === undefined
      ? undefined
      : state.runs.find((run) => run.operationId === input.operationId)
  const { conversationId, branchId } = resolveConversationTarget(state, input, original)
  const conversation = state.conversations.find(
    (candidate) => candidate.id === conversationId && candidate.deletedAt === undefined,
  )
  if (conversation === undefined)
    throw new AppError('UNKNOWN_CONVERSATION', 'The requested conversation is unavailable')
  const branch = state.branches.find(
    (candidate) => candidate.id === branchId && candidate.conversationId === conversation.id,
  )
  if (branch === undefined)
    throw new AppError('UNKNOWN_BRANCH', 'The requested branch is unavailable')
  const resolved = resolveEffectiveProfile({
    profile: { profile: authoredProfile },
    ...(input.mode === undefined ? {} : { nextRunOverrides: { mode: input.mode } }),
    branchOverrides: {
      ...(branch.overrides.runner === undefined ? {} : { harness: branch.overrides.runner }),
      ...(branch.overrides.model === undefined ? {} : { model: branch.overrides.model }),
      ...(branch.overrides.effort === undefined ? {} : { effort: branch.overrides.effort }),
      ...(branch.overrides.mode === undefined ? {} : { mode: branch.overrides.mode }),
      ...(branch.connectionId === undefined ? {} : { connectionId: branch.connectionId }),
    },
    ...(state.selectedConnectionId === null
      ? {}
      : { userConnectionId: state.selectedConnectionId }),
  })
  return Object.freeze({
    profile: resolved.effectiveProfile,
    ...(resolved.connectionId === undefined ? {} : { connectionId: resolved.connectionId }),
    ...(resolved.mode === undefined ? {} : { mode: resolved.mode }),
  })
}
