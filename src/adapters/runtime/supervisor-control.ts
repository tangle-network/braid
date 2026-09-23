import {
  attachWorker as runtimeAttachWorker,
  type WorkerInteractiveProviderSource,
  type WorkerInteractiveSession,
  type WorkerSteerAcknowledgement,
  type WriteWorkerSteerOptions,
  writeWorkerSteer as runtimeWriteWorkerSteer,
} from '@tangle-network/agent-runtime/kernel'
import {
  cancelRun,
  cancelWorker,
  type RunCancellation,
  type WorkerCancellation,
} from '@tangle-network/agent-runtime/kernel'
import type { RetainedInteractiveRunHandle } from '@tangle-network/agent-runtime/kernel'
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
  readonly requestId?: string
  readonly file?: string
  readonly replayed?: boolean
  readonly effect?: WorkerSteerAcknowledgement['effect']
  readonly detail?: string
  readonly issue?: SupervisorCapabilityIssue
}

export interface SupervisorWorkerAttachResult {
  readonly status: 'attached' | 'unavailable'
  readonly worker: string
  readonly handle?: RetainedInteractiveRunHandle
  readonly issue?: SupervisorCapabilityIssue
}

export interface RuntimeSupervisorCapabilities {
  readonly workerSteer: boolean
  readonly workerAttach: boolean
  readonly workerSteerReason?: string
  readonly workerAttachReason?: string
}

export type SupervisorWorkerProviderSource =
  | WorkerInteractiveProviderSource
  | (() =>
      | WorkerInteractiveProviderSource
      | undefined
      | Promise<WorkerInteractiveProviderSource | undefined>)

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

function unsupportedCapabilityIssue(
  capability: string,
  reason: string,
): SupervisorCapabilityIssue {
  return {
    capability,
    packageName: '@tangle-network/agent-runtime',
    packageVersion: AGENT_RUNTIME_VERSION,
    reason,
    reproduction:
      "import * as runtime from '@tangle-network/agent-runtime'; console.log(Object.keys(runtime).filter((key) => key.includes('Worker')));",
  }
}

export function discoverRuntimeSupervisorCapabilities(input: {
  readonly steer?: typeof runtimeWriteWorkerSteer
  readonly attach?: typeof runtimeAttachWorker
  readonly providers?: WorkerInteractiveProviderSource
  readonly providersConfigured?: boolean
} = {}): RuntimeSupervisorCapabilities {
  const steer = input.steer ?? runtimeWriteWorkerSteer
  const attach = input.attach ?? runtimeAttachWorker
  const workerSteer = typeof steer === 'function'
  const workerAttach =
    typeof attach === 'function' && (input.providersConfigured ?? input.providers !== undefined)
  return {
    workerSteer,
    workerAttach,
    ...(workerSteer
      ? {}
      : { workerSteerReason: 'The installed Runtime does not expose retry-safe worker steering' }),
    ...(workerAttach
      ? {}
      : {
          workerAttachReason:
            input.providers === undefined
              ? 'No registered environment provider can reconnect a Runtime worker'
              : 'The installed Runtime does not expose exact worker attachment',
        }),
  }
}

function findWorker(workers: readonly WorkerView[], target: string): WorkerView | undefined {
  return workers.find((worker) => worker.id === target || worker.label === target)
}

export class RuntimeSupervisorController {
  readonly #watcher: RuntimeSupervisorSnapshotPort
  readonly #write: typeof runtimeWriteWorkerSteer
  readonly #cancelWorker: typeof cancelWorker
  readonly #cancelRun: typeof cancelRun
  readonly #attach: typeof runtimeAttachWorker | undefined
  readonly #providers:
    | SupervisorWorkerProviderSource
    | undefined
  readonly #capabilities: RuntimeSupervisorCapabilities

  constructor(
    options: {
      readonly watcher?: RuntimeSupervisorSnapshotPort
      readonly write?: typeof runtimeWriteWorkerSteer
      readonly cancelWorker?: typeof cancelWorker
      readonly cancelRun?: typeof cancelRun
      readonly attach?: typeof runtimeAttachWorker
      readonly providers?:
        | SupervisorWorkerProviderSource
    } = {},
  ) {
    this.#watcher = options.watcher ?? new RuntimeSupervisorWatcher()
    this.#write = options.write ?? runtimeWriteWorkerSteer
    this.#cancelWorker = options.cancelWorker ?? cancelWorker
    this.#cancelRun = options.cancelRun ?? cancelRun
    this.#attach = options.attach ?? runtimeAttachWorker
    this.#providers = options.providers
    this.#capabilities = discoverRuntimeSupervisorCapabilities({
      ...(options.write === undefined ? {} : { steer: options.write }),
      ...(options.attach === undefined ? {} : { attach: options.attach }),
      ...(isProviderSource(options.providers) ? { providers: options.providers } : {}),
      ...(options.providers === undefined ? {} : { providersConfigured: true }),
    })
  }

  capabilities(): RuntimeSupervisorCapabilities {
    return this.#capabilities
  }

  steerWorker(
    rootDir: string,
    supervisorId: string,
    workerIdOrLabel: string,
    message: string,
    operationId: string,
    source = 'braid',
  ): SupervisorWorkerSteerResult {
    const snapshot = this.#watcher.snapshot(rootDir)
    const supervisor = snapshot.supervisors.find((candidate) => candidate.id === supervisorId)
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
    if (!this.#capabilities.workerSteer) {
      return {
        status: 'unavailable',
        worker: worker.id,
        issue: unsupportedCapabilityIssue(
          'supervisor.worker.steer',
          this.#capabilities.workerSteerReason ?? 'Retry-safe worker steering is unavailable',
        ),
      }
    }
    const result = this.#write(rootDir, supervisorId, worker.id, {
      operationId,
      message,
      source,
    } satisfies WriteWorkerSteerOptions)
    const acknowledgement = result.acknowledgement
    return {
      status:
        acknowledgement === undefined || acknowledgement.effect === 'unknown'
          ? 'queued'
          : 'acknowledged',
      worker: result.worker,
      operationId: result.request.operationId,
      requestId: result.request.operationId,
      file: result.file,
      replayed: result.replayed,
      ...(acknowledgement === undefined ? {} : { effect: acknowledgement.effect }),
      ...(acknowledgement === undefined ? {} : { detail: acknowledgement.detail }),
    }
  }

  async attachWorker(
    rootDir: string,
    supervisorId: string,
    workerIdOrLabel: string,
    signal?: AbortSignal,
  ): Promise<SupervisorWorkerAttachResult> {
    const snapshot = this.#watcher.snapshot(rootDir)
    const supervisor = snapshot.supervisors.find((candidate) => candidate.id === supervisorId)
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
    if (!this.#capabilities.workerAttach || this.#attach === undefined) {
      return {
        status: 'unavailable',
        worker: worker.id,
        issue: unsupportedCapabilityIssue(
          'supervisor.worker.attach',
          this.#capabilities.workerAttachReason ?? 'Exact worker attachment is unavailable',
        ),
      }
    }
    let providers: WorkerInteractiveProviderSource | undefined
    try {
      providers = await this.#loadProviders()
    } catch (error) {
      return {
        status: 'unavailable',
        worker: worker.id,
        issue: unsupportedCapabilityIssue(
          'supervisor.worker.attach',
          error instanceof Error ? error.message : String(error),
        ),
      }
    }
    if (providers === undefined) {
      return {
        status: 'unavailable',
        worker: worker.id,
        issue: unsupportedCapabilityIssue(
          'supervisor.worker.attach',
          'No registered environment provider can reconnect a Runtime worker',
        ),
      }
    }
    let session: WorkerInteractiveSession
    try {
      session = await this.#attach(supervisor.stateDir, worker.id, {
        providers,
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      return {
        status: 'unavailable',
        worker: worker.id,
        issue: unsupportedCapabilityIssue(
          'supervisor.worker.attach',
          error instanceof Error ? error.message : String(error),
        ),
      }
    }
    if (session.status === 'unavailable') {
      return {
        status: 'unavailable',
        worker: worker.id,
        issue: unsupportedCapabilityIssue(
          'supervisor.worker.attach',
          `Runtime reported worker attachment unavailable: ${session.reason}`,
        ),
      }
    }
    return { status: 'attached', worker: worker.id, handle: session.handle }
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

  async #loadProviders(): Promise<WorkerInteractiveProviderSource | undefined> {
    if (this.#providers === undefined) return undefined
    return typeof this.#providers === 'function' ? await this.#providers() : this.#providers
  }
}

function isProviderSource(
  value: SupervisorWorkerProviderSource | undefined,
): value is WorkerInteractiveProviderSource {
  return value !== undefined && typeof value !== 'function'
}
