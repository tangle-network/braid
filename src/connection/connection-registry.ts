import {
  type ConnectionRecord,
  connectionCredentialReferences,
  connectionIdentityDigest,
  validateConnectionRecord,
} from './connections.js'
import { ConnectionRunLeaseRegistry } from './run-leases.js'

export interface ConnectionUsage {
  readonly activeRuns: readonly string[]
  readonly detachedRuns: readonly string[]
  readonly environments: readonly string[]
  readonly credentialReferences: readonly string[]
}

/** In-process connection state with run and credential binding checks. */
export class ConnectionRegistry {
  readonly #connections = new Map<string, ConnectionRecord>()
  readonly #leases: ConnectionRunLeaseRegistry

  constructor(leases = new ConnectionRunLeaseRegistry()) {
    this.#leases = leases
  }

  runLeases(): ConnectionRunLeaseRegistry {
    return this.#leases
  }

  list(): readonly ConnectionRecord[] {
    return Object.freeze([...this.#connections.values()])
  }

  get(id: string): ConnectionRecord | undefined {
    return this.#connections.get(id)
  }

  save(connection: ConnectionRecord): ConnectionRecord {
    const validated = validateConnectionRecord(connection)
    const existing = this.#connections.get(validated.id)
    if (
      existing !== undefined &&
      connectionIdentityDigest(existing) !== connectionIdentityDigest(validated)
    ) {
      this.#leases.assertAvailable(validated.id)
    }
    this.#connections.set(validated.id, validated)
    return validated
  }

  restore(connections: readonly ConnectionRecord[]): readonly ConnectionRecord[] {
    const validated = connections.map((connection) => validateConnectionRecord(connection))
    const ids = new Set<string>()
    for (const connection of validated) {
      if (ids.has(connection.id)) {
        throw new Error(`Duplicate connection id in restored state: ${connection.id}`)
      }
      ids.add(connection.id)
    }
    for (const [id, existing] of this.#connections.entries()) {
      const replacement = validated.find((connection) => connection.id === id)
      if (replacement === undefined) {
        this.#leases.assertAvailable(id)
      } else if (connectionIdentityDigest(existing) !== connectionIdentityDigest(replacement)) {
        this.#leases.assertAvailable(id)
      }
    }
    this.#connections.clear()
    for (const connection of validated) this.#connections.set(connection.id, connection)
    return Object.freeze(validated)
  }

  credentialReferenceCount(reference: string): number {
    let count = 0
    for (const connection of this.#connections.values()) {
      if (connectionCredentialReferences(connection).includes(reference)) count += 1
    }
    return count
  }

  remove(connectionId: string, usage?: ConnectionUsage): void {
    const connection = this.#connections.get(connectionId)
    if (connection === undefined) throw new Error(`Connection ${connectionId} does not exist`)
    if ((usage?.activeRuns.length ?? 0) > 0 || (usage?.detachedRuns.length ?? 0) > 0) {
      throw new Error(`Connection ${connectionId} has active or detached runs`)
    }
    this.#leases.assertAvailable(connectionId)
    this.#connections.delete(connectionId)
  }
}
