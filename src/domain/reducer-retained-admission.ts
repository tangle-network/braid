import { agentInteractiveSessionRefMatchesStart } from '@tangle-network/agent-interface'
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

function admissionFamily(admission: Admission): 'headless' | 'interactive' {
  return admission.phase.startsWith('interactive_') ? 'interactive' : 'headless'
}

function admissionSessionId(admission: Admission): string {
  switch (admission.phase) {
    case 'intent':
    case 'environment':
    case 'interactive_intent':
      return admission.sessionId
    case 'dispatched':
      return admission.controlRef.sessionId
    case 'interactive_environment':
      return admission.request.run.sessionId
    case 'interactive_started':
      return admission.ref.run.sessionId
  }
}

function admissionRank(admission: Admission): number {
  switch (admission.phase) {
    case 'intent':
    case 'interactive_intent':
      return 0
    case 'environment':
    case 'interactive_environment':
      return 1
    case 'dispatched':
    case 'interactive_started':
      return 2
  }
}

function assertIntentMatchesEnvironment(
  intent: Extract<Admission, { readonly phase: 'intent' }>,
  environment: Extract<Admission, { readonly phase: 'environment' }>,
): void {
  if (
    intent.provider !== environment.provider ||
    intent.idempotencyKey !== environment.idempotencyKey ||
    intent.turnId !== environment.turnId ||
    intent.sessionId !== environment.sessionId ||
    intent.executionId !== environment.executionId
  ) {
    throw new DomainInvariantError('Retained environment conflicts with its intent admission')
  }
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

function assertInteractiveIntentMatchesEnvironment(
  intent: Extract<Admission, { readonly phase: 'interactive_intent' }>,
  environment: Extract<Admission, { readonly phase: 'interactive_environment' }>,
): void {
  const exact = environment.request.run
  if (
    intent.provider !== environment.provider ||
    intent.provider !== exact.provider ||
    environment.environmentId !== exact.environmentId ||
    intent.idempotencyKey !== environment.idempotencyKey ||
    intent.interactiveIdempotencyKey !== environment.interactiveIdempotencyKey ||
    intent.sessionId !== exact.sessionId ||
    intent.executionId !== exact.executionId ||
    intent.requestedProfileDigest !== environment.request.requestedProfileDigest
  ) {
    throw new DomainInvariantError(
      'Retained interactive environment conflicts with its intent admission',
    )
  }
}

function assertInteractiveEnvironmentMatchesStarted(
  environment: Extract<Admission, { readonly phase: 'interactive_environment' }>,
  started: Extract<Admission, { readonly phase: 'interactive_started' }>,
): void {
  if (
    environment.idempotencyKey !== started.idempotencyKey ||
    environment.interactiveIdempotencyKey !== started.interactiveIdempotencyKey ||
    !agentInteractiveSessionRefMatchesStart(environment.request, started.ref)
  ) {
    throw new DomainInvariantError(
      'Retained interactive process conflicts with its environment admission',
    )
  }
}

function assertAdjacentAdmissions(first: Admission, second: Admission): void {
  if (first.phase === 'intent' && second.phase === 'environment') {
    assertIntentMatchesEnvironment(first, second)
    return
  }
  if (first.phase === 'environment' && second.phase === 'dispatched') {
    assertEnvironmentMatchesDispatch(first, second)
    return
  }
  if (first.phase === 'interactive_intent' && second.phase === 'interactive_environment') {
    assertInteractiveIntentMatchesEnvironment(first, second)
    return
  }
  if (first.phase === 'interactive_environment' && second.phase === 'interactive_started') {
    assertInteractiveEnvironmentMatchesStarted(first, second)
    return
  }
  throw new DomainInvariantError('Retained admission phases do not form one recovery sequence')
}

function assertTransition(current: Admission, next: Admission): 'advance' | 'replay' {
  if (admissionFamily(current) !== admissionFamily(next)) {
    throw new DomainInvariantError('Retained admission changed execution mode after persistence')
  }
  const currentRank = admissionRank(current)
  const nextRank = admissionRank(next)
  if (currentRank === nextRank) {
    if (!sameAdmission(current, next)) {
      throw new DomainInvariantError('Retained admission changed after persistence')
    }
    return 'replay'
  }
  if (nextRank === currentRank + 1) {
    assertAdjacentAdmissions(current, next)
    return 'advance'
  }
  if (nextRank === currentRank - 1) {
    assertAdjacentAdmissions(next, current)
    return 'replay'
  }
  throw new DomainInvariantError('Retained admission skipped a required durable phase')
}

export function applyRetainedAdmission(
  state: BraidState,
  event: RetainedAdmissionEvent,
  at: string,
): BraidState {
  const run = find(state.runs, event.runId, 'Run')
  const current = run.retainedAdmission
  const next = structuredClone(event.admission)
  const sessionId = admissionSessionId(next)

  if (run.providerSessionId !== undefined && sessionId !== run.providerSessionId) {
    throw new DomainInvariantError(
      `Retained admission for ${run.id} conflicts with its provider session`,
    )
  }

  if (current !== undefined && assertTransition(current, next) === 'replay') return state
  if (
    current === undefined &&
    (next.phase === 'dispatched' ||
      next.phase === 'interactive_environment' ||
      next.phase === 'interactive_started')
  ) {
    throw new DomainInvariantError(
      `Retained ${next.phase} admission for ${run.id} has no prior durable admission`,
    )
  }

  const controlRef =
    next.phase === 'dispatched'
      ? next.controlRef
      : next.phase === 'interactive_started'
        ? next.ref.run
        : undefined
  return {
    ...state,
    runs: upsert(state.runs, {
      ...run,
      providerSessionId: sessionId,
      retainedAdmission: next,
      ...(controlRef === undefined ? {} : { controlRef: structuredClone(controlRef) }),
      updatedAt: at,
    }),
  }
}
