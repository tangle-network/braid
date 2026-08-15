import { canonicalDigest } from './canonical.js'
import type { BraidEvent } from './events.js'
import { DomainInvariantError } from './invariants.js'
import { find, upsert } from './reducer-helpers.js'
import type { BraidState } from './state.js'

type RetainedAdmissionEvent = Extract<BraidEvent, { readonly kind: 'run.retained.admitted' }>
type Admission = RetainedAdmissionEvent['admission']

function sameAdmission(left: Admission, right: Admission): boolean {
  return canonicalDigest(left) === canonicalDigest(right)
}

function assertEnvironmentMatchesDispatch(
  environment: Extract<Admission, { readonly phase: 'environment' }>,
  dispatched: Extract<Admission, { readonly phase: 'dispatched' }>,
): void {
  const exact = dispatched.controlRef
  if (
    environment.provider !== exact.provider ||
    environment.environmentId !== exact.environmentId ||
    environment.sessionId !== exact.sessionId ||
    environment.executionId !== exact.executionId ||
    environment.idempotencyKey !== dispatched.idempotencyKey ||
    environment.turnId !== dispatched.turnId
  ) {
    throw new DomainInvariantError('Retained dispatch conflicts with its environment admission')
  }
}

export function applyRetainedAdmission(
  state: BraidState,
  event: RetainedAdmissionEvent,
  at: string,
): BraidState {
  const run = find(state.runs, event.runId, 'Run')
  const current = run.retainedAdmission
  const next = structuredClone(event.admission)

  if (run.providerSessionId !== undefined) {
    const sessionId = next.phase === 'environment' ? next.sessionId : next.controlRef.sessionId
    if (sessionId !== run.providerSessionId) {
      throw new DomainInvariantError(
        `Retained admission for ${run.id} conflicts with its provider session`,
      )
    }
  }

  if (current?.phase === 'environment' && next.phase === 'dispatched') {
    assertEnvironmentMatchesDispatch(current, next)
  } else if (current?.phase === 'dispatched' && next.phase === 'environment') {
    assertEnvironmentMatchesDispatch(next, current)
    return state
  } else if (current !== undefined) {
    if (!sameAdmission(current, next)) {
      throw new DomainInvariantError(`Retained admission for ${run.id} changed after persistence`)
    }
    return state
  } else if (next.phase === 'dispatched') {
    throw new DomainInvariantError(
      `Retained dispatch for ${run.id} has no durable environment admission`,
    )
  }

  return {
    ...state,
    runs: upsert(state.runs, {
      ...run,
      providerSessionId: next.phase === 'environment' ? next.sessionId : next.controlRef.sessionId,
      retainedAdmission: next,
      ...(next.phase === 'dispatched' ? { controlRef: structuredClone(next.controlRef) } : {}),
      updatedAt: at,
    }),
  }
}
