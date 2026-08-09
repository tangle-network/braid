import { canonicalDigest } from '../../domain/canonical.js'
import {
  isMaterializedStateSnapshot,
  type MaterializedStateSnapshot,
  restoreMaterializedState,
} from '../../domain/materialized-state-snapshot.js'
import { credentialRef } from '../../ports/credentials.js'
import type { JsonValue, StateSnapshot } from '../../ports/storage.js'
import { isJsonValue } from '../../ports/storage.js'
import { StorageError } from './sqlite-errors.js'
import { asNumber, asString } from './sqlite-rows.js'
import type { SnapshotMetadata } from './sqlite-state-snapshot-types.js'

export function validatedSnapshot(value: unknown, scopeId: string): StateSnapshot {
  if (!isMaterializedStateSnapshot(value) || value.scopeId !== scopeId) {
    throw new StorageError(
      'STATE_SNAPSHOT_INVALID',
      'State snapshot is not a valid materialized projection for this storage scope',
    )
  }
  return value
}

export function assertJsonState(state: unknown): JsonValue {
  if (!isJsonValue(state)) {
    throw new StorageError('STATE_SNAPSHOT_INVALID', 'Materialized state is not JSON data')
  }
  return state
}

export function assertSnapshotChecksum(snapshot: StateSnapshot): void {
  if (canonicalDigest(snapshot.state) !== snapshot.stateChecksum) {
    throw new StorageError(
      'STATE_SNAPSHOT_INVALID',
      'Materialized state checksum does not match snapshot metadata',
    )
  }
}

export function metadataFromRow(row: Record<string, unknown>): SnapshotMetadata {
  const snapshotId = asNumber(row.snapshot_id, 'snapshot_id')
  const scopeId = asString(row.scope_id, 'scope_id')
  const generation = asNumber(row.generation, 'generation')
  const storageId = asNumber(row.storage_id, 'storage_id')
  const eventId = asString(row.event_id, 'event_id')
  const sequence = asNumber(row.journal_sequence, 'journal_sequence')
  const revision = asNumber(row.revision, 'revision')
  const stateChecksum = asString(row.state_checksum, 'state_checksum')
  const keyRef = credentialRef(asString(row.key_ref, 'key_ref'))
  if (snapshotId <= 0 || generation <= 0 || storageId <= 0 || sequence <= 0 || revision <= 0) {
    throw new StorageError('STATE_SNAPSHOT_INVALID', 'State snapshot metadata is out of range')
  }
  return {
    snapshotId,
    scopeId,
    generation,
    storageId,
    eventId,
    sequence,
    revision,
    stateChecksum,
    keyRef,
  }
}

export function metadataFromRowSafe(row: Record<string, unknown>): SnapshotMetadata | null {
  try {
    return metadataFromRow(row)
  } catch {
    return null
  }
}

export function materializedSnapshotFromPayload(
  metadata: SnapshotMetadata,
  payload: JsonValue,
): MaterializedStateSnapshot {
  const candidate: unknown = {
    kind: 'braid.materialized-state',
    schemaVersion: 1,
    scopeId: metadata.scopeId,
    generation: metadata.generation,
    eventId: metadata.eventId,
    sequence: metadata.sequence,
    revision: metadata.revision,
    state: payload,
    stateChecksum: metadata.stateChecksum,
  }
  if (!isMaterializedStateSnapshot(candidate)) {
    throw new StorageError('STATE_SNAPSHOT_INVALID', 'Snapshot payload failed validation')
  }
  try {
    restoreMaterializedState(candidate)
  } catch (error) {
    throw new StorageError('STATE_SNAPSHOT_INVALID', 'Snapshot payload failed domain validation', {
      cause: error,
    })
  }
  return candidate
}

export function asPositiveNumber(value: unknown): number | null {
  try {
    const number = asNumber(value, 'snapshot')
    return number > 0 ? number : null
  } catch {
    return null
  }
}

export function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function asCredentialRef(value: unknown) {
  if (typeof value !== 'string') return null
  try {
    return credentialRef(value)
  } catch {
    return null
  }
}
