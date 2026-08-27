import type { NativeContinuationPort } from './application-ports.js'
import type { SendReceipt } from './application-types.js'
import { AppError } from './errors.js'
import { resolveNativeContinuationRun } from './run-continuation.js'
import { retainedExecutionRecoveryContext } from './run-recovery-context.js'

export async function continueNative(
  context: NativeContinuationPort,
  input: {
    readonly operationId: string
    readonly text: string
    readonly runId?: string
    readonly connectionId?: string
  },
): Promise<SendReceipt> {
  const state = context.currentState()
  const profile = context.profile?.()
  const source =
    profile === undefined
      ? undefined
      : resolveNativeContinuationRun({
          state,
          conversationId: state.conversationId,
          branchId: state.branchId,
          profile,
          ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
        })
  const sessionId = source?.providerSessionId
  if (
    !source ||
    (input.runId !== undefined && source.id !== input.runId) ||
    !sessionId ||
    !source.controlRef ||
    !context.execution.nativeBoundary
  )
    throw new AppError(
      'NATIVE_CONTINUATION_UNVERIFIED',
      'The provider cannot prove a native session boundary for this run',
    )
  const proof = await context.execution.nativeBoundary({
    runId: source.id,
    sessionId,
    controlRef: source.controlRef,
    ...retainedExecutionRecoveryContext(source, context.currentState().workspace),
  })
  if (!proof)
    throw new AppError(
      'NATIVE_CONTINUATION_UNVERIFIED',
      'The provider did not return a native session boundary proof',
    )
  return context.send({
    operationId: input.operationId,
    text: input.text,
    sessionId,
    nativeContextBoundaryProof: proof,
  })
}
