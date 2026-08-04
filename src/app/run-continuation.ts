import { snapshotAgentProfile, type AgentProfile } from '@tangle-network/agent-interface'
import { canonicalDigest } from '../domain/canonical.js'
import { redactProfile } from '../domain/redaction.js'
import type { BraidState } from '../domain/state.js'

/**
 * Return the only provider session that is safe for an ordinary follow-up.
 * A session is reusable only at the current branch tip and with the exact
 * recorded profile/connection identity from the completed predecessor.
 */
export function continuationSessionFor(input: {
  readonly state: BraidState
  readonly conversationId: string
  readonly branchId: string
  readonly profile: Readonly<AgentProfile>
  readonly connectionId?: string
}): string | undefined {
  if (
    input.conversationId !== input.state.conversationId ||
    input.branchId !== input.state.branchId
  )
    return undefined

  const previous = input.state.runs
    .filter((run) => run.conversationId === input.conversationId && run.branchId === input.branchId)
    .at(-1)
  if (
    previous === undefined ||
    previous.status !== 'completed' ||
    !previous.complete ||
    previous.providerSessionId === undefined ||
    !previous.capabilities.sessions.continue
  )
    return undefined

  const tip = input.state.messages.at(-1)
  if (
    tip === undefined ||
    tip.conversationId !== input.conversationId ||
    tip.branchId !== input.branchId ||
    tip.runId !== previous.id ||
    !tip.complete
  )
    return undefined

  const previousConnection =
    previous.connectionId ?? previous.receipt.requested.connectionId ?? undefined
  if (previousConnection !== input.connectionId) return undefined

  const currentProfileDigest = canonicalDigest(redactProfile(snapshotAgentProfile(input.profile)))
  if (previous.receipt.profileDigest !== currentProfileDigest) return undefined
  return previous.providerSessionId
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
