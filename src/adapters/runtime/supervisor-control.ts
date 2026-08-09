import { type RootHandle, writeWorkerSteer } from '@tangle-network/agent-runtime/kernel'
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
  readonly status: 'unavailable'
  readonly worker: string
  readonly issue: SupervisorCapabilityIssue
}

export interface SupervisorCancelResult {
  readonly status: 'accepted' | 'unavailable'
  readonly issue?: SupervisorCapabilityIssue
}

export const WORKER_CANCEL_UNAVAILABLE: SupervisorCapabilityIssue = {
  capability: 'supervisor.worker.cancel',
  packageName: '@tangle-network/agent-runtime',
  packageVersion: AGENT_RUNTIME_VERSION,
  reason:
    'The published runtime exposes RootHandle.abort for the whole supervisor and writeWorkerSteer for a worker inbox, but no worker-scoped cancellation method.',
  reproduction:
    "import { writeWorkerSteer } from '@tangle-network/agent-runtime/kernel'; import { loadTopSnapshot } from '@tangle-network/agent-runtime/tui'; console.log(Object.keys({ writeWorkerSteer, loadTopSnapshot }));",
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

  constructor(
    options: {
      readonly watcher?: RuntimeSupervisorSnapshotPort
      readonly rootHandle?: RootHandle<unknown>
      readonly write?: typeof writeWorkerSteer
    } = {},
  ) {
    this.#watcher = options.watcher ?? new RuntimeSupervisorWatcher()
    this.#rootHandle = options.rootHandle
    this.#write = options.write ?? writeWorkerSteer
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

  cancelWorker(worker: string): SupervisorWorkerCancelResult {
    return { status: 'unavailable', worker, issue: WORKER_CANCEL_UNAVAILABLE }
  }

  cancelSupervisor(reason = 'cancelled by user'): SupervisorCancelResult {
    if (this.#rootHandle === undefined)
      return { status: 'unavailable', issue: externalCancelIssue() }
    this.#rootHandle.abort(reason)
    return { status: 'accepted' }
  }
}
