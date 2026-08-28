import {
  cancelRun,
  cancelWorker,
  type RunCancellation,
  type WorkerCancellation,
  type WorkerSteerAcknowledgement,
  type WorkerSteerRequest,
  writeWorkerSteer,
} from '@tangle-network/agent-runtime/kernel'
import type { SupervisorView, WorkerView } from '@tangle-network/agent-runtime/tui'
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
  readonly status: 'queued' | 'acknowledged' | 'unavailable'
  readonly worker: string
  readonly operationId?: string
  readonly requestDigest?: WorkerSteerRequest['requestDigest']
  readonly file?: string
  readonly replayed?: boolean
  readonly effect?: WorkerSteerAcknowledgement['effect']
  readonly detail?: string
  readonly issue?: SupervisorCapabilityIssue
}

export interface SupervisorWorkerCancelResult {
  readonly status: 'requested' | 'acknowledged' | 'unavailable'
  readonly worker: string
  readonly operationId?: string
  readonly effect?: WorkerCancellation['effect']
  readonly detail?: string
  readonly terminated?: readonly string[]
  readonly issue?: SupervisorCapabilityIssue
}

export interface SupervisorCancelResult {
  readonly status: 'requested' | 'acknowledged' | 'unavailable'
  readonly operationId?: string
  readonly effect?: RunCancellation['effect']
  readonly detail?: string
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

function missingSupervisorIssue(supervisorId: string): SupervisorCapabilityIssue {
  return {
    capability: 'supervisor.resolve',
    packageName: '@tangle-network/agent-runtime',
    packageVersion: AGENT_RUNTIME_VERSION,
    reason: `Runtime snapshot contains no supervisor with id '${supervisorId}'`,
    reproduction:
      "import { loadTopSnapshot } from '@tangle-network/agent-runtime/tui'; console.log(loadTopSnapshot(rootDir).supervisors);",
  }
}

function findWorker(workers: readonly WorkerView[], target: string): WorkerView | undefined {
  return workers.find((worker) => worker.id === target || worker.label === target)
}

export class RuntimeSupervisorController {
  readonly #watcher: RuntimeSupervisorSnapshotPort
  readonly #write: typeof writeWorkerSteer
  readonly #cancelWorker: typeof cancelWorker
  readonly #cancelRun: typeof cancelRun

  constructor(
    options: {
      readonly watcher?: RuntimeSupervisorSnapshotPort
      readonly write?: typeof writeWorkerSteer
      readonly cancelWorker?: typeof cancelWorker
      readonly cancelRun?: typeof cancelRun
    } = {},
  ) {
    this.#watcher = options.watcher ?? new RuntimeSupervisorWatcher()
    this.#write = options.write ?? writeWorkerSteer
    this.#cancelWorker = options.cancelWorker ?? cancelWorker
    this.#cancelRun = options.cancelRun ?? cancelRun
  }

  steerWorker(
    rootDir: string,
    supervisorId: string,
    workerIdOrLabel: string,
    operationId: string,
    message: string,
    source = 'braid',
    interrupt = false,
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
    const result = this.#write(rootDir, supervisorId, worker.id, {
      operationId,
      message,
      source,
      interrupt,
    })
    return {
      status:
        result.acknowledgement !== undefined && result.acknowledgement.effect !== 'unknown'
          ? 'acknowledged'
          : 'queued',
      worker: result.worker,
      operationId: result.request.operationId,
      requestDigest: result.request.requestDigest,
      file: result.file,
      replayed: result.replayed,
      ...(result.acknowledgement === undefined
        ? {}
        : {
            effect: result.acknowledgement.effect,
            detail: result.acknowledgement.detail,
          }),
    }
  }

  cancelWorker(
    rootDir: string,
    supervisorId: string,
    workerIdOrLabel: string,
    operationId: string,
    reason = 'cancelled by user',
    source = 'braid',
  ): SupervisorWorkerCancelResult {
    const supervisor = this.#findSupervisor(rootDir, supervisorId)
    if (supervisor === undefined) {
      return {
        status: 'unavailable',
        worker: workerIdOrLabel,
        issue: missingSupervisorIssue(supervisorId),
      }
    }
    const worker = findWorker(supervisor.workers, workerIdOrLabel)
    if (worker === undefined) {
      return {
        status: 'unavailable',
        worker: workerIdOrLabel,
        issue: missingWorkerIssue(workerIdOrLabel),
      }
    }
    const cancellation = this.#cancelWorker(supervisor.stateDir, worker.id, operationId, {
      reason,
      source,
    })
    return {
      status: cancellation.effect === 'unknown' ? 'requested' : 'acknowledged',
      worker: worker.id,
      operationId: cancellation.operationId,
      effect: cancellation.effect,
      ...(cancellation.detail === undefined ? {} : { detail: cancellation.detail }),
      terminated: cancellation.terminated,
    }
  }

  cancelSupervisor(
    rootDir: string,
    supervisorId: string,
    operationId: string,
    reason = 'cancelled by user',
    source = 'braid',
  ): SupervisorCancelResult {
    const supervisor = this.#findSupervisor(rootDir, supervisorId)
    if (supervisor === undefined) {
      return { status: 'unavailable', issue: missingSupervisorIssue(supervisorId) }
    }
    const cancellation = this.#cancelRun(supervisor.stateDir, operationId, { reason, source })
    return {
      status: cancellation.effect === 'unknown' ? 'requested' : 'acknowledged',
      operationId: cancellation.operationId,
      effect: cancellation.effect,
      ...(cancellation.detail === undefined ? {} : { detail: cancellation.detail }),
    }
  }

  #findSupervisor(rootDir: string, supervisorId: string): SupervisorView | undefined {
    return this.#watcher
      .snapshot(rootDir)
      .supervisors.find((candidate) => candidate.id === supervisorId)
  }
}
