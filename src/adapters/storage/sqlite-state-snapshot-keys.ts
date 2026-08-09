import { randomBytes, randomUUID } from 'node:crypto'
import { canonicalDigest } from '../../domain/canonical.js'
import { CredentialError, type CredentialRef, credentialRef } from '../../ports/credentials.js'
import type { StateSnapshot } from '../../ports/storage.js'
import { StorageError } from './sqlite-errors.js'
import { validatedSnapshot } from './sqlite-state-snapshot-codec.js'
import type { PreparedStateSnapshot, SnapshotRuntime } from './sqlite-state-snapshot-types.js'

function snapshotCredentialRef(scopeId: string, generation: number): CredentialRef {
  const safeScope = canonicalDigest(scopeId).slice(0, 24)
  return credentialRef(`cred:v1:snapshot-${safeScope}-${generation}-${randomUUID()}`)
}

export async function prepareSnapshotKey(
  runtime: SnapshotRuntime,
  snapshot: StateSnapshot,
  createdRefs: CredentialRef[],
): Promise<PreparedStateSnapshot> {
  validatedSnapshot(snapshot, runtime.scopeId())
  const keyRef = snapshotCredentialRef(runtime.scopeId(), snapshot.generation)
  const key = randomBytes(32)
  try {
    const storedRef = await runtime.credentials.store({
      ref: keyRef,
      value: key,
      label: 'Braid state snapshot generation key',
    })
    createdRefs.push(storedRef)
    return { key: Buffer.from(key), keyRef: storedRef }
  } finally {
    key.fill(0)
  }
}

export async function removeSnapshotCredentials(
  runtime: SnapshotRuntime,
  refs: readonly CredentialRef[],
): Promise<void> {
  const candidates = [...new Set(refs)]
  if (candidates.length === 0) return
  const referenced = new Set<string>()
  for (let offset = 0; offset < candidates.length; offset += 500) {
    const batch = candidates.slice(offset, offset + 500)
    const placeholders = batch.map(() => '?').join(', ')
    const referencedRows = runtime
      .database()
      .prepare(
        `SELECT key_ref FROM braid_state_snapshots
         WHERE key_ref IN (${placeholders})`,
      )
      .all(...batch) as readonly Record<string, unknown>[]
    for (const row of referencedRows) {
      if (typeof row.key_ref === 'string') referenced.add(row.key_ref)
    }
  }
  for (const ref of candidates) {
    if (referenced.has(ref)) continue
    try {
      await runtime.credentials.remove(ref)
    } catch (error) {
      if (!(error instanceof CredentialError) || error.code !== 'CREDENTIAL_NOT_FOUND') throw error
    }
  }
}

export async function destroySnapshotCredentialsBeforeMutation(
  runtime: SnapshotRuntime,
  refs: readonly CredentialRef[],
): Promise<void> {
  for (const ref of new Set(refs)) {
    try {
      await runtime.credentials.remove(ref)
    } catch (error) {
      if (!(error instanceof CredentialError) || error.code !== 'CREDENTIAL_NOT_FOUND') throw error
    }
  }
}

export async function resolveSnapshotKey(
  runtime: SnapshotRuntime,
  ref: CredentialRef,
): Promise<Buffer> {
  let handle: Awaited<ReturnType<SnapshotRuntime['credentials']['resolve']>> | undefined
  let key: Buffer | undefined
  try {
    handle = await runtime.credentials.resolve(ref)
    key = Buffer.from(handle.read())
    if (key.length !== 32)
      throw new StorageError('STATE_SNAPSHOT_KEY_INVALID', 'Snapshot key is invalid')
    return key
  } catch (error) {
    key?.fill(0)
    throw error
  } finally {
    handle?.dispose()
  }
}
