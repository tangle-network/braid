import type { AgentProfile } from '@tangle-network/agent-interface'
import { canonicalAgentProfileDigestHex } from '../adapters/agent-interface/profile-runtime.js'
import type { BraidState } from '../domain/state.js'
import { runSupportsNativeContinuation } from '../ports/execution.js'

export interface ContinuationInput {
  readonly state: BraidState
  readonly conversationId: string
  readonly branchId: string
  readonly profile: Readonly<AgentProfile>
  readonly connectionId?: string
}

/** Return the completed run at the requested branch tip with matching identity. */
function continuationRunFor(input: ContinuationInput): BraidState['runs'][number] | undefined {
  if (
    input.conversationId !== input.state.conversationId ||
    input.branchId !== input.state.branchId
  )
    return undefined

  const previous = input.state.runs
    .filter((run) => run.conversationId === input.conversationId && run.branchId === input.branchId)
    .at(-1)
  if (previous === undefined || previous.status !== 'completed' || !previous.complete)
    return undefined

  const tip = input.state.messages
    .filter(
      (message) =>
        message.conversationId === input.conversationId && message.branchId === input.branchId,
    )
    .at(-1)
  if (tip === undefined || tip.runId !== previous.id || !tip.complete) return undefined

  const previousConnection =
    previous.connectionId ?? previous.receipt.requested.connectionId ?? undefined
  if (previousConnection !== input.connectionId) return undefined

  const currentProfileDigest = canonicalAgentProfileDigestHex(input.profile)
  if (previous.receipt.profileDigest !== currentProfileDigest) return undefined
  return previous
}

/**
 * Return the only provider session that is safe for an ordinary follow-up.
 * A session is reusable only at the current branch tip and with the exact
 * recorded profile/connection identity from the completed predecessor.
 */
export function continuationSessionFor(input: ContinuationInput): string | undefined {
  const previous = continuationRunFor(input)
  if (
    previous === undefined ||
    previous.providerSessionId === undefined ||
    !previous.capabilities.sessions.continue
  )
    return undefined
  return previous.providerSessionId
}

/** Return the only run eligible for an exact native continuation. */
export function resolveNativeContinuationRun(
  input: ContinuationInput,
): BraidState['runs'][number] | undefined {
  const previous = continuationRunFor(input)
  if (
    previous === undefined ||
    previous.providerSessionId === undefined ||
    previous.controlRef === undefined ||
    !runSupportsNativeContinuation(previous.capabilities)
  )
    return undefined
  return previous
}

export function branchHasVisibleHistory(input: {
  readonly state: BraidState
  readonly conversationId: string
  readonly branchId: string
}): boolean {
  return input.state.messages.some(
    (message) =>
      message.conversationId === input.conversationId && message.branchId === input.branchId,
  )
}
