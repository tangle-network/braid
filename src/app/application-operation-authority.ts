import { AppError } from './errors.js'

export interface ApplicationOperationEntry<T> {
  readonly digest: string
  readonly result?: T
  readonly pending?: Promise<T>
}

/** One in-process operation table shared by every application-controlled effect. */
export class ApplicationOperationAuthority {
  readonly #entries = new Map<string, ApplicationOperationEntry<unknown>>()

  read<T>(operationId: string, digest: string): ApplicationOperationEntry<T> | undefined {
    const entry = this.#entries.get(operationId)
    if (!entry) return undefined
    if (entry.digest !== digest)
      throw new AppError(
        'OPERATION_CONFLICT',
        'The operation ID is already bound to another request',
      )
    return entry as ApplicationOperationEntry<T>
  }

  result<T>(operationId: string): T | undefined {
    return this.#entries.get(operationId)?.result as T | undefined
  }

  setResult<T>(operationId: string, digest: string, result: T): void {
    this.#entries.set(operationId, { digest, result })
  }

  setPending<T>(operationId: string, digest: string, pending: Promise<T>): void {
    this.#entries.set(operationId, { digest, pending })
  }

  deletePending<T>(operationId: string, pending: Promise<T>): void {
    const entry = this.#entries.get(operationId)
    if (entry?.pending === pending) this.#entries.delete(operationId)
  }
}
