import type {
  TangleModelCredentialResolver,
  TangleModelCredentials,
} from '@tangle-network/agent-provider-tangle'
import { ConnectionError } from '../../app/connection-errors.js'
import type { ConnectionRecord } from '../../domain/entities.js'
import { readConnectionCredential } from './production-connection-credentials.js'
import { connectionEndpoint } from './production-connection-endpoints.js'
import type { ProductionConnectionOptions } from './production-connection-types.js'

/**
 * Turn a connection's model-seat reference into the Tangle provider's `modelCredentials` option.
 *
 * A stored seat passes through unchanged. A resolver command becomes a provider resolver that runs
 * only when a subscription profile creates an environment; Braid never spawns it. Values reach the
 * resolver's private process environment and nothing else: the connection key is read from the
 * credential store at that moment, and forwarded variables come from Braid's own environment.
 */
export function tangleModelCredentialsForConnection(
  record: ConnectionRecord,
  options: ProductionConnectionOptions,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): TangleModelCredentials | TangleModelCredentialResolver | undefined {
  const reference = record.providerOptions.modelCredentials
  if (reference === undefined) return undefined
  if ('cliAuth' in reference) return { cliAuth: { ...reference.cliAuth } }
  const command = [...reference.command]
  const forwarded = [...(reference.env ?? [])]
  const { connectionKeyEnv, connectionEndpointEnv } = reference
  return async (input) => {
    const missing = forwarded.filter((name) => !environment[name]?.trim())
    if (missing.length > 0) {
      throw new ConnectionError(
        'CONNECTION_CREDENTIAL_REQUIRED',
        `The model-seat resolver for this connection needs ${missing.join(', ')} set in Braid's environment`,
        { connectionId: record.id },
      )
    }
    const env: Record<string, string> = {}
    for (const name of forwarded) env[name] = environment[name] as string
    if (connectionKeyEnv !== undefined || connectionEndpointEnv !== undefined) {
      const endpoint = connectionEndpoint(record, options)
      if (connectionEndpointEnv !== undefined) env[connectionEndpointEnv] = endpoint
      if (connectionKeyEnv !== undefined) {
        const key = await readConnectionCredential(record, options, endpoint)
        if (!key) {
          throw new ConnectionError(
            'CONNECTION_CREDENTIAL_REQUIRED',
            "The model-seat resolver needs this connection's Tangle credential",
            { connectionId: record.id },
          )
        }
        env[connectionKeyEnv] = key
      }
    }
    const { createCommandModelCredentialResolver } = await import(
      '@tangle-network/agent-provider-tangle/node'
    )
    return createCommandModelCredentialResolver({ command, env })(input)
  }
}
