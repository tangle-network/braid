import type { SandboxClientLike } from '@tangle-network/agent-provider-tangle'
import type { CreateSandboxOptions } from '@tangle-network/sandbox'
import {
  MAX_RETAINED_IDLE_TTL_SECONDS,
  MIN_RETAINED_IDLE_TTL_SECONDS,
} from '../../domain/entities-core.js'
import type { SandboxLifecyclePolicy } from './prepared-execution.js'
import { stableProviderId } from './production-backend-common.js'
import type { ObservableSandboxClient } from './sandbox-observation-types.js'

export { MAX_RETAINED_IDLE_TTL_SECONDS, MIN_RETAINED_IDLE_TTL_SECONDS }

export const BRAID_SANDBOX_OWNER = 'braid' as const

export interface RetainedSandboxIdentity {
  readonly providerSessionId: string
  readonly environmentIdempotencyKey: string
  readonly name: string
  readonly metadata: Readonly<{
    owner: typeof BRAID_SANDBOX_OWNER
    lifecycle: 'retained'
    providerSessionId: string
  }>
}

export function retainedSandboxIdentity(providerSessionId: string): RetainedSandboxIdentity {
  return Object.freeze({
    providerSessionId,
    environmentIdempotencyKey: stableProviderId('env-braid-', providerSessionId),
    name: stableProviderId('braid-', providerSessionId),
    metadata: Object.freeze({
      owner: BRAID_SANDBOX_OWNER,
      lifecycle: 'retained',
      providerSessionId,
    }),
  })
}

export function retainedSandboxLifecycle(idleTtlSeconds: number): SandboxLifecyclePolicy {
  return Object.freeze({
    mode: 'retained',
    cleanup: 'explicit',
    continuity: 'session',
    idleTtlSeconds,
  })
}

/** Apply Braid's bounded lifetime without replacing the Sandbox SDK. */
export function withRetainedSandboxPolicy(
  source: SandboxClientLike,
  idleTtlSeconds: number,
): SandboxClientLike {
  const observable = source as ObservableSandboxClient
  const get = source.get?.bind(source)
  const list = source.list?.bind(source)
  const fetch = source.fetch?.bind(source)
  const listBackends = source.listBackends?.bind(source)
  const getBackend = source.getBackend?.bind(source)
  const describePlacement = source.describePlacement?.bind(source)
  const getIdentity = observable.getIdentity?.bind(source)
  const usage = observable.usage?.bind(source)
  const subscription = observable.subscription?.bind(source)
  return Object.freeze({
    async create(options?: CreateSandboxOptions, requestOptions?: { signal?: AbortSignal }) {
      return source.create(
        { ...options, ephemeral: false, idleTimeoutSeconds: idleTtlSeconds },
        requestOptions,
      )
    },
    ...(get === undefined ? {} : { get }),
    ...(fetch === undefined ? {} : { fetch }),
    // The backend catalog decides which interaction kinds the provider may claim.
    ...(listBackends === undefined ? {} : { listBackends }),
    ...(getBackend === undefined ? {} : { getBackend }),
    ...(list === undefined ? {} : { list }),
    ...(describePlacement === undefined ? {} : { describePlacement }),
    ...(getIdentity === undefined ? {} : { getIdentity }),
    ...(usage === undefined ? {} : { usage }),
    ...(subscription === undefined ? {} : { subscription }),
  })
}
