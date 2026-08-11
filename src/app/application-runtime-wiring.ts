import type { BraidEvent } from '../domain/events.js'
import type { BraidState } from '../domain/state.js'
import type { Clock } from '../ports/clock.js'
import type { ExecutionPort } from '../ports/execution.js'
import type { IdSource } from '../ports/ids.js'
import type { PortViews } from './application-port-builder.js'
import { buildApplicationPortRuntime } from './application-port-runtime.js'
import type { ControlDispatchOptions, ControlEffectRequest } from './application-ports.js'
import type { ApplicationJournal } from './application-support.js'
import {
  commitEventsAndWaitAtRevision,
  createTransitionHost,
  type TransitionHost,
} from './application-transition.js'
import type { AppSubscriber, SendInput, SendReceipt } from './application-types.js'
import type { SerializedEffectCoordinator } from './effect-coordinator.js'
import type { RunLedger } from './run-ledger.js'

/** Pure wiring for the application's narrow ports; it owns no state. */
export interface ApplicationRuntimeWiringInput {
  readonly currentState: () => BraidState
  readonly setState: (state: BraidState) => void
  readonly profile: () => Readonly<import('@tangle-network/agent-interface').AgentProfile>
  readonly commit: (event: BraidEvent) => void
  readonly commitAndWait: (event: BraidEvent) => void | Promise<void>
  readonly commitAndWaitRecovery: (event: BraidEvent) => void | Promise<void>
  readonly execution: ExecutionPort
  readonly ledger: RunLedger
  readonly clock: Clock
  readonly ids: IdSource
  readonly journal: ApplicationJournal
  readonly effects: SerializedEffectCoordinator
  readonly subscribers: ReadonlySet<AppSubscriber>
  readonly asynchronousJournal: boolean
  readonly transitionTail: () => Promise<void>
  readonly setTransitionTail: (tail: Promise<void>) => void
  readonly storageFailure: () => unknown
  readonly markStorageFailure: (error: unknown) => void
  readonly flush: () => Promise<void>
  readonly executeControl: (
    input: ControlEffectRequest,
    options?: ControlDispatchOptions,
  ) => Promise<import('../ports/execution.js').ControlAcknowledgement>
  readonly admitPersistedSend: (operationId: string, digest: string) => SendReceipt | undefined
  readonly fingerprint: import('./application-ports.js').AdmissionReplayAccess['fingerprint']
  readonly send: (input: SendInput) => SendReceipt
  readonly afterRuntimeEvent?: import('./application-port-builder.js').PortBuilderInput['afterRuntimeEvent']
}

export interface ApplicationRuntimeWiring {
  readonly ports: PortViews
  readonly transition: TransitionHost
}

export function wireApplicationRuntime(
  input: ApplicationRuntimeWiringInput,
): ApplicationRuntimeWiring {
  const transition = createTransitionHost({
    state: input.currentState,
    setState: input.setState,
    journal: input.journal,
    clock: input.clock,
    providerEventKeys: input.ledger,
    subscribers: input.subscribers,
    asynchronous: input.asynchronousJournal,
    transitionTail: input.transitionTail,
    setTransitionTail: input.setTransitionTail,
    storageFailure: input.storageFailure,
    markStorageFailure: input.markStorageFailure,
  })
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
