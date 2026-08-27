import type { SandboxClientLike } from '@tangle-network/agent-provider-tangle'
import type { CreateSandboxOptions } from '@tangle-network/sandbox'
import {
  MAX_RETAINED_IDLE_TTL_SECONDS,
  MIN_RETAINED_IDLE_TTL_SECONDS,
} from '../../domain/entities-core.js'
import type { SandboxLifecyclePolicy } from './prepared-execution.js'
import { stableProviderId } from './production-backend-common.js'
import { withSandboxClientOverrides } from './sandbox-client-overrides.js'

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
  const create = async (
    options?: CreateSandboxOptions,
    requestOptions?: { signal?: AbortSignal; timeoutMs?: number },
  ) =>
    source.create(
      {
        ...options,
        ephemeral: false,
        idleTimeoutSeconds: idleTtlSeconds,
      },
      requestOptions,
    )

  return withSandboxClientOverrides(source, { create })
}
