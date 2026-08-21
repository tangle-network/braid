import { AgentExactRunControlRefSchema } from '@tangle-network/agent-interface'
import type { SandboxClientLike, SandboxInstanceLike } from '@tangle-network/agent-provider-tangle'
import { stableProviderId } from '../runtime/production-backend-common.js'
import type {
  TangleRetainedControlLookup,
  TangleRetainedControlLookupInput,
} from './production-connection-types.js'

const PAGE_SIZE = 100
const MAX_PAGES = 1_000
const ACTIVE_STATUSES = Object.freeze(['pending', 'provisioning', 'running'])
const INACTIVE_STATUSES = Object.freeze(['stopped', 'failed', 'expired'])

type RetainedList = (options?: {
  readonly scope?: string
  readonly status?: readonly string[]
  readonly limit?: number
  readonly offset?: number
  readonly signal?: AbortSignal
}) => Promise<SandboxInstanceLike[]>

/**
 * Match the environment by its ownership marker alone.
 *
 * Runtime writes only `retainedIdempotencyKey` into provider metadata. Turn and
 * process identity live in the durable admission and in the session's own run
 * control reference, which this lookup reads before it returns anything.
 */
function matchesRetainedEnvironment(
  box: SandboxInstanceLike,
  input: TangleRetainedControlLookupInput,
): boolean {
  const metadata = box.metadata
  return (
    box.name === stableProviderId('braid-', input.providerSessionId) &&
    metadata?.owner === 'braid' &&
    metadata.lifecycle === 'retained' &&
    metadata.providerSessionId === input.providerSessionId &&
    metadata.retainedIdempotencyKey === input.environmentIdempotencyKey
  )
}

async function matchingEnvironments(
  client: SandboxClientLike,
  input: TangleRetainedControlLookupInput,
  statuses: readonly string[],
): Promise<SandboxInstanceLike[]> {
  const list = client.list as RetainedList
  const matches: SandboxInstanceLike[] = []
  const seen = new Set<string>()
  let offset = 0
  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
    input.signal?.throwIfAborted()
    const page = await list({
      scope: 'personal',
      status: statuses,
      limit: PAGE_SIZE,
      offset,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    input.signal?.throwIfAborted()
    for (const box of page) {
      if (seen.has(box.id)) throw new Error('Tangle retained lookup returned a duplicate sandbox')
      seen.add(box.id)
      if (matchesRetainedEnvironment(box, input)) matches.push(box)
    }
    if (page.length < PAGE_SIZE) return matches
    offset += page.length
  }
  throw new Error('Tangle retained lookup exceeded its bounded sandbox scan')
}

async function uniqueEnvironment(
  client: SandboxClientLike,
  input: TangleRetainedControlLookupInput,
): Promise<SandboxInstanceLike | null> {
  const active = await matchingEnvironments(client, input, ACTIVE_STATUSES)
  if (active.length > 1) throw new Error('Tangle retained lookup found multiple active sandboxes')
  if (active[0] !== undefined) return active[0]
  const inactive = await matchingEnvironments(client, input, INACTIVE_STATUSES)
  if (inactive.length > 1) throw new Error('Tangle retained lookup found multiple sandboxes')
  return inactive[0] ?? null
}

export function supportsTangleRetainedControlLookup(client: SandboxClientLike): boolean {
  return typeof client.get === 'function' && typeof client.list === 'function'
}

/** Finds one SDK-issued run reference without creating or changing cloud state. */
export function createTangleRetainedControlLookup(
  client: SandboxClientLike,
): TangleRetainedControlLookup {
  if (!supportsTangleRetainedControlLookup(client)) {
    throw new Error('Tangle retained lookup requires Sandbox list and get methods')
  }
  return async (input) => {
    const listed = await uniqueEnvironment(client, input)
    if (listed === null) return null
    input.signal?.throwIfAborted()
    const exact = await client.get?.(
      listed.id,
      input.signal === undefined ? undefined : { signal: input.signal },
    )
    input.signal?.throwIfAborted()
    if (exact === null || exact === undefined) return null
    if (!matchesRetainedEnvironment(exact, input)) {
      throw new Error('Tangle retained sandbox identity changed during exact lookup')
    }
    const session = exact.session?.(
      input.providerSessionId,
      input.signal === undefined ? undefined : { signal: input.signal },
    )
    if (session === undefined) return null
    const status = await session.status(
      input.signal === undefined ? undefined : { signal: input.signal },
    )
    input.signal?.throwIfAborted()
    if (status === null || typeof status !== 'object' || Array.isArray(status)) return null
    const parsed = AgentExactRunControlRefSchema.safeParse(
      (status as Record<string, unknown>).runControlRef,
    )
    if (!parsed.success) return null
    const controlRef = parsed.data
    if (
      controlRef.provider !== 'tangle-sandbox' ||
      controlRef.environmentId !== exact.id ||
      controlRef.sessionId !== input.providerSessionId ||
      controlRef.executionId !== input.executionId
    ) {
      throw new Error('Tangle retained session identified another exact run')
    }
    return controlRef
  }
}
