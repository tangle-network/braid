import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ProductionConnectionOptions } from '../adapters/connections/production-connections.js'
import { createOperatingSystemCredentialStore } from '../adapters/credentials/os.js'
import {
  assertNoSymlinkPath,
  assertSafeDirectory,
  readNoFollow,
  removePrivateFile,
  writePrivateFile,
} from '../adapters/persistence/safe-file.js'
import type { BraidApplication } from '../app/application.js'
import type { ConnectionRecord } from '../domain/entities.js'
import type { CredentialPort } from '../ports/credentials.js'
import { credentialRef } from '../ports/credentials.js'
import {
  assertProductionConfigMutationLock,
  type ProductionConfigMutationLock,
  withProductionConfigMutationLock,
} from './production-config-mutation-lock.js'
import {
  MAX_PENDING_REMOVAL_BYTES,
  parsePendingCredentialRemoval,
  pendingCredentialRemovalBytes,
  pendingCredentialRemovalPath,
  savedConfigReferencesPendingCredential,
} from './production-connection-credential-removal-record.js'
import type { ProductionCredentialContext } from './production-credential-context.js'
import {
  defaultProductionCredentialRefResolver,
  type ProductionCredentialMapping,
} from './production-credential-reference.js'

interface CredentialRecoveryOptions {
  readonly credentialStore?: CredentialPort
  readonly credentialContext?: ProductionCredentialContext
  readonly credentialRefResolver?: ProductionConnectionOptions['credentialRefResolver']
}

export interface PreparedConnectionCredentialRemoval {
  readonly commit: (app: BraidApplication) => Promise<void>
  readonly rollback: () => Promise<void>
}

async function removeMarker(path: string, expected: Buffer): Promise<void> {
  const current = readNoFollow(path, MAX_PENDING_REMOVAL_BYTES)
  if (current?.equals(expected)) removePrivateFile(path)
}

async function credentialStore(input: CredentialRecoveryOptions): Promise<CredentialPort> {
  try {
    return (
      input.credentialStore ??
      input.credentialContext?.store ??
      createOperatingSystemCredentialStore()
    )
  } catch (error) {
    throw new Error('Pending connection credential cleanup requires a secure credential store', {
      cause: error,
    })
  }
}

async function recoverPendingRemovalLocked(
  configPath: string,
  options: CredentialRecoveryOptions,
  mutationLock: ProductionConfigMutationLock,
): Promise<void> {
  assertProductionConfigMutationLock(mutationLock, configPath)
  const path = pendingCredentialRemovalPath(configPath)
  const bytes = readNoFollow(path, MAX_PENDING_REMOVAL_BYTES)
  if (bytes === undefined) return
  const marker = parsePendingCredentialRemoval(bytes, path)
  if (
    await savedConfigReferencesPendingCredential(configPath, marker, options.credentialRefResolver)
  ) {
    await removeMarker(path, bytes)
    return
  }
  const store = await credentialStore(options)
  try {
    await store.remove(marker.portRef)
  } catch (error) {
    throw new Error('Pending connection credential cleanup could not be completed', {
      cause: error,
    })
  }
  await removeMarker(path, bytes)
}

/** Completes deletion recorded before connection metadata was removed. */
export async function recoverPendingConnectionCredentialRemoval(
  configPath: string,
  options: CredentialRecoveryOptions = {},
): Promise<void> {
  if (
    readNoFollow(pendingCredentialRemovalPath(configPath), MAX_PENDING_REMOVAL_BYTES) === undefined
  ) {
    return
  }
  await withProductionConfigMutationLock(configPath, (mutationLock) =>
    recoverPendingRemovalLocked(configPath, options, mutationLock),
  )
}

export async function prepareUnsharedConnectionCredentialRemoval(input: {
  readonly operationId: string
  readonly configPath: string
  readonly mutationLock: ProductionConfigMutationLock
  readonly credentialMapping: ProductionCredentialMapping
  readonly record: ConnectionRecord
  readonly remaining: readonly ConnectionRecord[]
  readonly connectionOptions: ProductionConnectionOptions
}): Promise<PreparedConnectionCredentialRemoval> {
  assertProductionConfigMutationLock(input.mutationLock, input.configPath)
  await recoverPendingRemovalLocked(
    input.configPath,
    {
      ...(input.connectionOptions.credentials === undefined
        ? {}
        : { credentialStore: input.connectionOptions.credentials }),
      ...(input.connectionOptions.credentialRefResolver === undefined
        ? {}
        : { credentialRefResolver: input.connectionOptions.credentialRefResolver }),
    },
    input.mutationLock,
  )
  const reference = input.record.credentialRef
  if (
    reference === undefined ||
    input.remaining.some((candidate) => candidate.credentialRef === reference)
  ) {
    return { commit: async () => undefined, rollback: async () => undefined }
  }
  const store = input.connectionOptions.credentials
  const configuredResolver = input.connectionOptions.credentialRefResolver
  const resolver =
    input.credentialMapping === 'default'
      ? defaultProductionCredentialRefResolver
      : configuredResolver
  if (store === undefined || resolver === undefined) {
    throw new Error('The connection credential has no secure store mapping')
  }
  const portRef = credentialRef(await resolver(reference))
  for (const candidate of input.remaining) {
    if (candidate.credentialRef === undefined) continue
    const candidatePortRef = credentialRef(await resolver(candidate.credentialRef))
    if (candidatePortRef === portRef) {
      return { commit: async () => undefined, rollback: async () => undefined }
    }
  }
  const path = pendingCredentialRemovalPath(input.configPath)
  const directory = dirname(path)
  assertNoSymlinkPath(directory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  assertNoSymlinkPath(directory)
  assertSafeDirectory(directory)
  const bytes = pendingCredentialRemovalBytes({
    operationId: input.operationId,
    connectionId: input.record.id,
    credentialId: reference,
    portRef,
    mapping: input.credentialMapping,
  })
  writePrivateFile(path, bytes)
  return {
    commit: async (app) => {
      try {
        await recoverPendingRemovalLocked(
          input.configPath,
          { credentialStore: store, credentialRefResolver: configuredResolver },
          input.mutationLock,
        )
      } catch (error) {
        app.markCleanupUncertain(
          error instanceof Error
            ? `Connection removed; credential cleanup is pending: ${error.message}`
            : 'Connection removed; credential cleanup is pending',
        )
      }
    },
    rollback: async () => {
      assertProductionConfigMutationLock(input.mutationLock, input.configPath)
      await removeMarker(path, bytes)
    },
  }
}

export async function removeUnsharedConnectionCredential(input: {
  readonly app: BraidApplication
  readonly operationId: string
  readonly configPath: string
  readonly mutationLock: ProductionConfigMutationLock
  readonly credentialMapping: ProductionCredentialMapping
  readonly record: ConnectionRecord
  readonly remaining: readonly ConnectionRecord[]
  readonly connectionOptions: ProductionConnectionOptions
}): Promise<void> {
  const prepared = await prepareUnsharedConnectionCredentialRemoval(input)
  await prepared.commit(input.app)
}
