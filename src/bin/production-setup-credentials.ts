import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { canonicalCandidateJson } from '@tangle-network/agent-interface'
import { isLoopbackEndpoint } from '../adapters/connections/production-connection-endpoints.js'
import { createOperatingSystemCredentialStore } from '../adapters/credentials/os.js'
import {
  assertNoSymlinkPath,
  assertSafeDirectory,
  readNoFollow,
  removePrivateFile,
  writePrivateFile,
} from '../adapters/persistence/safe-file.js'
import type { ConfigurationSelection } from '../app/configuration-session.js'
import type { ConnectionRecord } from '../domain/entities.js'
import { createCredentialRefId } from '../domain/ids.js'
import type { CredentialPort, CredentialRef } from '../ports/credentials.js'
import { credentialRef } from '../ports/credentials.js'
import type { ProductionCredentialContext } from './production-credential-context.js'
import { defaultProductionCredentialRefResolver } from './production-credential-reference.js'
import { resolveProductionDatabaseKeyFile } from './production-key-path.js'
import type { ProductionStartupLoadOptions } from './production-setup-types.js'

const MAX_PENDING_CREDENTIAL_BYTES = 16 * 1024

interface PendingCredentialMarker {
  readonly format: 'braid-pending-connection-credential'
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

export function productionConnectionNeedsCredential(
  options: ProductionStartupLoadOptions,
  connection: ConnectionRecord,
): boolean {
  if (connection.credentialRef !== undefined) return false
  if (connection.kind === 'cli-bridge') {
    return (
      !isLoopbackEndpoint(connection.endpoint ?? connection.providerOptions.endpoint ?? '') &&
      (options.bridgeAuth === undefined || options.bridgeAuth.trim().length === 0)
    )
  }
  return options.tangleAuth === undefined || options.tangleAuth.trim().length === 0
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
  return `${resolve(configPath)}.pending-credential`
}

function parsePendingCredentialMarker(bytes: Buffer, path: string): PendingCredentialMarker {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(`The pending connection credential marker is not valid JSON: ${path}`, {
      cause: error,
    })
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as { readonly format?: unknown }).format !== 'braid-pending-connection-credential' ||
    (parsed as { readonly schemaVersion?: unknown }).schemaVersion !== 1
  ) {
    throw new Error(`The pending connection credential marker has an unsupported format: ${path}`)
  }
  const candidate = parsed as Record<string, unknown>
  if (
    typeof candidate.connectionId !== 'string' ||
    typeof candidate.credentialId !== 'string' ||
    typeof candidate.portRef !== 'string'
  ) {
    throw new Error(`The pending connection credential marker is incomplete: ${path}`)
  }
  let credentialId: ReturnType<typeof createCredentialRefId>
  let portRef: CredentialRef
  try {
    credentialId = createCredentialRefId(candidate.credentialId)
    portRef = credentialRef(candidate.portRef)
  } catch (error) {
    throw new Error(
      `The pending connection credential marker contains invalid references: ${path}`,
      {
        cause: error,
      },
    )
  }
  return {
    format: 'braid-pending-connection-credential',
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
      'An unfinished connection credential write needs recovery, but no secure operating-system credential store is available; unlock or configure it before continuing',
      error,
    )
  }
  try {
    await store.remove(marker.portRef)
  } catch (error) {
    throw credentialStoreError(
      'An unfinished connection credential write could not be removed from the secure operating-system credential store; unlock it and retry',
      error,
    )
  }
  await removePendingMarker(target, bytes)
}

/**
 * Moves one explicit connection token into secure storage before validation.
 * The returned startup options deliberately omit the token and resolve the
 * selected connection through its durable Braid credential id.
 */
export async function prepareProductionSelection(
  options: ProductionStartupLoadOptions,
  selection: ConfigurationSelection,
  configPath: string,
  suppliedCredential?: Uint8Array,
  suppliedCredentialId?: ReturnType<typeof createCredentialRefId>,
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
  const configuredAuth =
    selection.connection.kind === 'cli-bridge'
      ? preparedOptions.bridgeAuth
      : preparedOptions.tangleAuth
  const hasSuppliedCredential = suppliedCredential !== undefined && suppliedCredential.length > 0
  const hasConfiguredAuth = configuredAuth !== undefined && configuredAuth.trim().length > 0
  if (!hasSuppliedCredential && !hasConfiguredAuth) {
    if (productionConnectionNeedsCredential(preparedOptions, selection.connection)) {
      throw new Error(
        `${selection.connection.name} requires a credential; enter it in setup or set ${
          selection.connection.kind === 'cli-bridge' ? 'BRAID_CLI_BRIDGE_AUTH' : 'BRAID_TANGLE_AUTH'
        }`,
      )
    }
    return {
      selection,
      startupOptions: preparedOptions,
      rollback: noCredentialRollback(),
      commit: noCredentialCommit(),
    }
  }
  let store: CredentialPort
  try {
    store =
      preparedOptions.credentialStore ??
      preparedOptions.credentialContext?.store ??
      createOperatingSystemCredentialStore()
  } catch (error) {
    throw credentialStoreError(
      'Connection authentication was supplied, but no secure operating-system credential store is available; unlock or configure the credential store before setup',
      error,
    )
  }
  let available: boolean
  try {
    available = await store.available()
  } catch (error) {
    throw credentialStoreError(
      'Connection authentication was supplied, but the secure operating-system credential store could not be checked; unlock or configure it before setup',
      error,
    )
  }
  if (!available) {
    throw new Error(
      'Connection authentication was supplied, but the secure operating-system credential store is unavailable; unlock or configure it before setup',
    )
  }

  const credentialId =
    suppliedCredentialId ??
    createCredentialRefId(`credential-${selection.connection.kind}-${randomUUID()}`)
  const portRef = credentialRef(`cred:v1:${credentialId}`)
  const pending = await writePendingCredentialMarker(configPath, {
    format: 'braid-pending-connection-credential',
    schemaVersion: 1,
    connectionId: selection.connection.id,
    credentialId,
    portRef,
  })
  const secret = hasSuppliedCredential
    ? Buffer.from(suppliedCredential)
    : Buffer.from(configuredAuth ?? '', 'utf8')
  try {
    try {
      const storedRef = await store.store({
        ref: portRef,
        value: secret,
        label: `Braid ${selection.connection.name} authentication`,
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
        'Connection authentication could not be saved in the secure operating-system credential store; setup was not applied',
        error,
      )
    }
  } finally {
    secret.fill(0)
  }

  const {
    bridgeAuth: ignoredBridgeAuth,
    tangleAuth: ignoredTangleAuth,
    ...optionsWithoutAuth
  } = preparedOptions
  void ignoredBridgeAuth
  void ignoredTangleAuth
  const suppliedResolver = preparedOptions.credentialRefResolver
  const startupOptions: ProductionStartupLoadOptions = {
    ...optionsWithoutAuth,
    credentialStore: store,
    credentialRefResolver: async (ref) => {
      if (ref === credentialId) return portRef
      if (suppliedResolver !== undefined) return suppliedResolver(ref)
      return defaultProductionCredentialRefResolver(ref)
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
