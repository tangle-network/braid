export interface ConnectionRunLease {
  readonly connectionId: string
  readonly runId: string
  readonly kind: 'active' | 'detached'
  readonly release: () => void
}

/** In-process authority for runs that still depend on a connection. */
export class ConnectionRunLeaseRegistry {
  readonly #leases = new Map<string, Map<string, 'active' | 'detached'>>()

  claim(
    connectionId: string,
    runId: string,
    kind: 'active' | 'detached' = 'active',
  ): ConnectionRunLease {
    if (
      typeof connectionId !== 'string' ||
      connectionId.length === 0 ||
      connectionId.length > 128 ||
      containsControlCharacters(connectionId) ||
      typeof runId !== 'string' ||
      runId.length === 0 ||
      runId.length > 256 ||
      containsControlCharacters(runId)
    ) {
      throw new Error('A connection run lease needs bounded identifiers')
    }
    if (kind !== 'active' && kind !== 'detached') {
      throw new Error('A connection run lease has an invalid kind')
    }
    const byRun = this.#leases.get(connectionId) ?? new Map<string, 'active' | 'detached'>()
    if (byRun.has(runId)) throw new Error(`Run ${runId} already holds a connection lease`)
    byRun.set(runId, kind)
    this.#leases.set(connectionId, byRun)
    let released = false
    return Object.freeze({
      connectionId,
      runId,
      kind,
      release: () => {
        if (released) return
        released = true
        this.release(connectionId, runId)
      },
    })
  }

  release(connectionId: string, runId: string): void {
    const byRun = this.#leases.get(connectionId)
    if (byRun === undefined) return
    byRun.delete(runId)
    if (byRun.size === 0) this.#leases.delete(connectionId)
  }

  active(connectionId: string): readonly string[] {
    return Object.freeze([...(this.#leases.get(connectionId)?.keys() ?? [])])
  }

  assertAvailable(connectionId: string): void {
    const runs = this.active(connectionId)
    if (runs.length > 0) {
      throw new Error(`Connection ${connectionId} controls active or detached runs`)
    }
  }
}
import { containsControlCharacters } from './redaction.js'
