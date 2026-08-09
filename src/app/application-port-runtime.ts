import type { AgentProfile } from '@tangle-network/agent-interface'
import type { BraidEvent } from '../domain/events.js'
import type { BraidState } from '../domain/state.js'
import type { Clock } from '../ports/clock.js'
import type { ExecutionPort } from '../ports/execution.js'
import type { IdSource } from '../ports/ids.js'
import { buildPortViews, type PortViews } from './application-port-builder.js'
import type { ControlEffectRequest, JournalWriter, StateReader } from './application-ports.js'
import type { ApplicationJournal } from './application-support.js'
import { startApplicationRun } from './application-support.js'
import type { SendInput, SendReceipt } from './application-types.js'
import type { SerializedEffectCoordinator } from './effect-coordinator.js'
import type { RunLedger } from './run-ledger.js'

export interface ApplicationPortRuntimeInput {
  readonly currentState: () => BraidState
  readonly profile: () => Readonly<AgentProfile>
  readonly commit: (event: BraidEvent) => void
  readonly commitAndWait: JournalWriter['commitAndWait']
  readonly commitAndWaitRecovery: NonNullable<JournalWriter['commitAndWaitRecovery']>
  readonly execution: ExecutionPort
  readonly ledger: RunLedger
  readonly clock: Clock
  readonly ids: IdSource
  readonly effects: SerializedEffectCoordinator
  readonly journal: ApplicationJournal
  readonly admitPersistedSend: (operationId: string, digest: string) => SendReceipt | undefined
  readonly fingerprint: import('./application-ports.js').AdmissionReplayAccess['fingerprint']
  readonly executeControl: (
    input: ControlEffectRequest,
  ) => Promise<import('../ports/execution.js').ControlAcknowledgement>
  readonly flush: () => Promise<void>
  readonly storageFailure: () => unknown
  readonly send: (input: SendInput) => SendReceipt
}

export function buildApplicationPortRuntime(input: ApplicationPortRuntimeInput): PortViews {
  const state: StateReader = {
    currentState: input.currentState,
    profile: input.profile,
    findRun: (runId) => {
      const run = input.currentState().runs.find((candidate) => candidate.id === runId)
      if (!run) throw new Error(`Run ${runId} is unknown`)
      return run
    },
    isTerminal: (status) =>
      status === 'completed' ||
      status === 'failed' ||
      status === 'aborted' ||
      status === 'cancelled' ||
      status === 'blocked' ||
      status === 'expired' ||
      status === 'unknown',
  }
  const journal: JournalWriter = {
    commit: input.commit,
    commitAndWait: input.commitAndWait,
    commitAndWaitRecovery: input.commitAndWaitRecovery,
  }
  return buildPortViews({
    state,
    journal,
    execution: input.execution,
    ledger: input.ledger,
    effects: input.effects,
    clock: input.clock,
    ids: input.ids,
    flush: input.flush,
    storageFailure: input.storageFailure,
    executeControl: input.executeControl,
    admitPersistedSend: input.admitPersistedSend,
    fingerprint: input.fingerprint,
    startRun: (context, runInput, admission, abort, requestDigest) =>
      startApplicationRun({
        effects: input.effects,
        journal: input.journal,
        context,
        runInput,
        admission,
        abort,
        requestDigest,
      }),
    send: input.send,
  })
}
