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
  if (!options.credentials || !options.credentialRefResolver) {
    throw new ConnectionError(
      'CONNECTION_CREDENTIAL_REF_UNMAPPED',
      'The durable credential reference has no secure credential-store mapping; configure the connection again',
      { connectionId: record.id },
    )
  }
  let portRef: CredentialRef
  try {
    portRef = credentialRef(await options.credentialRefResolver(record.credentialRef))
  } catch {
    throw new ConnectionError(
      'CONNECTION_CREDENTIAL_REF_UNMAPPED',
      'The durable credential reference could not be mapped',
      { connectionId: record.id },
    )
  }
  let handle: Awaited<ReturnType<CredentialPort['resolve']>>
  try {
    handle = await options.credentials.resolve(portRef)
  } catch {
    throw new ConnectionError(
      'CONNECTION_CREDENTIAL_UNAVAILABLE',
      'The referenced credential is unavailable from the operating-system credential store; add it there and retry',
      { connectionId: record.id },
    )
  }
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
    try {
      handle.dispose()
    } catch {
      // A secret handle must not prevent the caller from failing closed.
    }
  }
}
