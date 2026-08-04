import { stripCliBridgeVersion } from '../adapters/connections/production-connection-endpoints.js'
import { discoverProfiles } from '../app/profiles.js'
import type { ConnectionRecord } from '../domain/entities.js'
import { createConnectionId } from '../domain/ids.js'
import {
  normalizeBridgeEndpoint,
  ProductionBridgeRequestError,
} from './production-bridge-client.js'
import { discoverBridge } from './production-bridge-discovery.js'
import { productionConfigPath, resolveProductionDatabaseKeyFile } from './production-key-path.js'
import { projectSetupProfiles, trustedProfileSources } from './production-profile-projection.js'
import { recoverPendingProductionCredential } from './production-setup-credentials.js'
import type { ProductionStartupSetup } from './production-setup-types.js'
import { ProductionStartupError, type ProductionStartupLoadOptions } from './production-startup.js'

export const DEFAULT_CLI_BRIDGE_ENDPOINT = 'http://127.0.0.1:3344'

function cliBridgeEndpoint(options: ProductionStartupLoadOptions): string {
  return options.cliBridgeEndpoint ?? DEFAULT_CLI_BRIDGE_ENDPOINT
}

function canonicalBridgeEndpoint(options: ProductionStartupLoadOptions): string {
  const configured = cliBridgeEndpoint(options)
  try {
    return stripCliBridgeVersion(normalizeBridgeEndpoint(configured))
  } catch (error) {
    throw new ProductionStartupError(
      'PRODUCTION_CONFIGURATION_INVALID',
      error instanceof ProductionBridgeRequestError
        ? error.message
        : 'The selected CLI Bridge endpoint is invalid; use an HTTP(S) URL without credentials, query, or fragment data',
      error,
    )
  }
}

function setupConnection(
  endpoint: string,
  health: ConnectionRecord['lastHealth'],
): ConnectionRecord {
  const now = new Date().toISOString()
  return {
    id: createConnectionId('connection-local-cli-bridge'),
    kind: 'cli-bridge',
    name: 'Local CLI Bridge',
    endpoint,
    providerOptions: {
      transport: 'local',
      capabilityHints: ['stream', 'usage'],
    },
    createdAt: now,
    updatedAt: now,
    lastHealth: health,
  }
}

/** Composes first-run setup from independently bounded bridge and profile services. */
export async function loadProductionSetup(
  options: ProductionStartupLoadOptions,
): Promise<ProductionStartupSetup> {
  if (!options.workspace) {
    throw new ProductionStartupError(
      'PRODUCTION_CONFIGURATION_REQUIRED',
      'Production startup requires a workspace path',
    )
  }
  const configPath = productionConfigPath(options.workspace, options.configPath)
  if (options.databaseKeyFile !== undefined) {
    resolveProductionDatabaseKeyFile(options.databaseKeyFile, configPath, options.workspace)
  }
  await recoverPendingProductionCredential(configPath, {
    ...(options.credentialStore === undefined ? {} : { credentialStore: options.credentialStore }),
    ...(options.credentialContext === undefined
      ? {}
      : { credentialContext: options.credentialContext }),
  })
  const endpoint = canonicalBridgeEndpoint(options)
  const [bridge, discovered] = await Promise.all([
    discoverBridge(options, endpoint),
    discoverProfiles({
      explicit: trustedProfileSources(options),
      resolverContext: { workspaceRoot: options.workspace },
    }),
  ])
  const profiles = projectSetupProfiles(options, endpoint, bridge.models, discovered)
  return {
    configPath,
    profiles: profiles.profiles,
    connections: [setupConnection(endpoint, bridge.health)],
    diagnostics: [...bridge.diagnostics, ...profiles.diagnostics],
    ...(profiles.initialProfileId === undefined
      ? {}
      : { initialProfileId: profiles.initialProfileId }),
    verification: {
      status: 'unverified',
      detail:
        'Discovery only: /health and /v1/models do not prove that the selected model can authenticate or run.',
    },
  }
}
