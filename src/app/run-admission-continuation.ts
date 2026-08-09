import type { NativeContextBoundaryProof } from '../domain/receipts.js'
import type { NativeContinuationPort } from './application-ports.js'
import type { SendReceipt } from './application-types.js'
import { AppError } from './errors.js'

export async function continueNative(
  context: NativeContinuationPort,
  input: { readonly operationId: string; readonly text: string; readonly runId?: string },
): Promise<SendReceipt> {
  const source = context.findRun(input.runId ?? context.currentState().runs.at(-1)?.id ?? '')
  const sessionId = source.providerSessionId
  if (!sessionId || !source.capabilities.sessions.continue || !context.execution.nativeBoundary)
    throw new AppError(
      'NATIVE_CONTINUATION_UNVERIFIED',
      'The provider cannot prove a native session boundary for this run',
    )
  const boundary = await context.execution.nativeBoundary({ runId: source.id, sessionId })
  if (!boundary)
    throw new AppError(
      'NATIVE_CONTINUATION_UNVERIFIED',
      'The provider did not return a native session boundary proof',
    )
  const proof: NativeContextBoundaryProof = {
    runId: source.id,
    providerSessionId: sessionId,
    boundary: boundary.boundary,
    digest: boundary.digest,
    ...(boundary.revision === undefined ? {} : { revision: boundary.revision }),
  }
  if (source.lastCursor !== undefined && proof.boundary !== source.lastCursor)
    throw new AppError(
      'NATIVE_BOUNDARY_MISMATCH',
      'The provider session no longer ends at the recorded Braid boundary',
    )
  return context.send({
    operationId: input.operationId,
    text: input.text,
    sessionId,
    nativeContextBoundaryProof: proof,
  })
}
