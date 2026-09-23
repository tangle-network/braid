import { dirname, resolve } from 'node:path'
import { canonicalJson } from '../domain/canonical.js'
import { parseBoundedProfileJson } from '../profile/profile-json.js'
import {
  type FileIdentity,
  readFileIdentity,
  replaceFileAtomically,
} from '../profile/profile-files.js'
import { withFileLock } from '../persistence/file-lock.js'
import { type ConnectionRecord, validateConnectionRecord } from './connections.js'

const MAX_CONNECTION_FILE_BYTES = 1_048_576
const MAX_CONNECTIONS = 256
export interface ConnectionRecordPersistence {
  load(): Promise<readonly ConnectionRecord[]>
  save(connections: readonly ConnectionRecord[]): Promise<void>
}

export class ConnectionPersistenceConflictError extends Error {
  constructor(path: string) {
    super(`Connection store changed since it was loaded: ${path}`)
    this.name = 'ConnectionPersistenceConflictError'
  }
}

function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('Connection store is not valid UTF-8')
  }
}

function parseConnections(value: unknown): readonly ConnectionRecord[] {
  if (!Array.isArray(value)) throw new Error('Connection store must contain an array')
  if (value.length > MAX_CONNECTIONS) {
    throw new Error(`Connection store contains more than ${MAX_CONNECTIONS} records`)
  }
  const validated = value.map((entry) => validateConnectionRecord(entry as ConnectionRecord))
  const ids = new Set<string>()
  for (const connection of validated) {
    if (ids.has(connection.id)) throw new Error(`Duplicate connection id: ${connection.id}`)
    ids.add(connection.id)
  }
  return Object.freeze(validated)
}

/** Atomic persistence for non-secret connection records and credential references. */
export class JsonConnectionRecordPersistence implements ConnectionRecordPersistence {
  readonly #path: string
  #loaded = false
  #baseline: FileIdentity | undefined

  constructor(path: string) {
    this.#path = resolve(path)
  }

  async load(): Promise<readonly ConnectionRecord[]> {
    const read = await readFileIdentity(this.#path, { maxBytes: MAX_CONNECTION_FILE_BYTES })
    if (read === undefined) {
      this.#baseline = undefined
      this.#loaded = true
      return Object.freeze([])
    }
    const connections = parseConnections(parseBoundedProfileJson(decode(read.bytes)))
    this.#baseline = read.identity
    this.#loaded = true
    return connections
  }

  async save(connections: readonly ConnectionRecord[]): Promise<void> {
    await withFileLock(this.#path, async () => {
      const validated = parseConnections([...connections])
      const current = await readFileIdentity(this.#path, { maxBytes: MAX_CONNECTION_FILE_BYTES })
      if (!this.#loaded) {
        if (current !== undefined) throw new ConnectionPersistenceConflictError(this.#path)
      } else if (!sameIdentity(current?.identity, this.#baseline)) {
        throw new ConnectionPersistenceConflictError(this.#path)
      }
      const bytes = new TextEncoder().encode(`${canonicalJson(validated)}\n`)
      await replaceFileAtomically({
        path: this.#path,
        bytes,
        mode: 0o600,
        expected: current?.identity,
      })
      const written = await readFileIdentity(this.#path, { maxBytes: MAX_CONNECTION_FILE_BYTES })
      if (written === undefined) throw new Error('Connection store vanished after saving')
      this.#baseline = written.identity
      this.#loaded = true
    })
  }
}

function sameIdentity(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.digest === right.digest
  )
}
