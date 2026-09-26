import { DEFAULT_TANGLE_INFERENCE_ENDPOINT } from '../adapters/connections/production-connection-endpoints.js'
import { DEFAULT_TANGLE_SANDBOX_ENDPOINT } from '../adapters/connections/production-connection-types.js'
import { ConnectionError } from '../app/connection-errors.js'
import type { ConnectionKind } from '../domain/entities.js'
import { DEFAULT_CLI_BRIDGE_ENDPOINT } from './production-bridge-client.js'
import type { ProductionStartupLoadOptions } from './production-setup-types.js'

/** Startup secrets belong to a trusted option origin, never a workspace-edited destination. */
export function startupCredentialForEndpoint(
  options: ProductionStartupLoadOptions,
  kind: ConnectionKind,
  endpoint: string,
): string | undefined {
  const secret = kind === 'cli-bridge' ? options.bridgeAuth : options.tangleAuth
  if (secret === undefined || secret.trim().length === 0) return undefined
  const trustedEndpoint =
    kind === 'cli-bridge'
      ? (options.cliBridgeEndpoint ?? DEFAULT_CLI_BRIDGE_ENDPOINT)
      : kind === 'tangle-inference'
        ? DEFAULT_TANGLE_INFERENCE_ENDPOINT
        : DEFAULT_TANGLE_SANDBOX_ENDPOINT
  if (new URL(endpoint).origin !== new URL(trustedEndpoint).origin) {
    throw new ConnectionError(
      'CONNECTION_CREDENTIAL_REAUTH_REQUIRED',
      'The startup credential belongs to another endpoint origin; authenticate this endpoint in setup',
    )
  }
  return secret
}
