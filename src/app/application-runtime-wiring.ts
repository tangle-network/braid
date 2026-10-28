import type { BraidState } from '../domain/state.js'
import type { PortViews } from './application-port-builder.js'
import { buildApplicationPortRuntime, type ApplicationPortRuntimeInput } from './application-port-runtime.js'
import { commitEventsAndWaitAtRevision, type TransitionHost } from './application-transition.js'
import type { AppSubscriber } from './application-types.js'

/** Pure wiring for the application's narrow ports; it owns no state. */
export interface ApplicationRuntimeWiringInput
  extends Omit<ApplicationPortRuntimeInput, 'commitBatchAndWait' | 'nextStateChange'> {
  readonly setState: (state: BraidState) => void
  readonly subscribers: ReadonlySet<AppSubscriber>
  readonly asynchronousJournal: boolean
  readonly transitionTail: () => Promise<void>
  readonly setTransitionTail: (tail: Promise<void>) => void
  readonly markStorageFailure: (error: unknown) => void
}

export interface ApplicationRuntimeWiring {
  readonly ports: PortViews
  readonly transition: TransitionHost
}

export function wireApplicationRuntime(
  input: ApplicationRuntimeWiringInput,
): ApplicationRuntimeWiring {
  // setState is the single post-construction state mutation, so waiters observe the new state.
  const stateWaiters = new Set<() => void>()
  const setState = (state: BraidState): void => {
    input.setState(state)
    for (const wake of [...stateWaiters]) wake()
  }
  // Aborting the signal removes the waiter, so abandoned waits do not accumulate on a quiet app.
  const nextStateChange = (signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve()
        return
      }
      const wake = (): void => {
        stateWaiters.delete(wake)
        signal.removeEventListener('abort', wake)
        resolve()
      }
      stateWaiters.add(wake)
      signal.addEventListener('abort', wake, { once: true })
    })
  const transition: TransitionHost = {
    state: input.currentState,
    setState,
    journal: input.journal,
    clock: input.clock,
    providerEventKeys: input.ledger,
    subscribers: input.subscribers,
    asynchronous: input.asynchronousJournal,
    transitionTail: input.transitionTail,
    setTransitionTail: input.setTransitionTail,
    storageFailure: input.storageFailure,
    markStorageFailure: input.markStorageFailure,
  }
  const ports = buildApplicationPortRuntime({
    currentState: input.currentState,
    profile: input.profile,
    commit: input.commit,
    commitAndWait: input.commitAndWait,
    commitBatchAndWait: (events) => commitEventsAndWaitAtRevision(transition, events),
    commitAndWaitRecovery: input.commitAndWaitRecovery,
    execution: input.execution,
    ledger: input.ledger,
    clock: input.clock,
    ids: input.ids,
    effects: input.effects,
    journal: input.journal,
    flush: input.flush,
    nextStateChange,
    storageFailure: input.storageFailure,
    executeControl: input.executeControl,
    admitPersistedSend: input.admitPersistedSend,
    fingerprint: input.fingerprint,
    send: input.send,
    ...(input.afterRuntimeEvent === undefined
      ? {}
      : { afterRuntimeEvent: input.afterRuntimeEvent }),
  })
  return { ports, transition }
}
