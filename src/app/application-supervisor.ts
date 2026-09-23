import { canonicalDigest } from '../domain/canonical.js'
import { sanitizeDiagnosticText } from '../analysis/diagnostics.js'
import type {
  CancellationCommand,
  CancellationReceipt,
  RuntimeSupervisorPort,
  SupervisorSnapshot,
} from '../supervisor/runtime-supervisor.js'
import { AppError } from './errors.js'
import { receiptIdForOperation } from './operation-authority.js'
import type { ApplicationReceiptService } from './application-receipts.js'

export interface ApplicationWorkerCancellationReceipt extends CancellationReceipt {
  readonly receiptId: string
  readonly replayed: boolean
}

/** Owns runtime supervisor reads and typed worker cancellation only. */
export class ApplicationSupervisorService {
  readonly #supervisor: RuntimeSupervisorPort | undefined
  readonly #receipts: ApplicationReceiptService

  constructor(options: {
    readonly supervisor: RuntimeSupervisorPort | undefined
    readonly receipts: ApplicationReceiptService
  }) {
    this.#supervisor = options.supervisor
    this.#receipts = options.receipts
  }

  snapshot(supervisorId: string): Promise<SupervisorSnapshot> {
    if (!this.#supervisor)
      throw new AppError('CAPABILITY_UNAVAILABLE', 'Supervisor control is unavailable')
    return this.#supervisor.snapshot(supervisorId)
  }

  async cancelWorker(command: CancellationCommand): Promise<ApplicationWorkerCancellationReceipt> {
    if (
      typeof command.operationId !== 'string' ||
      typeof command.supervisorId !== 'string' ||
      typeof command.runId !== 'string' ||
      typeof command.reason !== 'string' ||
      !command.operationId ||
      !command.supervisorId ||
      !command.runId ||
      !command.reason
    )
      throw new AppError(
        'OPERATION_ID_REQUIRED',
        'Worker cancellation requires operation, supervisor, run, and reason identities',
      )
    if (
      command.operationId.length > 256 ||
      command.supervisorId.length > 256 ||
      command.runId.length > 256 ||
      (command.workerId !== undefined &&
        (typeof command.workerId !== 'string' ||
          command.workerId.length === 0 ||
          Buffer.byteLength(command.workerId, 'utf8') > 256)) ||
      Buffer.byteLength(command.reason, 'utf8') > 1_024
    )
      throw new AppError('INVALID_PARAMS', 'Worker cancellation input exceeds its limits')
    const targetId = `worker:${command.supervisorId}:${command.runId}:${command.workerId ?? 'root'}`
    const safeCommand = {
      ...command,
      reason: sanitizeDiagnosticText(command.reason, 'Cancelled by user'),
    }
    const digest = canonicalDigest({ kind: 'cancel-worker', targetId, command: safeCommand })
    const previous = this.#receipts.read<ApplicationWorkerCancellationReceipt>(
      command.operationId,
      digest,
    )
    if (previous) {
      if (previous.pending) return { ...(await previous.pending), replayed: true }
      const result = this.#receipts.requireResult(
        previous,
        'Cancellation result is not available',
      )
      return { ...result, replayed: true }
    }
    const supervisor = this.#supervisor
    if (!supervisor)
      throw new AppError('CAPABILITY_UNAVAILABLE', 'Supervisor control is unavailable')
    const pending = Promise.resolve()
      .then(() => supervisor.cancel(safeCommand))
      .then((receipt): ApplicationWorkerCancellationReceipt => {
        if (
          receipt.operationId !== command.operationId ||
          receipt.supervisorId !== command.supervisorId ||
          receipt.runId !== command.runId ||
          receipt.workerId !== command.workerId ||
          receipt.status !== 'accepted' ||
          receipt.effect !== 'requested'
        )
          throw new AppError(
            'CAPABILITY_IDENTITY',
            'Supervisor cancellation returned a mismatched identity',
          )
        return {
          operationId: command.operationId,
          supervisorId: command.supervisorId,
          runId: command.runId,
          ...(command.workerId === undefined ? {} : { workerId: command.workerId }),
          status: 'accepted',
          effect: 'requested',
          receiptId: receiptIdForOperation(command.operationId, targetId),
          replayed: false,
        }
      })
    this.#receipts.setPending(command.operationId, digest, pending)
    let result: ApplicationWorkerCancellationReceipt
    try {
      result = await pending
    } catch (error) {
      this.#receipts.deletePending(command.operationId, pending)
      throw error
    }
    this.#receipts.setResult(command.operationId, digest, result)
    this.#receipts.publish(command.operationId, targetId, result)
    return result
  }
}
