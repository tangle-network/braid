import type { SandboxClientLike, SandboxInstanceLike } from '@tangle-network/agent-provider-tangle'
import type { ExecutionEnvironmentObservation } from '../../domain/execution-observation.js'
import type { ExecutionObservationSource, SandboxLifecyclePolicy } from './prepared-execution.js'
import { observeSandboxAccount } from './sandbox-account-observation.js'
import {
  captureSandboxBox,
  captureSandboxPlacement,
  requestedSandboxRegion,
  requestedSandboxResources,
  wrapObservedSandboxBox,
} from './sandbox-instance-observation.js'
import {
  boundedObservationText,
  completesWithin,
  type MutableSandboxObservation,
  type ObservableSandboxClient,
  type ObservableSandboxInstance,
} from './sandbox-observation-types.js'

export interface SandboxObservationBinding {
  readonly client: SandboxClientLike
  readonly observation: ExecutionObservationSource
}

/** Adds secret-free observation without changing the provider contract. */
export function observeSandboxClient(
  source: SandboxClientLike,
  lifecycle: SandboxLifecyclePolicy,
  now: () => string = () => new Date().toISOString(),
): SandboxObservationBinding {
  const client = source as ObservableSandboxClient
  const unavailable = new Set<string>([
    'machine-ip:not-exposed-by-provider',
    'effective-resources:not-exposed-by-provider',
    'disk-usage:not-exposed-by-provider',
    'per-sandbox-cpu-ram-storage-cost:not-exposed-by-provider',
  ])
  const state: MutableSandboxObservation = { lifecycle: 'requested', createdAt: now() }
  const pending: Promise<void>[] = []
  let pendingCount = 0
  const originals = new WeakMap<object, SandboxInstanceLike>()

  const track = (task: Promise<void>): void => {
    pendingCount += 1
    pending.push(
      task
        .catch(() => undefined)
        .then(() => {
          pendingCount -= 1
        }),
    )
  }

  observeSandboxAccount(client, state, unavailable, track, now)

  const observeBox = (box: ObservableSandboxInstance): SandboxInstanceLike => {
    captureSandboxBox(state, box, unavailable)
    if (source.describePlacement === undefined) {
      unavailable.add('verified-placement:not-exposed-by-client')
    } else {
      track(
        Promise.resolve()
          .then(() => source.describePlacement?.(box))
          .then((placement) => captureSandboxPlacement(state, placement, unavailable)),
      )
    }
    const proxy = wrapObservedSandboxBox(box, state, unavailable)
    originals.set(proxy as object, box)
    return proxy
  }

  const wrapped: SandboxClientLike = {
    async create(options, requestOptions) {
      state.lifecycle = 'creating'
      state.name = boundedObservationText(options?.name)
      state.requestedResources = requestedSandboxResources(options?.resources)
      state.requestedRegion = requestedSandboxRegion(options?.driver)
      state.storagePersistence = options?.ephemeral === true ? 'ephemeral-home' : 'persistent-home'
      try {
        const box = (await source.create(options, requestOptions)) as ObservableSandboxInstance
        return observeBox(box)
      } catch (error) {
        state.lifecycle = 'failed'
        unavailable.add('provider-environment-id:not-materialized')
        throw error
      }
    },
    ...(source.get === undefined
      ? {}
      : {
          async get(id, requestOptions) {
            const box = (await source.get?.(id, requestOptions)) as
              | ObservableSandboxInstance
              | null
              | undefined
            return box === null || box === undefined ? null : observeBox(box)
          },
        }),
    ...(source.list === undefined
      ? {}
      : {
          list: (options) => source.list?.(options) ?? Promise.resolve([]),
        }),
    ...(source.describePlacement === undefined
      ? {}
      : {
          describePlacement: (box) =>
            source.describePlacement?.(originals.get(box as object) ?? box),
        }),
  }

  return {
    client: wrapped,
    observation: {
      async snapshot() {
        const settled = await completesWithin(Promise.all(pending), 1_000)
        const currentUnavailable = new Set(unavailable)
        if (!settled || pendingCount > 0)
          currentUnavailable.add('account-or-placement-observation:pending')
        if (state.machineId === undefined)
          currentUnavailable.add('machine-id:not-exposed-by-provider')
        if (state.region === undefined)
          currentUnavailable.add('verified-region:not-exposed-by-provider')
        return freezeObservation(state, lifecycle, currentUnavailable, now())
      },
    },
  }
}

function freezeObservation(
  state: MutableSandboxObservation,
  lifecycle: SandboxLifecyclePolicy,
  unavailable: ReadonlySet<string>,
  observedAt: string,
): ExecutionEnvironmentObservation {
  return Object.freeze({
    kind: 'sandbox',
    provider: 'tangle-sandbox',
    ...(state.providerEnvironmentId === undefined
      ? {}
      : { providerEnvironmentId: state.providerEnvironmentId }),
    ...(state.name === undefined ? {} : { name: state.name }),
    lifecycle: state.lifecycle,
    lifecycleMode: lifecycle.mode,
    cleanup: lifecycle.cleanup,
    continuity: lifecycle.continuity,
    location: 'remote',
    ...(state.runtimeEndpointHost === undefined
      ? {}
      : { runtimeEndpointHost: state.runtimeEndpointHost }),
    ...(state.machineId === undefined ? {} : { machineId: state.machineId }),
    ...(state.requestedRegion === undefined ? {} : { requestedRegion: state.requestedRegion }),
    ...(state.region === undefined ? {} : { region: state.region }),
    ...(state.storagePersistence === undefined
      ? {}
      : { storagePersistence: state.storagePersistence }),
    ...(state.requestedResources === undefined
      ? {}
      : { requestedResources: state.requestedResources }),
    ...(state.resourceSample === undefined ? {} : { resourceSample: state.resourceSample }),
    ...(state.gpu === undefined ? {} : { gpu: state.gpu }),
    ...(state.account === undefined ? {} : { account: state.account }),
    createdAt: state.createdAt,
    ...(state.startedAt === undefined ? {} : { startedAt: state.startedAt }),
    ...(state.lastActivityAt === undefined ? {} : { lastActivityAt: state.lastActivityAt }),
    ...(state.expiresAt === undefined ? {} : { expiresAt: state.expiresAt }),
    observedAt,
    unavailable: Object.freeze([...unavailable].sort()),
  })
}
