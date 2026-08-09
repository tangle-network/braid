import type { ConnectionRemovalBlocker } from '../domain/connection-removal.js'
import type { ConnectionId } from '../domain/ids.js'

export type ConnectionErrorCode =
  | 'CONNECTION_NOT_FOUND'
  | 'CONNECTION_KIND_MISMATCH'
  | 'CONNECTION_REVISION_MISMATCH'
  | 'INVALID_CONNECTION_SELECTION'
  | 'INVALID_CONNECTION_RECORD'
  | 'SECRET_IN_CONNECTION_RECORD'
  | 'CONNECTION_ENDPOINT_REQUIRED'
  | 'CONNECTION_ENDPOINT_INVALID'
  | 'CONNECTION_ENDPOINT_INSECURE'
  | 'CONNECTION_ENDPOINT_CONFLICT'
  | 'CONNECTION_CREDENTIAL_REQUIRED'
  | 'CONNECTION_CREDENTIAL_REF_UNMAPPED'
  | 'CONNECTION_CREDENTIAL_UNAVAILABLE'
  | 'CONNECTION_CREDENTIAL_INVALID'
  | 'CONNECTION_CREDENTIAL_CHANGE_REQUIRES_SECURE_FLOW'
  | 'CONNECTION_UNSUPPORTED'
  | 'CONNECTION_MODEL_REQUIRED'
  | 'CONNECTION_MODEL_INVALID'
  | 'CONNECTION_MODEL_HARNESS_MISMATCH'
  | 'CONNECTION_WORKSPACE_REQUIRED'
  | 'CONNECTION_FETCH_UNAVAILABLE'
  | 'CONNECTION_REMOVAL_BLOCKED'

export class ConnectionError extends Error {
  readonly code: ConnectionErrorCode
  readonly connectionId?: ConnectionId

  constructor(
    code: ConnectionErrorCode,
    message: string,
    options: { readonly connectionId?: ConnectionId } = {},
  ) {
    super(message)
    this.name = 'ConnectionError'
    this.code = code
    if (options.connectionId !== undefined) this.connectionId = options.connectionId
  }
}

export class ConnectionRemovalError extends ConnectionError {
  readonly blockers: readonly ConnectionRemovalBlocker[]

  constructor(connectionId: ConnectionId, blockers: readonly ConnectionRemovalBlocker[]) {
    super(
      'CONNECTION_REMOVAL_BLOCKED',
      `Connection ${connectionId} cannot be removed: ${blockers
        .map((blocker) => `${blocker.kind} ${blocker.id} — ${blocker.action}`)
        .join('; ')}`,
      { connectionId },
    )
    this.name = 'ConnectionRemovalError'
    this.blockers = Object.freeze(blockers.map((blocker) => Object.freeze({ ...blocker })))
  }
}
