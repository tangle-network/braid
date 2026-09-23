import { utf8Bytes } from './bounds.js'

const MAX_OPERATION_ID_BYTES = 512

export interface OperationRecord<T = unknown> {
  readonly digest: string
  readonly value: T
}

export class OperationConflictError extends Error {
  constructor() {
    super('Operation was already used with different input')
    this.name = 'OperationConflictError'
  }
}

export class OperationAuthority {
  readonly #records = new Map<string, OperationRecord>()

  get<T>(operationId: string, digest: string): OperationRecord<T> | undefined {
    const existing = this.#records.get(operationId)
    if (!existing) return undefined
    if (existing.digest !== digest) throw new OperationConflictError()
    return existing as OperationRecord<T>
  }

  remember<T>(operationId: string, digest: string, value: T): void {
    assertOperationId(operationId)
    const existing = this.#records.get(operationId)
    if (existing) {
      if (existing.digest !== digest) throw new OperationConflictError()
      return
    }
    this.#records.set(operationId, { digest, value })
  }

  replace<T>(operationId: string, digest: string, value: T): void {
    const existing = this.#records.get(operationId)
    if (!existing || existing.digest !== digest) throw new OperationConflictError()
    this.#records.set(operationId, { digest, value })
  }
}

export function assertOperationId(operationId: string): void {
  if (!operationId) throw new Error('Operation ID is required')
  if (utf8Bytes(operationId) > MAX_OPERATION_ID_BYTES) {
    throw new Error('Operation ID exceeds the UTF-8 byte limit')
  }
}
