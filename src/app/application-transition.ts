import type { BraidEvent } from '../domain/events.js'
import type { BraidState } from '../domain/state.js'
import type { Clock } from '../ports/clock.js'
import {
  type ApplicationJournal,
  commitApplicationEvent,
  commitApplicationEventAsync,
} from './application-support.js'
import type { AppSubscriber } from './application-types.js'
import { AppError } from './errors.js'
import type { RunLedger } from './run-ledger.js'

export interface TransitionHost {
  readonly state: () => BraidState
  readonly setState: (state: BraidState) => void
  readonly journal: ApplicationJournal
  readonly clock: Clock
  readonly providerEventKeys: RunLedger
  readonly subscribers: ReadonlySet<AppSubscriber>
  readonly asynchronous: boolean
  readonly transitionTail: () => Promise<void>
  readonly setTransitionTail: (tail: Promise<void>) => void
  readonly storageFailure: () => unknown
  readonly markStorageFailure: (error: unknown) => void
}

export function createTransitionHost(
  input: Omit<
    TransitionHost,
    | 'state'
    | 'setState'
    | 'transitionTail'
    | 'setTransitionTail'
    | 'storageFailure'
    | 'markStorageFailure'
  > & {
    readonly state: () => BraidState
    readonly setState: (state: BraidState) => void
    readonly transitionTail: () => Promise<void>
    readonly setTransitionTail: (tail: Promise<void>) => void
    readonly storageFailure: () => unknown
    readonly markStorageFailure: (error: unknown) => void
  },
): TransitionHost {
  return input
}

export function commitEvent(host: TransitionHost, event: BraidEvent): void {
  commitEventInternal(host, event, false)
}

/**
 * Commits the one event needed to describe an uncertain external outcome.
 *
 * A failed journal write remains a fail-closed application state, but the
 * terminal event gets one explicit retry so the journal can record whether
 * the provider outcome is unknown.
 */
export function commitEventRecovery(host: TransitionHost, event: BraidEvent): void {
  commitEventInternal(host, event, true)
}

function commitEventInternal(host: TransitionHost, event: BraidEvent, recovery: boolean): void {
  if (!recovery && host.storageFailure() !== undefined)
    throw new AppError(
      'STORAGE_FAILURE',
      'Durable storage is unavailable; reopen Braid to continue',
    )
  if (host.asynchronous) {
    void commitEventAndWaitInternal(host, event, recovery).catch(() => undefined)
    return
  }
  try {
    host.setState(
      commitApplicationEvent({
        state: host.state(),
        event,
        journal: host.journal,
        clock: host.clock,
        providerEventKeys: host.providerEventKeys,
        subscribers: host.subscribers,
      }),
    )
  } catch (error) {
    host.markStorageFailure(error)
    throw error
  }
}

export function commitEventAndWait(host: TransitionHost, event: BraidEvent): Promise<void> {
  return commitEventAndWaitInternal(host, event, false)
}

export function commitEventAndWaitRecovery(host: TransitionHost, event: BraidEvent): Promise<void> {
  return commitEventAndWaitInternal(host, event, true)
}

export function commitEventsAndWaitAtRevision(
  host: TransitionHost,
  events: readonly BraidEvent[],
  expectedRevision?: number,
): Promise<void> {
  if (events.length === 0) return Promise.resolve()
  assertExpectedRevision(host.state(), expectedRevision)
  if (!host.asynchronous) {
    for (const event of events) commitEvent(host, event)
    return Promise.resolve()
  }

  const predecessor = host.transitionTail()
  const task = predecessor.then(async () => {
    const failure = host.storageFailure()
    if (failure !== undefined) throw failure
    assertExpectedRevision(host.state(), expectedRevision)
    for (const event of events) {
      host.setState(
        await commitApplicationEventAsync({
          state: host.state(),
          event,
          journal: host.journal,
          clock: host.clock,
          providerEventKeys: host.providerEventKeys,
          subscribers: host.subscribers,
        }),
      )
    }
  })
  const next = task.catch((error: unknown) => {
    if (!isRevisionError(error)) host.markStorageFailure(error)
  })
  host.setTransitionTail(next)
  return task
}

function assertExpectedRevision(state: BraidState, expectedRevision: number | undefined): void {
  if (expectedRevision === undefined) return
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new AppError(
      'INVALID_EXPECTED_REVISION',
      'expectedRevision must be a non-negative integer',
    )
  }
  if (state.revision !== expectedRevision) {
    throw new AppError(
      'STALE_REVISION',
      `The application changed at revision ${state.revision}; expected ${expectedRevision}`,
    )
  }
}

function isRevisionError(error: unknown): boolean {
  return (
    error instanceof AppError &&
    (error.code === 'STALE_REVISION' || error.code === 'INVALID_EXPECTED_REVISION')
  )
}

function commitEventAndWaitInternal(
  host: TransitionHost,
  event: BraidEvent,
  recovery: boolean,
): Promise<void> {
  if (!host.asynchronous) {
    if (recovery) commitEventRecovery(host, event)
    else commitEvent(host, event)
    return Promise.resolve()
  }
  const predecessor = recovery
    ? host.transitionTail().catch(() => undefined)
    : host.transitionTail()
  const task = predecessor.then(async () => {
    const failure = host.storageFailure()
    if (!recovery && failure !== undefined) throw failure
    host.setState(
      await commitApplicationEventAsync({
        state: host.state(),
        event,
        journal: host.journal,
        clock: host.clock,
        providerEventKeys: host.providerEventKeys,
        subscribers: host.subscribers,
      }),
    )
  })
  const next = task.catch((error: unknown) => {
    host.markStorageFailure(error)
    throw error
  })
  host.setTransitionTail(next)
  return task
}
