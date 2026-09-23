import { toJsonValue } from '../analysis/serialization.js'
import { AppError } from './errors.js'
import {
  ApplicationOperationAuthority,
  type ApplicationOperationEntry,
} from './application-operation-authority.js'

export interface ApplicationReceiptHost {
  readonly commitReceipt: (operationId: string, targetId: string, receipt: unknown) => void
}

/** Owns operation identity, in-flight deduplication, and durable receipt publication. */
export class ApplicationReceiptService extends ApplicationOperationAuthority {
  readonly #host: ApplicationReceiptHost

  constructor(host: ApplicationReceiptHost) {
    super()
    this.#host = host
  }

  publish(operationId: string, targetId: string, receipt: unknown): void {
    this.#host.commitReceipt(operationId, targetId, receipt)
  }

  requireResult<T>(entry: ApplicationOperationEntry<T> | undefined, message: string): T {
    if (!entry?.result) throw new AppError('OPERATION_UNKNOWN', message)
    return entry.result
  }

  publishJson(operationId: string, targetId: string, receipt: unknown): void {
    this.publish(operationId, targetId, toJsonValue(receipt))
  }
}
