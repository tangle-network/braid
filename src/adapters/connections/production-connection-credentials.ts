import { ConnectionError } from '../../app/connection-errors.js'
import type { ConnectionRecord } from '../../domain/entities.js'
import type { CredentialPort, CredentialRef } from '../../ports/credentials.js'
import { credentialRef } from '../../ports/credentials.js'
import { isLoopbackEndpoint } from './production-connection-endpoints.js'
import type { ProductionConnectionOptions } from './production-connection-types.js'

const BOUND_CREDENTIAL_HEADER = 'braid-credential-v1\n'

/**
 * Stores a secret together with the origin it was issued for. The binding lives
 * in the operating-system credential store, so editing the workspace endpoint
 * cannot redirect the secret to another origin.
 */
export function bindCredentialToOrigin(secret: Uint8Array, endpoint: string): Uint8Array {
  const origin = new URL(endpoint).origin
  const header = new TextEncoder().encode(`${BOUND_CREDENTIAL_HEADER}${origin}\n`)
  const bound = new Uint8Array(header.length + secret.length)
  bound.set(header, 0)
  bound.set(secret, header.length)
  return bound
}

function credentialForOrigin(value: string, record: ConnectionRecord, endpoint: string): string {
  if (value.startsWith(BOUND_CREDENTIAL_HEADER)) {
    const rest = value.slice(BOUND_CREDENTIAL_HEADER.length)
    const newline = rest.indexOf('\n')
    const boundOrigin = newline < 0 ? '' : rest.slice(0, newline)
    const secret = newline < 0 ? '' : rest.slice(newline + 1).trim()
    if (boundOrigin === new URL(endpoint).origin && secret.length > 0) return secret
  }
  throw new ConnectionError(
    'CONNECTION_CREDENTIAL_REAUTH_REQUIRED',
    'The stored credential was not issued for this endpoint origin; run setup to authenticate the new endpoint',
    { connectionId: record.id },
  )
}

export async function readConnectionCredential(
  record: ConnectionRecord,
  options: ProductionConnectionOptions,
  endpoint: string,
): Promise<string | undefined> {
  const required =
    record.kind !== 'cli-bridge' ||
    !isLoopbackEndpoint(endpoint) ||
    record.credentialRef !== undefined
  if (record.credentialRef === undefined) {
    if (required) {
      throw new ConnectionError(
        'CONNECTION_CREDENTIAL_REQUIRED',
        'This connection requires a credential in the operating-system credential store',
        { connectionId: record.id },
      )
    }
    return undefined
  }
  const handle = await resolveConnectionCredentialHandle(record, record.credentialRef, options)
  let bytes: Uint8Array | undefined
  try {
    bytes = handle.read()
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim()
    if (value.length === 0 || value.includes('\u0000')) {
      throw new ConnectionError(
        'CONNECTION_CREDENTIAL_INVALID',
        'The referenced credential in the operating-system credential store is empty or malformed',
        { connectionId: record.id },
      )
    }
    return credentialForOrigin(value, record, endpoint)
  } catch (error) {
    if (error instanceof ConnectionError) throw error
    throw new ConnectionError(
      'CONNECTION_CREDENTIAL_INVALID',
      'The referenced credential in the operating-system credential store is not valid UTF-8 text',
      { connectionId: record.id },
    )
  } finally {
    bytes?.fill(0)
    disposeCredentialHandle(handle)
  }
}

/** Proves that a caller-supplied durable id maps to an existing protected value. */
export async function assertConnectionCredentialReference(
  record: ConnectionRecord,
  options: ProductionConnectionOptions,
): Promise<void> {
  if (record.credentialRef === undefined) return
  const handle = await resolveConnectionCredentialHandle(record, record.credentialRef, options)
  disposeCredentialHandle(handle)
}

async function resolveConnectionCredentialHandle(
  record: ConnectionRecord,
  credentialReference: NonNullable<ConnectionRecord['credentialRef']>,
  options: ProductionConnectionOptions,
): Promise<Awaited<ReturnType<CredentialPort['resolve']>>> {
  if (!options.credentials || !options.credentialRefResolver) {
    throw new ConnectionError(
      'CONNECTION_CREDENTIAL_REF_UNMAPPED',
      'The durable credential reference has no secure credential-store mapping; configure the connection again',
      { connectionId: record.id },
    )
  }
  let portRef: CredentialRef
  try {
    portRef = credentialRef(await options.credentialRefResolver(credentialReference))
  } catch {
    throw new ConnectionError(
      'CONNECTION_CREDENTIAL_REF_UNMAPPED',
      'The durable credential reference could not be mapped',
      { connectionId: record.id },
    )
  }
  try {
    return await options.credentials.resolve(portRef)
  } catch {
    throw new ConnectionError(
      'CONNECTION_CREDENTIAL_UNAVAILABLE',
      'The referenced credential is unavailable from the operating-system credential store; add it there and retry',
      { connectionId: record.id },
    )
  }
}

function disposeCredentialHandle(handle: Awaited<ReturnType<CredentialPort['resolve']>>): void {
  try {
    handle.dispose()
  } catch {
    // A secret handle must not prevent the caller from failing closed.
  }
}
