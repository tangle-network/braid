import { AppError } from './errors.js'

interface PendingOperation {
  readonly digest: string
  readonly promise: Promise<unknown>
}

export class ConversationOperationCoordinator {
  readonly #pending = new Map<string, PendingOperation>()

  run<T>(operationId: string, digest: string, action: () => Promise<T>): Promise<T> {
    const current = this.#pending.get(operationId)
    if (current !== undefined) {
      if (current.digest !== digest) {
        throw new AppError(
          'OPERATION_ID_CONFLICT',
          `Operation ${operationId} is already running with different input`,
        )
      }
      return current.promise as Promise<T>
    }
    const promise = Promise.resolve().then(action)
    this.#pending.set(operationId, { digest, promise })
    const cleanup = () => {
      if (this.#pending.get(operationId)?.promise === promise) this.#pending.delete(operationId)
    }
    void promise.then(cleanup, cleanup)
    return promise
  }
}
