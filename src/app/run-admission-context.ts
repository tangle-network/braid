import {
  ContextTransferReceiptSchema,
  ContextTransferRequestSchema,
  contextTransferResultMatchesRequest,
  PortableContextPlanSchema,
} from '@tangle-network/agent-interface'
import { canonicalDigest } from '../domain/canonical.js'
import type { SendInput } from './application-types.js'
import { AppError } from './errors.js'

export function validateContextPlan(input: SendInput): void {
  if (
    input.contextPlan &&
    input.contextPlan.digest !== canonicalDigest({ ...input.contextPlan, digest: undefined })
  )
    throw new AppError('CONTEXT_DIGEST_INVALID', 'The portable context plan digest is invalid')
  if (
    input.contextTransfer &&
    input.contextPlan &&
    input.contextTransfer.planDigest !== input.contextPlan.digest
  )
    throw new AppError(
      'CONTEXT_RECEIPT_CONFLICT',
      'The context transfer receipt does not match the accepted plan',
    )
  const parsedPlan =
    input.portableContextPlan === undefined
      ? undefined
      : PortableContextPlanSchema.safeParse(input.portableContextPlan)
  if (parsedPlan !== undefined && !parsedPlan.success)
    throw new AppError('CONTEXT_DIGEST_INVALID', 'The canonical portable context plan is invalid')
  const parsedRequest =
    input.portableContextTransferRequest === undefined
      ? undefined
      : ContextTransferRequestSchema.safeParse(input.portableContextTransferRequest)
  const parsedReceipt =
    input.portableContextTransferReceipt === undefined
      ? undefined
      : ContextTransferReceiptSchema.safeParse(input.portableContextTransferReceipt)
  if (parsedReceipt !== undefined && !parsedRequest) {
    throw new AppError(
      'CONTEXT_RECEIPT_CONFLICT',
      'A canonical context transfer receipt requires its exact request',
    )
  }
  if (parsedRequest !== undefined && !parsedRequest.success)
    throw new AppError(
      'CONTEXT_RECEIPT_CONFLICT',
      'The canonical context transfer request is invalid',
    )
  if (parsedReceipt !== undefined && !parsedReceipt.success)
    throw new AppError(
      'CONTEXT_RECEIPT_CONFLICT',
      'The canonical context transfer receipt is invalid',
    )
  if (parsedPlan?.success && parsedRequest?.success) {
    if (parsedPlan.data.digest !== parsedRequest.data.plan.digest)
      throw new AppError(
        'CONTEXT_RECEIPT_CONFLICT',
        'The canonical context transfer request names another context plan',
      )
  }
  if (parsedRequest?.success && parsedReceipt?.success) {
    if (!contextTransferResultMatchesRequest(parsedRequest.data, parsedReceipt.data))
      throw new AppError(
        'CONTEXT_RECEIPT_CONFLICT',
        'The canonical context transfer receipt does not match its request',
      )
  }
  if (parsedRequest?.success) {
    const destinationSessionId = parsedRequest.data.plan.destination.sessionId
    if (input.sessionId !== destinationSessionId)
      throw new AppError(
        'CONTEXT_RECEIPT_CONFLICT',
        'The run session does not match the canonical context transfer destination',
      )
  }
  if (parsedReceipt?.success && input.sessionId !== parsedReceipt.data.sessionId)
    throw new AppError(
      'CONTEXT_RECEIPT_CONFLICT',
      'The run session does not match the context transfer receipt destination',
    )
  if (input.contextTransfer !== undefined) {
    const expectedPlanDigest = parsedPlan?.success
      ? parsedPlan.data.digest
      : parsedRequest?.success
        ? parsedRequest.data.plan.digest
        : parsedReceipt?.success
          ? parsedReceipt.data.planDigest
          : undefined
    const expectedSourceRunId = parsedRequest?.success
      ? parsedRequest.data.plan.source.source.runId
      : parsedReceipt?.success
        ? parsedReceipt.data.source.runId
        : undefined
    const expectedDestinationSessionId = parsedReceipt?.success
      ? parsedReceipt.data.sessionId
      : parsedRequest?.success
        ? parsedRequest.data.plan.destination.sessionId
        : undefined
    const expectedAcceptedAt = parsedReceipt?.success ? parsedReceipt.data.admittedAt : undefined
    if (
      (expectedPlanDigest !== undefined &&
        input.contextTransfer.planDigest !== expectedPlanDigest) ||
      (expectedSourceRunId !== undefined &&
        input.contextTransfer.sourceRunId !== expectedSourceRunId) ||
      (expectedDestinationSessionId !== undefined &&
        input.contextTransfer.destinationSessionId !== expectedDestinationSessionId) ||
      (expectedAcceptedAt !== undefined && input.contextTransfer.acceptedAt !== expectedAcceptedAt)
    )
      throw new AppError(
        'CONTEXT_RECEIPT_CONFLICT',
        'The compact context transfer receipt does not match its canonical transfer',
      )
  }
}
