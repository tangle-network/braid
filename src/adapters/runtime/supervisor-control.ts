import {
  type RootHandle,
  cancelWorker as requestWorkerCancellation,
  supervisorRunDir,
  writeWorkerSteer,
} from '@tangle-network/agent-runtime/kernel'
import type { WorkerView } from '@tangle-network/agent-runtime/tui'
import { AGENT_RUNTIME_VERSION } from './agent-runtime-version.js'
import { type RuntimeSupervisorSnapshotPort, RuntimeSupervisorWatcher } from './supervisor-watch.js'

export { AGENT_RUNTIME_VERSION }

export interface SupervisorCapabilityIssue {
  readonly capability: string
  readonly packageName: string
  readonly packageVersion: string
  readonly reason: string
  readonly reproduction: string
}

export interface SupervisorWorkerSteerResult {
  readonly status: 'queued' | 'unavailable'
  readonly worker: string
  readonly requestId?: string
  readonly file?: string
  readonly issue?: SupervisorCapabilityIssue
}

export interface SupervisorWorkerCancelResult {
  readonly status: 'accepted' | 'unavailable'
  readonly worker: string
  readonly operationId?: string
  readonly effect?: 'unknown' | 'cancel_requested' | 'cancelled' | 'not_live'
  readonly detail?: string
  readonly terminated?: readonly string[]
  readonly issue?: SupervisorCapabilityIssue
}

export interface SupervisorCancelResult {
  readonly status: 'accepted' | 'unavailable'
  readonly issue?: SupervisorCapabilityIssue
}

function missingWorkerIssue(worker: string): SupervisorCapabilityIssue {
  return {
    capability: 'supervisor.worker.resolve',
    packageName: '@tangle-network/agent-runtime',
    packageVersion: AGENT_RUNTIME_VERSION,
    reason: `Runtime snapshot contains no worker with id or label '${worker}'`,
    reproduction:
      "import { loadTopSnapshot } from '@tangle-network/agent-runtime/tui'; console.log(loadTopSnapshot(rootDir).supervisors.flatMap((supervisor) => supervisor.workers));",
  }
}

function externalCancelIssue(): SupervisorCapabilityIssue {
  return {
    capability: 'supervisor.cancel.external',
    packageName: '@tangle-network/agent-runtime',
    packageVersion: AGENT_RUNTIME_VERSION,
    reason:
      'The published runtime monitor can reload persisted state and enqueue worker steering, but it does not expose an external root cancellation operation.',
    reproduction:
      "import * as runtime from '@tangle-network/agent-runtime/kernel'; console.log('RootHandle.abort exists only on an in-process handle', runtime);",
  }
}

function findWorker(workers: readonly WorkerView[], target: string): WorkerView | undefined {
  return workers.find((worker) => worker.id === target || worker.label === target)
}

export class RuntimeSupervisorController {
  readonly #watcher: RuntimeSupervisorSnapshotPort
  readonly #rootHandle: RootHandle<unknown> | undefined
  readonly #write: typeof writeWorkerSteer
  readonly #cancel: typeof requestWorkerCancellation

  constructor(
    options: {
      readonly watcher?: RuntimeSupervisorSnapshotPort
      readonly rootHandle?: RootHandle<unknown>
      readonly write?: typeof writeWorkerSteer
      readonly cancel?: typeof requestWorkerCancellation
    } = {},
  ) {
    this.#watcher = options.watcher ?? new RuntimeSupervisorWatcher()
    this.#rootHandle = options.rootHandle
    this.#write = options.write ?? writeWorkerSteer
    this.#cancel = options.cancel ?? requestWorkerCancellation
  }

  steerWorker(
    rootDir: string,
    supervisorId: string,
    workerIdOrLabel: string,
    message: string,
    source = 'braid',
  ): SupervisorWorkerSteerResult {
    const snapshot = this.#watcher.snapshot(rootDir)
    const supervisor = snapshot.supervisors.find((candidate) => candidate.id === supervisorId)
    const worker =
      supervisor === undefined ? undefined : findWorker(supervisor.workers, workerIdOrLabel)
    if (worker === undefined) {
      return {
        status: 'unavailable',
        worker: workerIdOrLabel,
        issue: missingWorkerIssue(workerIdOrLabel),
      }
    }
    const result = this.#write(rootDir, supervisorId, worker.label, message, source)
    return {
      status: 'queued',
      worker: result.worker,
      requestId: result.request.id,
      file: result.file,
    }
  }

  cancelWorker(
    rootDir: string,
    supervisorId: string,
    workerIdOrLabel: string,
    operationId: string,
    reason?: string,
    source = 'braid',
  ): SupervisorWorkerCancelResult {
    // Braid already resolved and durably stored the exact Runtime identities.
    // Do not require a live snapshot here: a retry must still read Runtime's
    // acknowledgement after the worker disappears or the monitor restarts.
    const result = this.#cancel(
      supervisorRunDir(rootDir, supervisorId),
      workerIdOrLabel,
      operationId,
      {
        ...(reason === undefined ? {} : { reason }),
        source,
      },
    )
    return {
      status: 'accepted',
      worker: result.workerId ?? result.worker,
      operationId: result.operationId,
      effect: result.effect,
      ...(result.detail === undefined ? {} : { detail: result.detail }),
      terminated: result.terminated,
    }
  }

  cancelSupervisor(reason = 'cancelled by user'): SupervisorCancelResult {
    if (this.#rootHandle === undefined)
      return { status: 'unavailable', issue: externalCancelIssue() }
    this.#rootHandle.abort(reason)
    return { status: 'accepted' }
  }
}
