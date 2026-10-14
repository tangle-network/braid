import {
  type AgentProfile,
  ContextTransferReceiptSchema,
  ContextTransferRequestSchema,
  canonicalAgentProfileDigest,
  contextTransferResultMatchesRequest,
} from '@tangle-network/agent-interface'
import { canonicalDigest } from '../domain/canonical.js'
import type { BraidState } from '../domain/state.js'
import type { SendInput } from './application-types.js'
import { connectionExecutionDigest } from './connections.js'
import { AppError } from './errors.js'

/** Reuse the journal's accepted canonical transfer for the first turn on its exact branch. */
export function firstTurnHandoffContext(
  state: BraidState,
  input: SendInput,
  branchId: string,
  profile: Readonly<AgentProfile>,
  connectionId: string | undefined,
) {
  if (state.runs.some((run) => run.branchId === branchId)) return undefined
  const operation = state.operations.find(
    (candidate) =>
      candidate.kind === 'conversation-fork' &&
      candidate.result?.kind === 'handoff' &&
      candidate.result.branchId === branchId &&
      (candidate.status === 'pending' || candidate.status === 'acknowledged'),
  )
  if (operation === undefined) return undefined
  const saved = operation.result
  const request = ContextTransferRequestSchema.safeParse(saved?.request)
  const receipt = ContextTransferReceiptSchema.safeParse(saved?.receipt)
  if (
    !request.success ||
    !receipt.success ||
    !contextTransferResultMatchesRequest(request.data, receipt.data) ||
    typeof saved?.connectionId !== 'string' ||
    typeof saved.connectionDigest !== 'string'
  )
    throw new AppError(
      'CONTEXT_HANDOFF_REPLAN_REQUIRED',
      'The retained handoff lacks its exact accepted request or destination; replan the handoff',
    )
  const connection = state.connections.find((record) => record.id === saved.connectionId)
  if (
    connectionId !== saved.connectionId ||
    connection === undefined ||
    connectionExecutionDigest(connection) !== saved.connectionDigest
  )
    throw new AppError(
      'CONTEXT_RECEIPT_CONFLICT',
      'The destination connection changed after the accepted context plan; replan the handoff',
    )
  if (canonicalAgentProfileDigest(profile) !== request.data.plan.destination.profileDigest)
    throw new AppError(
      'CONTEXT_RECEIPT_CONFLICT',
      'The profile changed after the accepted context plan; replan the handoff',
    )
  for (const [supplied, accepted] of [
    [input.portableContextPlan?.digest, request.data.plan.digest],
    [input.portableContextTransferRequest, request.data],
    [input.portableContextTransferReceipt, receipt.data],
    [input.workspaceRequest, request.data.workspace],
    [input.sessionId, receipt.data.sessionId],
    [input.expectedConnectionDigest, saved.connectionDigest],
  ]) {
    if (supplied !== undefined && canonicalDigest(supplied) !== canonicalDigest(accepted ?? null))
      throw new AppError(
        'CONTEXT_RECEIPT_CONFLICT',
        'The first turn conflicts with the retained accepted handoff',
      )
  }
  return {
    request: request.data,
    receipt: receipt.data,
    connectionDigest: saved.connectionDigest,
  }
}
