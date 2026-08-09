import { ConnectionError } from '../../app/connection-errors.js'
import type { ConnectionRecord } from '../../domain/entities.js'
import type { CredentialPort, CredentialRef } from '../../ports/credentials.js'
import { credentialRef } from '../../ports/credentials.js'
import { isLoopbackEndpoint } from './production-connection-endpoints.js'
import type { ProductionConnectionOptions } from './production-connection-types.js'

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
    return value
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
