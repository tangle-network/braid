import { join, resolve } from 'node:path'
import type { HeadlessKeySource } from '../adapters/credentials/headless-key.js'
import { HeadlessCredentialStore } from '../adapters/credentials/headless-store.js'
import { readNoFollow } from '../adapters/persistence/safe-file.js'
import type { CredentialPort } from '../ports/credentials.js'
import { productionConfigPath, resolveProductionDatabaseKeyFile } from './production-key-path.js'
import { defaultBraidDataDirectory, productionWorkspaceConfigIdentity } from './state-path.js'

const MAX_CONFIG_BYTES = 2 * 1024 * 1024

export interface ProductionCredentialContext {
  readonly store: CredentialPort
  readonly databaseKeyFile: string
  readonly databaseKeySource: HeadlessKeySource
  acquire(): () => void
  dispose(): void
}

interface ProductionCredentialContextOptions {
  readonly workspace: string
  readonly configPath?: string
  readonly databaseKeyFile?: string
  readonly dataDirectory?: string
}

function configuredDatabaseKeyFile(configPath: string): string | undefined {
  const bytes = readNoFollow(configPath, MAX_CONFIG_BYTES)
  if (bytes === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const value = (parsed as { readonly databaseKeyFile?: unknown }).databaseKeyFile
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function credentialDirectory(dataDirectory: string, storeIdentity: string): string {
  return join(dataDirectory, 'credentials', storeIdentity)
}

/** Creates the one key-backed credential store shared by setup, recovery, and reopen. */
export function createProductionCredentialContext(
  options: ProductionCredentialContextOptions,
): ProductionCredentialContext | undefined {
  const configPath = productionConfigPath(options.workspace, options.configPath)
  const configuredKeyFile = options.databaseKeyFile ?? configuredDatabaseKeyFile(configPath)
  if (configuredKeyFile === undefined) return undefined
  const storeIdentity = productionWorkspaceConfigIdentity(options.workspace, configPath)
  const databaseKeyFile = resolveProductionDatabaseKeyFile(
    configuredKeyFile,
    configPath,
    options.workspace,
  )
  const databaseKeySource: HeadlessKeySource = {
    type: 'file',
    path: databaseKeyFile,
    workspaceRoot: resolve(options.workspace),
  }
  const store = new HeadlessCredentialStore({
    root: credentialDirectory(options.dataDirectory ?? defaultBraidDataDirectory(), storeIdentity),
    keySource: databaseKeySource,
    storeIdentity,
  })
  let references = 0
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    store.dispose()
  }
  return {
    store,
    databaseKeyFile,
    databaseKeySource,
    acquire: () => {
      if (disposed) throw new Error('The headless production credential context is closed')
      references += 1
      let released = false
      return () => {
        if (released) return
        released = true
        references -= 1
        if (references === 0) dispose()
      }
    },
    dispose,
  }
}
