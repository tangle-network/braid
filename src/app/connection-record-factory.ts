import { createHash } from 'node:crypto'
import type { ConnectionRecord, IsoDateTime } from '../domain/entities.js'
import { createConnectionId, type CredentialRefId } from '../domain/ids.js'
import { ConnectionRegistry } from './connections.js'

export interface ConnectionMetadataInput {
  readonly kind: ConnectionRecord['kind']
  readonly name: string
  readonly endpoint: string
  readonly region?: string
  readonly account?: string
}

export function connectionRecordFromMetadata(input: {
  readonly draft: ConnectionMetadataInput
  readonly operationId: string
  readonly now: IsoDateTime
  readonly credentialRef?: CredentialRefId
}): ConnectionRecord {
  const suffix = createHash('sha256').update(input.operationId).digest('hex').slice(0, 24)
  const record: ConnectionRecord = {
    id: createConnectionId(`connection-${input.draft.kind}-${suffix}`),
    kind: input.draft.kind,
    name: input.draft.name,
    endpoint: input.draft.endpoint,
    ...(input.credentialRef === undefined ? {} : { credentialRef: input.credentialRef }),
    providerOptions: {
      transport: input.draft.endpoint.startsWith('https:') ? 'https' : 'local',
      ...(input.draft.region === undefined ? {} : { region: input.draft.region }),
      ...(input.draft.account === undefined ? {} : { account: input.draft.account }),
    },
    createdAt: input.now,
    updatedAt: input.now,
    lastHealth: { status: 'unknown' },
  }
  return new ConnectionRegistry().upsert(record)
}
