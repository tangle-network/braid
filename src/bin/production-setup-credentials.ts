import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { canonicalCandidateJson } from '@tangle-network/agent-interface'
import { createOperatingSystemCredentialStore } from '../adapters/credentials/os.js'
import {
  assertNoSymlinkPath,
  assertSafeDirectory,
  readNoFollow,
  removePrivateFile,
  writePrivateFile,
} from '../adapters/persistence/safe-file.js'
import type { ConfigurationSelection } from '../app/configuration-session.js'
import { createCredentialRefId } from '../domain/ids.js'
import type { CredentialPort, CredentialRef } from '../ports/credentials.js'
import { credentialRef } from '../ports/credentials.js'
import type { ProductionCredentialContext } from './production-credential-context.js'
import { resolveProductionDatabaseKeyFile } from './production-key-path.js'
import type { ProductionStartupLoadOptions } from './production-setup-types.js'

const MAX_PENDING_CREDENTIAL_BYTES = 16 * 1024

interface PendingCredentialMarker {
  readonly format: 'braid-pending-cli-bridge-credential'
  readonly schemaVersion: 1
  readonly connectionId: string
  readonly credentialId: string
  readonly portRef: CredentialRef
}

interface PendingCredentialMarkerHandle {
  readonly commit: () => Promise<void>
  readonly rollback: () => Promise<void>
}

export interface PreparedProductionSelection {
  readonly selection: ConfigurationSelection
  readonly startupOptions: ProductionStartupLoadOptions
  /** Removes a credential written for a transition that did not commit. */
  readonly rollback: () => Promise<void>
  /** Removes the crash-recovery marker after the new config is active. */
  readonly commit: () => Promise<void>
}

function credentialStoreError(message: string, cause?: unknown): Error {
  return new Error(message, cause === undefined ? undefined : { cause })
}

function noCredentialRollback(): () => Promise<void> {
  return async () => undefined
}

function noCredentialCommit(): () => Promise<void> {
  return async () => undefined
}

function pendingCredentialPath(configPath: string): string {
  return `${resolve(configPath)}.pending-cli-bridge`
}

function parsePendingCredentialMarker(bytes: Buffer, path: string): PendingCredentialMarker {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(`The pending CLI Bridge credential marker is not valid JSON: ${path}`, {
      cause: error,
    })
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as { readonly format?: unknown }).format !== 'braid-pending-cli-bridge-credential' ||
    (parsed as { readonly schemaVersion?: unknown }).schemaVersion !== 1
  ) {
    throw new Error(`The pending CLI Bridge credential marker has an unsupported format: ${path}`)
  }
  const candidate = parsed as Record<string, unknown>
  if (
    typeof candidate.connectionId !== 'string' ||
    typeof candidate.credentialId !== 'string' ||
    typeof candidate.portRef !== 'string'
  ) {
    throw new Error(`The pending CLI Bridge credential marker is incomplete: ${path}`)
  }
  let credentialId: ReturnType<typeof createCredentialRefId>
  let portRef: CredentialRef
  try {
    credentialId = createCredentialRefId(candidate.credentialId)
    portRef = credentialRef(candidate.portRef)
  } catch (error) {
    throw new Error(
      `The pending CLI Bridge credential marker contains invalid references: ${path}`,
      {
        cause: error,
      },
    )
  }
  return {
    format: 'braid-pending-cli-bridge-credential',
    schemaVersion: 1,
    connectionId: candidate.connectionId,
    credentialId,
    portRef,
  }
}

function configContainsCredential(configPath: string, marker: PendingCredentialMarker): boolean {
  const bytes = readNoFollow(configPath, 2 * 1024 * 1024)
  if (bytes === undefined) return false
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    const connections = (parsed as { readonly connections?: unknown }).connections
    if (!Array.isArray(connections)) return false
    return connections.some((record) => {
      if (record === null || typeof record !== 'object' || Array.isArray(record)) return false
      const candidate = record as { readonly id?: unknown; readonly credentialRef?: unknown }
      return candidate.id === marker.connectionId && candidate.credentialRef === marker.credentialId
    })
  } catch {
    return false
  }
}

async function removePendingMarker(path: string, bytes: Buffer): Promise<void> {
  const current = readNoFollow(path, MAX_PENDING_CREDENTIAL_BYTES)
  if (current?.equals(bytes)) removePrivateFile(path)
}

async function writePendingCredentialMarker(
  configPath: string,
  marker: PendingCredentialMarker,
): Promise<PendingCredentialMarkerHandle> {
  const target = pendingCredentialPath(configPath)
  const directory = dirname(target)
  assertNoSymlinkPath(directory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  assertNoSymlinkPath(directory)
  assertSafeDirectory(directory)
  const bytes = Buffer.from(`${canonicalCandidateJson(marker)}\n`, 'utf8')
  writePrivateFile(target, bytes)
  let finished = false
  const cleanup = async (): Promise<void> => {
    if (finished) return
    await removePendingMarker(target, bytes)
    finished = true
  }
  return {
    commit: cleanup,
    rollback: cleanup,
  }
}

/** Reclaims an unfinished credential write without exposing credential data. */
export async function recoverPendingProductionCredential(
  configPath: string,
  options: {
    readonly credentialStore?: CredentialPort
    readonly credentialContext?: ProductionCredentialContext
  } = {},
): Promise<void> {
  const target = pendingCredentialPath(configPath)
  const bytes = readNoFollow(target, MAX_PENDING_CREDENTIAL_BYTES)
  if (bytes === undefined) return
  const marker = parsePendingCredentialMarker(bytes, target)
  if (configContainsCredential(configPath, marker)) {
    await removePendingMarker(target, bytes)
    return
  }
  let store: CredentialPort
  try {
    store =
      options.credentialStore ??
      options.credentialContext?.store ??
      createOperatingSystemCredentialStore()
  } catch (error) {
    throw credentialStoreError(
      'An unfinished CLI Bridge credential write needs recovery, but no secure operating-system credential store is available; unlock or configure it before continuing',
      error,
    )
  }
  try {
    await store.remove(marker.portRef)
  } catch (error) {
    throw credentialStoreError(
      'An unfinished CLI Bridge credential write could not be removed from the secure operating-system credential store; unlock it and retry',
      error,
    )
  }
  await removePendingMarker(target, bytes)
}

/**
 * Moves an explicit Bridge token into secure storage before validation.
 * The returned startup options deliberately omit the token and resolve the
 * selected connection through its durable Braid credential id.
 */
export async function prepareProductionSelection(
  options: ProductionStartupLoadOptions,
  selection: ConfigurationSelection,
  configPath: string,
): Promise<PreparedProductionSelection> {
  await recoverPendingProductionCredential(configPath, {
    ...(options.credentialStore === undefined ? {} : { credentialStore: options.credentialStore }),
    ...(options.credentialContext === undefined
      ? {}
      : { credentialContext: options.credentialContext }),
  })
  const preparedOptions: ProductionStartupLoadOptions =
    options.databaseKeyFile === undefined
      ? options
      : {
          ...options,
          databaseKeyFile: resolveProductionDatabaseKeyFile(
            options.databaseKeyFile,
            configPath,
            options.workspace,
          ),
        }
  const rawAuth = preparedOptions.bridgeAuth
  if (rawAuth === undefined || rawAuth.trim().length === 0) {
    return {
      selection,
      startupOptions: preparedOptions,
      rollback: noCredentialRollback(),
      commit: noCredentialCommit(),
    }
  }
  if (selection.connection.kind !== 'cli-bridge') {
    throw new Error(
      'BRAID_CLI_BRIDGE_AUTH is set, but the selected connection is not a CLI Bridge connection; choose the Bridge connection or remove that setting',
    )
  }

  let store: CredentialPort
  try {
    store =
      preparedOptions.credentialStore ??
      preparedOptions.credentialContext?.store ??
      createOperatingSystemCredentialStore()
  } catch (error) {
    throw credentialStoreError(
      'CLI Bridge authentication was supplied, but no secure operating-system credential store is available; unlock or configure the credential store before setup',
      error,
    )
  }
  let available: boolean
  try {
    available = await store.available()
  } catch (error) {
    throw credentialStoreError(
      'CLI Bridge authentication was supplied, but the secure operating-system credential store could not be checked; unlock or configure it before setup',
      error,
    )
  }
  if (!available) {
    throw new Error(
      'CLI Bridge authentication was supplied, but the secure operating-system credential store is unavailable; unlock or configure it before setup',
    )
  }

  const credentialId = createCredentialRefId(`credential-cli-bridge-${randomUUID()}`)
  const portRef = credentialRef(`cred:v1:${credentialId}`)
  const pending = await writePendingCredentialMarker(configPath, {
    format: 'braid-pending-cli-bridge-credential',
    schemaVersion: 1,
    connectionId: selection.connection.id,
    credentialId,
    portRef,
  })
  const secret = Buffer.from(rawAuth, 'utf8')
  try {
    try {
      const storedRef = await store.store({
        ref: portRef,
        value: secret,
        label: 'Braid CLI Bridge authentication',
      })
      if (storedRef !== portRef) {
        await store.remove(storedRef).catch(() => undefined)
        await store.remove(portRef).catch(() => undefined)
        throw new Error('The secure credential store returned a different credential reference')
      }
    } catch (error) {
      await store.remove(portRef).catch(() => undefined)
      await pending.rollback().catch(() => undefined)
      throw credentialStoreError(
        'CLI Bridge authentication could not be saved in the secure operating-system credential store; setup was not applied',
        error,
      )
    }
  } finally {
    secret.fill(0)
  }

  const { bridgeAuth: ignoredAuth, ...optionsWithoutAuth } = preparedOptions
  void ignoredAuth
  const suppliedResolver = preparedOptions.credentialRefResolver
  const startupOptions: ProductionStartupLoadOptions = {
    ...optionsWithoutAuth,
    credentialStore: store,
    credentialRefResolver: async (ref) => {
      if (ref === credentialId) return portRef
      if (suppliedResolver !== undefined) return suppliedResolver(ref)
      return credentialRef(`cred:v1:${ref}`)
    },
  }
  const preparedSelection: ConfigurationSelection = {
    ...selection,
    connection: {
      ...selection.connection,
      credentialRef: credentialId,
    },
  }
  let rolledBack = false
  return {
    selection: preparedSelection,
    startupOptions,
    rollback: async () => {
      if (rolledBack) return
      await store.remove(portRef)
      await pending.rollback()
      rolledBack = true
    },
    commit: async () => {
      await pending.commit().catch(() => undefined)
    },
  }
}
