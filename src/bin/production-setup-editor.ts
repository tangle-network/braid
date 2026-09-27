import { randomUUID } from 'node:crypto'
import { readNoFollow } from '../adapters/persistence/safe-file.js'
import type { BraidApplication } from '../app/application.js'
import { ConnectionRegistry } from '../app/connections.js'
import type { ProductionCompositionConfig } from '../app/production-composition.js'
import { ProfileActionService } from '../app/profile-actions.js'
import type { ProfileRecord } from '../app/profile-types.js'
import { snapshotWorkspaceRequest, type WorkspaceRequest } from '../app/workspace-request.js'
import { isRecoverableRun } from '../domain/state.js'
import type {
  ConfigurationDiscovery,
  TerminalConfigurationOptions,
} from '../views/tui/configuration-wizard-options.js'
import { productionActiveProfile } from './production-active-profile.js'
import {
  activateProductionConnection,
  productionConfigForSelection,
} from './production-application.js'
import { withProductionConfigMutationLock } from './production-config-mutation-lock.js'
import { productionConfigPath } from './production-key-path.js'
import { productionConnectionNeedsCredential } from './production-setup-credentials.js'
import { loadProductionSetup, tangleConnection } from './production-setup-discovery.js'
import {
  persistProductionStartupSelection,
  productionConnectionsForSelection,
} from './production-setup-persistence.js'
import {
  type ProductionApplicationHandle,
  type ProductionApplicationSlot,
  type ProductionSetupController,
  transitionProductionSelection,
} from './production-setup-transition.js'
import type { ProductionStartupSetup } from './production-setup-types.js'
import { describeProductionSelection } from './production-setup-validation.js'
import { loadProductionStartup, type ProductionStartupLoadOptions } from './production-startup.js'

export interface ProductionSetupEditorOptions {
  readonly workspace: string
  readonly startupOptions: ProductionStartupLoadOptions
  readonly setup?: ProductionStartupSetup
  readonly profiles?: readonly ProfileRecord[]
  readonly active: ProductionApplicationSlot
  readonly controller: ProductionSetupController
  readonly currentCatalog: () => ConnectionRegistry
  readonly reauthenticate?: boolean
  readonly onCancel?: () => void
  readonly openApplication: (
    options: ProductionStartupLoadOptions,
    production: ProductionCompositionConfig,
  ) => Promise<ProductionApplicationHandle>
}

/** A setup-only guard. Never detach, cancel, or retarget an admitted run to save settings. */
export function assertProductionSetupIdle(app: BraidApplication): void {
  const state = app.state()
  if (
    state.activeRuns.length > 0 ||
    state.runs.some(isRecoverableRun) ||
    state.operations.some(
      (operation) => operation.kind === 'send' && operation.status === 'pending',
    )
  ) {
    throw new Error(
      'SETUP_RUN_UNSETTLED: Finish or explicitly resolve existing runs before saving setup. No settings or run receipts were changed.',
    )
  }
}

function savedWorkspace(bytes: Buffer): Readonly<WorkspaceRequest> | undefined {
  let document: { readonly workspaceRequest?: WorkspaceRequest }
  try {
    document = JSON.parse(bytes.toString('utf8'))
    if (document === null || typeof document !== 'object' || Array.isArray(document))
      throw new Error('Invalid configuration')
  } catch {
    throw new Error('The saved production configuration could not be read safely')
  }
  return snapshotWorkspaceRequest(document.workspaceRequest)
}

/** Reuses the startup transaction and existing editors; it does not own a persistence path. */
export async function createProductionSetupEditor(
  options: ProductionSetupEditorOptions,
): Promise<TerminalConfigurationOptions> {
  const configPath =
    options.setup?.configPath ??
    productionConfigPath(options.workspace, options.startupOptions.configPath)
  const loaded =
    options.setup === undefined ? await loadProductionStartup(options.startupOptions) : undefined
  const startupOptions: ProductionStartupLoadOptions = {
    ...options.startupOptions,
    ...(loaded?.databaseKeyFile === undefined ? {} : { databaseKeyFile: loaded.databaseKeyFile }),
  }
  let configured = options.setup === undefined
  let requireReplacementCredential = options.reauthenticate === true
  let profiles = options.setup?.profiles ?? options.profiles ?? []
  let workspaceRequest = snapshotWorkspaceRequest(
    options.setup?.workspaceRequest ?? loaded?.workspaceRequest,
  )
  let diagnostics = options.setup?.diagnostics ?? []
  let verification = options.setup?.verification ?? {
    status: 'unverified' as const,
    detail: 'Saved selection only. Saving setup does not execute a task.',
  }
  const now = new Date().toISOString()
  const defaults = [
    tangleConnection('tangle-inference', now),
    tangleConnection('tangle-sandbox', now),
  ]
  let openedBytes: Buffer | undefined

  const current = (): ConfigurationDiscovery => {
    openedBytes = readNoFollow(configPath, 2 * 1024 * 1024)
    if (!configured && options.setup !== undefined) {
      return { ...options.setup, profiles, diagnostics }
    }
    if (openedBytes !== undefined) workspaceRequest = savedWorkspace(openedBytes)
    const app = options.active.current.app
    const activeProfile = productionActiveProfile(app.runtimeSelection.profile())
    const seen = new Set([activeProfile.digest])
    const catalog = options.currentCatalog()
    const choices = new ConnectionRegistry(defaults)
    for (const connection of catalog.list()) choices.upsert(connection)
    const connectionId = app.runtimeSelection.connectionId()
    const selectedConnection = connectionId === undefined ? undefined : catalog.get(connectionId)
    return {
      profiles: [
        activeProfile,
        ...profiles.filter((profile) => {
          if (seen.has(profile.digest)) return false
          seen.add(profile.digest)
          return true
        }),
      ],
      connections: choices.list(),
      initialProfileId: activeProfile.id,
      ...(selectedConnection === undefined ? {} : { initialConnectionId: selectedConnection.id }),
      ...(workspaceRequest === undefined ? {} : { workspaceRequest }),
      diagnostics,
    }
  }

  return {
    ...current(),
    current,
    openOnStart: options.setup !== undefined,
    ...(options.onCancel === undefined ? {} : { onCancel: options.onCancel }),
    requiresCredential: (connection) =>
      (requireReplacementCredential && connection.credentialRef !== undefined) ||
      productionConnectionNeedsCredential(startupOptions, connection),
    confirmation: (selection) =>
      describeProductionSelection(selection, options.workspace, verification),
    ...(options.reauthenticate
      ? {}
      : {
          onReload: async () => {
            const discovered = await loadProductionSetup(startupOptions)
            profiles = discovered.profiles
            diagnostics = discovered.diagnostics
            return current()
          },
        }),
    onCommit: async (selection, credential) => {
      await withProductionConfigMutationLock(configPath, async (mutationLock) => {
        const previous = options.active.current
        await previous.app.whenDurable()
        assertProductionSetupIdle(previous.app)
        const revision = previous.app.state().revision
        const assertUnchanged = () => {
          assertProductionSetupIdle(previous.app)
          if (options.active.current !== previous || previous.app.state().revision !== revision)
            throw new Error(
              'The application changed while setup was open. Reopen setup before saving.',
            )
        }
        const bytes = readNoFollow(configPath, 2 * 1024 * 1024)
        if (openedBytes === undefined ? bytes !== undefined : !bytes?.equals(openedBytes))
          throw new Error('The saved configuration changed. Reopen setup before saving.')
        const connections = productionConnectionsForSelection(
          selection,
          options.currentCatalog().list(),
        )
        const setup: ProductionStartupSetup = {
          configPath,
          profiles,
          connections,
          diagnostics,
          verification,
          ...(workspaceRequest === undefined ? {} : { workspaceRequest }),
        }
        verification = await transitionProductionSelection({
          setup,
          startupOptions,
          selection,
          workspace: options.workspace,
          ...(credential === undefined ? {} : { credential }),
          active: options.active,
          controller: options.controller,
          // Initial CLI setup retains its existing bounded authentication probe.
          // Editing a saved selection never submits that probe or a user task.
          ...(configured
            ? {
                validate: async () => ({
                  status: 'unverified' as const,
                  detail:
                    'Selection saved without execution; capabilities are checked when a task is submitted.',
                }),
              }
            : {}),
          openApplication: async (prepared, selectedOptions) => {
            assertUnchanged()
            return options.openApplication(
              selectedOptions,
              productionConfigForSelection(prepared, selectedOptions, connections),
            )
          },
          persist: async (path, prepared, persistenceOptions) => {
            assertUnchanged()
            return persistProductionStartupSelection(path, prepared, {
              ...persistenceOptions,
              mutationLock,
            })
          },
          activate: async (next, prepared) => {
            assertUnchanged()
            if (configured) {
              await new ProfileActionService({
                host: {
                  state: () => next.app.state(),
                  configuration: next.app.configuration,
                  runtime: next.app.runtimeSelection,
                },
                profiles: [prepared.profile],
              }).select({
                operationId: `operation-setup-profile-${randomUUID()}`,
                ref: prepared.profile.id,
              })
            }
            await activateProductionConnection(
              next.app,
              prepared.connection.id,
              productionConnectionsForSelection(prepared, connections),
            )
          },
        })
        configured = true
        requireReplacementCredential = false
        workspaceRequest = snapshotWorkspaceRequest(selection.workspaceRequest)
        openedBytes = readNoFollow(configPath, 2 * 1024 * 1024)
      })
    },
  }
}
