import {
  type AgentExactRunControlRef,
  AgentExactRunControlRefSchema,
  type NativeContextBoundaryProof,
  NativeContextBoundaryProofSchema,
  nativeContextContinuationRequestDigest,
  nativeContextContinuationTurnDigest,
} from '@tangle-network/agent-interface'
import type { RetainedRunHandle } from '@tangle-network/agent-runtime/kernel'
import { canonicalDigest } from '../../domain/canonical.js'
import type { ExecuteTurnInput, RetainedExecutionRecoveryContext } from '../../ports/execution.js'
import type { RetainedExecutionPlan } from './retained-execution-contract.js'

export function controlRefFromBoundaryProof(
  value: NativeContextBoundaryProof,
): AgentExactRunControlRef {
  const proof = NativeContextBoundaryProofSchema.parse(value)
  return AgentExactRunControlRefSchema.parse({
    runId: proof.runId,
    provider: proof.provider,
    environmentId: proof.environmentId,
    sessionId: proof.sessionId,
    executionId: proof.executionId,
    requestDigest: proof.requestDigest,
  })
}

export async function continueRetainedNative(
  plan: RetainedExecutionPlan,
  input: ExecuteTurnInput,
): Promise<RetainedRunHandle> {
  const proof = input.nativeContextBoundaryProof
  if (proof === undefined) throw new Error('Native continuation requires an exact boundary proof')
  const sourceControlRef = controlRefFromBoundaryProof(proof)
  if (input.sessionId !== sourceControlRef.sessionId) {
    throw new Error('Native continuation targets another provider session')
  }
  const handle = await plan.reconnect(sourceControlRef, input.signal)
  if (handle === null) throw new Error('Native continuation source is no longer available')
  if (canonicalDigest(handle.controlRef) !== canonicalDigest(sourceControlRef)) {
    throw new Error('Native continuation recovered another provider run')
  }

  const turn = { prompt: input.text, model: plan.model }
  const turnDigest = nativeContextContinuationTurnDigest(turn)
  const material = {
    operationId: input.operationId,
    turnDigest,
    run: sourceControlRef,
    expectedBoundary: NativeContextBoundaryProofSchema.parse(proof),
  }
  const request = {
    ...material,
    requestDigest: nativeContextContinuationRequestDigest(material),
  }
  const outcome = await handle.continueNative(request, { ...turn, signal: input.signal })
  if (
    outcome.acknowledgement.status !== 'accepted' &&
    outcome.acknowledgement.status !== 'replayed'
  ) {
    throw new Error(`Native continuation was ${outcome.acknowledgement.status}`)
  }
  if (!('controlRef' in outcome) || !('result' in outcome)) {
    throw new Error('Native continuation omitted its exact result')
  }
  const next = AgentExactRunControlRefSchema.parse(outcome.controlRef)
  if (
    next.provider !== sourceControlRef.provider ||
    next.environmentId !== sourceControlRef.environmentId ||
    next.sessionId !== sourceControlRef.sessionId
  ) {
    throw new Error('Native continuation moved to another provider session')
  }
  if (canonicalDigest(handle.controlRef) !== canonicalDigest(next)) {
    throw new Error('Native continuation handle did not advance to the admitted run')
  }
  return handle
}

export function nativeContinuationInputFromRecovery(
  runId: string,
  recovery: RetainedExecutionRecoveryContext,
  signal: AbortSignal,
):
  | (ExecuteTurnInput & { readonly nativeContextBoundaryProof: NativeContextBoundaryProof })
  | undefined {
  const receipt = recovery.receipt
  const parsed = NativeContextBoundaryProofSchema.safeParse(receipt?.nativeContextBoundaryProof)
  if (receipt === undefined || !parsed.success) return undefined
  const proof = parsed.data
  return {
    operationId: receipt.operationId,
    runId,
    text: receipt.requested.text,
    profile: receipt.requested.profile,
    ...(receipt.requested.mode === undefined ? {} : { mode: receipt.requested.mode }),
    ...(receipt.requested.interactions === undefined
      ? {}
      : { interactions: receipt.requested.interactions }),
    ...(receipt.requested.connectionId === undefined
      ? {}
      : { connectionId: receipt.requested.connectionId }),
    ...(recovery.workspaceRoot === undefined ? {} : { workspaceRoot: recovery.workspaceRoot }),
    sessionId: proof.sessionId,
    signal,
    nativeContextBoundaryProof: proof,
  }
}
