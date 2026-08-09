import { resolve } from 'node:path'
import { canonicalCandidateJson } from '@tangle-network/agent-interface'
import type { ProductionConnectionOptions } from '../adapters/connections/production-connections.js'
import { readNoFollow } from '../adapters/persistence/safe-file.js'
import { createCredentialRefId, parseConnectionId, parseOperationId } from '../domain/ids.js'
import type { CredentialRef } from '../ports/credentials.js'
import { credentialRef } from '../ports/credentials.js'
import {
  defaultProductionCredentialRefResolver,
  type ProductionCredentialMapping,
} from './production-credential-reference.js'

export const MAX_PENDING_REMOVAL_BYTES = 16 * 1024
const MAX_CONFIG_BYTES = 2 * 1024 * 1024

export interface PendingCredentialRemoval {
  readonly format: 'braid-pending-connection-credential-removal'
  readonly schemaVersion: 2
  readonly operationId: string
  readonly connectionId: string
  readonly credentialId: string
  readonly portRef: CredentialRef
  readonly mapping: ProductionCredentialMapping
}

export function pendingCredentialRemovalPath(configPath: string): string {
  return `${resolve(configPath)}.pending-credential-removal`
}

export function parsePendingCredentialRemoval(
  bytes: Buffer,
  path: string,
): PendingCredentialRemoval {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(`The pending credential removal record is not valid JSON: ${path}`, {
      cause: error,
    })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`The pending credential removal record is invalid: ${path}`)
  }
  const candidate = parsed as Record<string, unknown>
  if (
    candidate.format !== 'braid-pending-connection-credential-removal' ||
    candidate.schemaVersion !== 2 ||
    typeof candidate.operationId !== 'string' ||
    typeof candidate.connectionId !== 'string' ||
    typeof candidate.credentialId !== 'string' ||
    typeof candidate.portRef !== 'string' ||
    (candidate.mapping !== 'default' && candidate.mapping !== 'custom')
  ) {
    throw new Error(`The pending credential removal record is incomplete: ${path}`)
  }
  try {
    return {
      format: 'braid-pending-connection-credential-removal',
      schemaVersion: 2,
      operationId: parseOperationId(candidate.operationId),
      connectionId: parseConnectionId(candidate.connectionId),
      credentialId: createCredentialRefId(candidate.credentialId),
      portRef: credentialRef(candidate.portRef),
      mapping: candidate.mapping,
    }
  } catch (error) {
    throw new Error(`The pending credential removal record has invalid references: ${path}`, {
      cause: error,
    })
  }
}

export function pendingCredentialRemovalBytes(input: {
  readonly operationId: string
  readonly connectionId: string
  readonly credentialId: string
  readonly portRef: CredentialRef
  readonly mapping: ProductionCredentialMapping
}): Buffer {
  return Buffer.from(
    `${canonicalCandidateJson({
      format: 'braid-pending-connection-credential-removal',
      schemaVersion: 2,
      operationId: parseOperationId(input.operationId),
      connectionId: parseConnectionId(input.connectionId),
      credentialId: createCredentialRefId(input.credentialId),
      portRef: input.portRef,
      mapping: input.mapping,
    })}\n`,
    'utf8',
  )
}

function configuredCredentialIds(configPath: string): readonly string[] {
  const bytes = readNoFollow(configPath, MAX_CONFIG_BYTES)
  if (bytes === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error('Saved connection configuration is invalid during credential cleanup', {
      cause: error,
    })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Saved connection configuration is invalid during credential cleanup')
  }
  const connections = (parsed as { readonly connections?: unknown }).connections
  if (connections === undefined) return []
  if (!Array.isArray(connections)) {
    throw new Error('Saved connection configuration has an invalid connection catalog')
  }
  return connections.flatMap((record): string[] => {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('Saved connection configuration has an invalid connection record')
    }
    const value = (record as { readonly credentialRef?: unknown }).credentialRef
    if (value === undefined) return []
    if (typeof value !== 'string') {
      throw new Error('Saved connection configuration has an invalid credential reference')
    }
    return [createCredentialRefId(value)]
  })
}

async function markerResolver(
  marker: PendingCredentialRemoval,
  supplied: ProductionConnectionOptions['credentialRefResolver'],
): Promise<NonNullable<ProductionConnectionOptions['credentialRefResolver']>> {
  const resolver = marker.mapping === 'default' ? defaultProductionCredentialRefResolver : supplied
  if (resolver === undefined) {
    throw new Error(
      'Pending credential cleanup requires the custom credential reference resolver that created it',
    )
  }
  let resolved: CredentialRef
  try {
    resolved = credentialRef(await resolver(createCredentialRefId(marker.credentialId)))
  } catch (error) {
    throw new Error('Pending credential cleanup could not resolve its protected reference', {
      cause: error,
    })
  }
  if (resolved !== marker.portRef) {
    throw new Error('Pending credential cleanup has a mismatched protected reference')
  }
  return resolver
}

export async function savedConfigReferencesPendingCredential(
  configPath: string,
  marker: PendingCredentialRemoval,
  suppliedResolver: ProductionConnectionOptions['credentialRefResolver'],
): Promise<boolean> {
  const durableRefs = configuredCredentialIds(configPath)
  if (durableRefs.includes(marker.credentialId)) return true
  const resolver = await markerResolver(marker, suppliedResolver)
  for (const durableRef of durableRefs) {
    const mapped = credentialRef(await resolver(createCredentialRefId(durableRef)))
    if (mapped === marker.portRef) return true
  }
  return false
}
