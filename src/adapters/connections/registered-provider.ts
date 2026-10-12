import type { AgentEnvironmentProvider } from '@tangle-network/agent-interface/environment-provider'
import { ConnectionError } from '../../app/connection-errors.js'
import { connectionExecutionDigest } from '../../app/connections.js'
import type { ConnectionRecord } from '../../domain/entities.js'
import { readConnectionCredential } from './production-connection-credentials.js'
import { connectionEndpoint } from './production-connection-endpoints.js'
import type { ProductionConnectionOptions } from './production-connection-types.js'

/** Resolve an adapter through Runtime's existing registry, scoped to one connection. */
export async function createRegisteredEnvironmentProvider(
  record: ConnectionRecord,
  options: ProductionConnectionOptions,
  signal?: AbortSignal,
): Promise<AgentEnvironmentProvider> {
  const name = record.providerOptions.provider
  if (
    record.kind !== 'agent-provider' ||
    name === undefined
  ) {
    throw new ConnectionError(
      'CONNECTION_UNSUPPORTED',
      'This connection requires a registered provider name',
      { connectionId: record.id },
    )
  }
  signal?.throwIfAborted()
  const endpoint = connectionEndpoint(record, options)
  const credential = await readConnectionCredential(record, options, endpoint)
  signal?.throwIfAborted()
  const factory = options.providerRegistryFactory ?? (await import('./bundled-provider-registry.js')).createBundledConnectionProviderRegistry
  const registry = await factory({
    record,
    endpoint,
    credential,
    ...(signal === undefined ? {} : { signal }),
  })
  signal?.throwIfAborted()
  const provider = registry.get(name)
  if (provider === undefined || provider.name !== name) {
    throw new ConnectionError(
      'CONNECTION_UNSUPPORTED',
      'The selected provider is not registered for this connection',
      { connectionId: record.id },
    )
  }
  return provider
}

/** Keep the exact prepared adapter through preview, transfer, admission, and dispatch. */
export function createConnectionProviderResolver(options: ProductionConnectionOptions) {
  const providers = new Map<string, Promise<AgentEnvironmentProvider>>()
  return (record: ConnectionRecord, signal?: AbortSignal): Promise<AgentEnvironmentProvider> => {
    signal?.throwIfAborted()
    const key = connectionExecutionDigest(record)
    let pending = providers.get(key)
    if (pending === undefined) {
      pending = createRegisteredEnvironmentProvider(record, options, signal)
      providers.set(key, pending)
      void pending.catch(() => {
        if (providers.get(key) === pending) providers.delete(key)
      })
    }
    return pending.then((provider) => {
      signal?.throwIfAborted()
      return provider
    })
  }
}
