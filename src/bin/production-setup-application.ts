import { createUnavailableTraceAnalysisAnalyst } from '../adapters/analysis/trace-analysis-adapter.js'
import { createBraidApplication } from '../app/composition.js'
import { createMemoryJournal } from '../app/journal.js'
import type { ProductionCompositionConfig } from '../app/production-composition.js'
import { SystemClock } from '../ports/clock.js'
import { productionActiveProfile } from './production-active-profile.js'
import type { ProductionCredentialContext } from './production-credential-context.js'
import { productionConfigPath } from './production-key-path.js'
import type {
  ProductionStartupLoadOptions,
  ProductionStartupSetup,
} from './production-setup-types.js'

export function createReauthenticationSetup(
  production: ProductionCompositionConfig,
  startupOptions: ProductionStartupLoadOptions,
): ProductionStartupSetup {
  const profile = productionActiveProfile(production.profile)
  const setup: ProductionStartupSetup = {
    configPath: productionConfigPath(startupOptions.workspace, startupOptions.configPath),
    profiles: [profile],
    initialProfileId: profile.id,
    connections: [...production.connections].sort(
      (left, right) =>
        Number(right.id === production.connectionId) - Number(left.id === production.connectionId),
    ),
    diagnostics: [
      'Enter a new credential for the selected connection. Cancel leaves the saved configuration unchanged.',
    ],
    ...(production.workspaceRequest === undefined
      ? {}
      : { workspaceRequest: production.workspaceRequest }),
    verification: {
      status: 'unverified',
      detail: 'The connection is checked after you enter its new credential.',
    },
  }
  return setup
}

export async function openSetupApplication(
  setup: ProductionStartupSetup,
  startupOptions: ProductionStartupLoadOptions,
  credentialContext: ProductionCredentialContext | undefined,
) {
  const journal = createMemoryJournal(new SystemClock())
  const app = createBraidApplication({
    journal,
    effectStorage: journal,
    intelligence: { analyst: createUnavailableTraceAnalysisAnalyst() },
  })
  const releaseContext = credentialContext?.acquire()
  return {
    app,
    close: async () => {
      try {
        await app.close()
      } finally {
        releaseContext?.()
      }
    },
    setup,
    startupOptions,
    profileConnectionOptions: {
      profiles: setup.profiles,
      connections: setup.connections,
      productionConnection: {
        ...(startupOptions.fetch === undefined ? {} : { fetch: startupOptions.fetch }),
        ...(startupOptions.credentialStore === undefined
          ? {}
          : { credentials: startupOptions.credentialStore }),
        ...(startupOptions.credentialRefResolver === undefined
          ? {}
          : { credentialRefResolver: startupOptions.credentialRefResolver }),
      },
    },
  }
}
