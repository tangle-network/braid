import { redactErrorMessage } from '../connection/redaction.js'
import { completeAdmission, type AdmissionLedger } from './admission-ledger.js'
import type {
  AdmissionResult,
  PreAdmissionReceipt,
  ReceiptStore,
} from './admission-contracts.js'
import { assertPostMatchesPre } from './receipt-store-validation.js'

export class AdmissionRecoveryError extends Error {
  constructor(detail: string) {
    super(`Admission outcome requires recovery: ${redactErrorMessage(detail)}`)
    this.name = 'AdmissionRecoveryError'
  }
}

export async function recoverMaterializedAdmission(input: {
  readonly ledger: AdmissionLedger
  readonly receipts: ReceiptStore
  readonly preAdmission: PreAdmissionReceipt
  readonly operationDigest: string
  readonly now: () => string
}): Promise<AdmissionResult | undefined> {
  const existing = await input.ledger.read(input.preAdmission.identifiers.operationId)
  if (
    existing?.state !== 'in-flight' ||
    existing.operationDigest !== input.operationDigest ||
    input.receipts.findPostMaterialization === undefined
  ) {
    return undefined
  }
  const post = await input.receipts.findPostMaterialization(
    input.preAdmission.receiptDigest,
  )
  if (
    post === undefined ||
    post.preAdmissionDigest !== input.preAdmission.receiptDigest ||
    post.identifiers.operationId !== input.preAdmission.identifiers.operationId
  ) {
    return undefined
  }
  assertPostMatchesPre(input.preAdmission, post)
  try {
    await completeAdmission(input.ledger, {
      operationId: input.preAdmission.identifiers.operationId,
      operationDigest: input.operationDigest,
      startedAt: existing.startedAt,
      completedAt: input.now(),
      receiptDigest: post.receiptDigest,
    })
  } catch (error) {
    throw new AdmissionRecoveryError(
      `the materialization receipt exists but the admission ledger could not be completed: ${redactErrorMessage(error)}`,
    )
  }
  return Object.freeze({ preAdmission: input.preAdmission, postMaterialization: post })
}
