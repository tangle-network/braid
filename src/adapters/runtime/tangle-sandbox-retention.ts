import type { SandboxClientLike, SandboxInstanceLike } from '@tangle-network/agent-provider-tangle'
import type { CreateSandboxOptions } from '@tangle-network/sandbox'
import {
  MAX_RETAINED_IDLE_TTL_SECONDS,
  MIN_RETAINED_IDLE_TTL_SECONDS,
} from '../../domain/entities-core.js'
import type { SandboxLifecyclePolicy } from './prepared-execution.js'
import { stableProviderId } from './production-backend-common.js'
import type { ObservableSandboxClient } from './sandbox-observation-types.js'

export { MAX_RETAINED_IDLE_TTL_SECONDS, MIN_RETAINED_IDLE_TTL_SECONDS }

export interface RetainedSandboxIdentity {
  readonly providerSessionId: string
  readonly environmentIdempotencyKey: string
  readonly name: string
  readonly metadata: Readonly<{
    owner: 'braid'
    lifecycle: 'retained'
    providerSessionId: string
  }>
}

export function retainedSandboxIdentity(providerSessionId: string): RetainedSandboxIdentity {
  return Object.freeze({
    providerSessionId,
    environmentIdempotencyKey: stableProviderId('env-braid-', providerSessionId),
    name: stableProviderId('braid-', providerSessionId),
    metadata: Object.freeze({ owner: 'braid', lifecycle: 'retained', providerSessionId }),
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
  const describePlacement = source.describePlacement?.bind(source)
  const getIdentity = observable.getIdentity?.bind(source)
  const usage = observable.usage?.bind(source)
  const subscription = observable.subscription?.bind(source)
  return Object.freeze({
    async create(options?: CreateSandboxOptions, requestOptions?: { signal?: AbortSignal }) {
      const box = await source.create(
        {
          ...options,
          ephemeral: false,
          idleTimeoutSeconds: idleTtlSeconds,
        },
        requestOptions,
      )
      return box
    },
    ...(get === undefined
      ? {}
      : {
          async get(id: string, requestOptions?: { signal?: AbortSignal }) {
            const box = await get(id, requestOptions)
            return box
          },
        }),
    ...(fetch === undefined ? {} : { fetch }),
    ...(list === undefined
      ? {}
      : {
          list: (options?: {
            scope?: string
            limit?: number
            offset?: number
            signal?: AbortSignal
          }) => list(options),
        }),
    ...(describePlacement === undefined
      ? {}
      : { describePlacement: (box: SandboxInstanceLike) => describePlacement(box) }),
    ...(getIdentity === undefined ? {} : { getIdentity }),
    ...(usage === undefined ? {} : { usage }),
    ...(subscription === undefined ? {} : { subscription }),
  })
}
