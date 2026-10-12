import { createAgentEnvironmentProviderRegistry } from '@tangle-network/agent-runtime/kernel'
import { ConnectionError } from '../../app/connection-errors.js'
import type { ConnectionProviderRegistryFactory } from './production-connection-types.js'

/** Construct only the selected bundled adapter with explicit connection credentials. */
export const createBundledConnectionProviderRegistry: ConnectionProviderRegistryFactory = async ({ record, endpoint, credential }) => {
  const provider = record.providerOptions.provider
  if (provider === 'e2b') {
    throw new ConnectionError('CONNECTION_UNSUPPORTED', 'The E2B adapter does not yet support an explicit connection endpoint', { connectionId: record.id })
  }
  if (provider !== 'daytona') {
    throw new ConnectionError('CONNECTION_UNSUPPORTED', 'This provider adapter must be registered through the Runtime connection registry factory', { connectionId: record.id })
  }
  if (credential === undefined) {
    throw new ConnectionError('CONNECTION_CREDENTIAL_REQUIRED', 'Daytona requires the selected connection credential', { connectionId: record.id })
  }
  if (record.providerOptions.region === undefined) {
    throw new ConnectionError('CONNECTION_UNSUPPORTED', 'Daytona requires an explicit target region on the selected connection', { connectionId: record.id })
  }
  const { createDaytonaProvider } = await import('@tangle-network/agent-provider-daytona')
  return createAgentEnvironmentProviderRegistry([createDaytonaProvider({
    name: provider,
    config: { apiUrl: endpoint, apiKey: credential, target: record.providerOptions.region },
  })])
}
