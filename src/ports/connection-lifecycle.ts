import type {
  ConnectionRemovalInput,
  ConnectionRemovalResult,
  ConnectionUpsertResult,
} from '../app/connection-action-types.js'
import type { ConnectionMetadataInput } from '../app/connection-record-factory.js'
import type { ConnectionRemovalBlocker } from '../domain/connection-removal.js'

export interface ConnectionCreationInput {
  readonly operationId: string
  readonly draft: ConnectionMetadataInput
  /** Caller-owned bytes. The implementation copies them and never persists them. */
  readonly credential?: Uint8Array
  readonly expectedRevision?: number
}

export interface ConnectionRemovalPreview {
  readonly connectionId: string
  readonly name: string
  readonly blockers: readonly ConnectionRemovalBlocker[]
  readonly credential: 'none' | 'unique' | 'shared'
  readonly sharedCredentialConnectionIds: readonly string[]
}

export interface ConnectionLifecyclePort {
  requiresCredential(draft: ConnectionMetadataInput): boolean
  create(input: ConnectionCreationInput): Promise<ConnectionUpsertResult>
  previewRemoval(connectionId: string): ConnectionRemovalPreview
  remove(input: ConnectionRemovalInput): Promise<ConnectionRemovalResult>
}
