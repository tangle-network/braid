import type {
  ContextTransferReceipt,
  NativeContextBoundaryProof,
  PortableContextPlan,
  RunAdmissionReceipt,
} from '../domain/receipts.js'
import { createAdmissionReceipt } from '../domain/receipts.js'
import { requestedInteractionsForRun } from '../domain/run-interactions.js'
import type { ExecuteTurnInput } from '../ports/execution.js'
import { UNKNOWN_RUN_CAPABILITIES } from '../ports/execution.js'
import type { AdmissionPort, AsyncAdmissionPort } from './application-ports.js'
import { exactAdmissionRequestDigest } from './run-admission-request.js'
import {
  admissionProfileDigest,
  resolveAsyncAdmission,
  resolveAsyncCapabilities,
  resolveSyncAdmission,
  resolveSyncCapabilities,
  validateAdmissionDigests,
  validateExecutionContext,
  validateProfile,
} from './run-admission-validation.js'
import type { RunExecutionSnapshot } from './run-execution-snapshot.js'

export function admitRun(
  context: AdmissionPort,
  input: ExecuteTurnInput,
  conversationId: string,
  branchId: string,
  contextTransfer?: ContextTransferReceipt,
  turnId?: string,
  contextPlanDigest?: string,
  nativeContextBoundaryProof?: NativeContextBoundaryProof,
  contextPlan?: PortableContextPlan,
): RunAdmissionReceipt {
  validateProfile(input.profile)
  const rawAdmission = resolveSyncAdmission(context, input)
  const resolved = rawAdmission ?? {}
  validateExecutionContext(context.currentState(), input, resolved, conversationId, branchId)
  const capabilities = resolved.capabilities ?? resolveSyncCapabilities(context, input)
  const interactions = requestedInteractionsForRun(input.mode, capabilities)
  const receipt = createAdmissionReceipt({
    runId: input.runId,
    turnId: turnId ?? context.ids.next('receipt'),
    operationId: input.operationId,
    conversationId,
    branchId,
    admittedAt: context.clock.now(),
    profile: input.profile,
    ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    interactions,
    text: input.text,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    capabilities,
    ...(resolved.provider === undefined ? {} : { provider: resolved.provider }),
    ...(resolved.environmentId === undefined ? {} : { environmentId: resolved.environmentId }),
    ...(resolved.providerSessionId === undefined
      ? {}
      : { providerSessionId: resolved.providerSessionId }),
    ...(resolved.materializationReceipt === undefined
      ? {}
      : { materializationReceipt: resolved.materializationReceipt }),
    ...(contextPlan === undefined ? {} : { contextPlan }),
    ...(contextPlanDigest === undefined ? {} : { contextPlanDigest }),
    ...(contextTransfer === undefined ? {} : { contextTransfer }),
    ...(nativeContextBoundaryProof === undefined ? {} : { nativeContextBoundaryProof }),
  })
  validateAdmissionDigests(
    receipt,
    resolved,
    exactAdmissionRequestDigest(input, conversationId, branchId, contextPlan),
    admissionProfileDigest(input.profile),
  )
  return receipt
}

export async function admitRunAsync(
  context: AsyncAdmissionPort,
  input: ExecuteTurnInput,
  conversationId: string,
  branchId: string,
  contextTransfer?: ContextTransferReceipt,
  turnId?: string,
  contextPlanDigest?: string,
  nativeContextBoundaryProof?: NativeContextBoundaryProof,
  contextPlan?: PortableContextPlan,
): Promise<RunAdmissionReceipt> {
  validateProfile(input.profile)
  const resolved = await resolveAsyncAdmission(context, input)
  validateExecutionContext(context.currentState(), input, resolved, conversationId, branchId)
  const capabilities = resolved?.capabilities ?? (await resolveAsyncCapabilities(context, input))
  const interactions = requestedInteractionsForRun(input.mode, capabilities)
  const receipt = createAdmissionReceipt({
    runId: input.runId,
    turnId: turnId ?? context.ids.next('receipt'),
    operationId: input.operationId,
    conversationId,
    branchId,
    admittedAt: context.clock.now(),
    profile: input.profile,
    ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    interactions,
    text: input.text,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    capabilities,
    ...(resolved?.provider === undefined ? {} : { provider: resolved.provider }),
    ...(resolved?.environmentId === undefined ? {} : { environmentId: resolved.environmentId }),
    ...(resolved?.providerSessionId === undefined
      ? {}
      : { providerSessionId: resolved.providerSessionId }),
    ...(resolved?.materializationReceipt === undefined
      ? {}
      : { materializationReceipt: resolved.materializationReceipt }),
    ...(contextPlan === undefined ? {} : { contextPlan }),
    ...(contextPlanDigest === undefined ? {} : { contextPlanDigest }),
    ...(contextTransfer === undefined ? {} : { contextTransfer }),
    ...(nativeContextBoundaryProof === undefined ? {} : { nativeContextBoundaryProof }),
    ...(resolved?.warnings === undefined ? {} : { warnings: resolved.warnings }),
  })
  validateAdmissionDigests(
    receipt,
    resolved,
    exactAdmissionRequestDigest(input, conversationId, branchId, contextPlan),
    admissionProfileDigest(input.profile),
  )
  return receipt
}

export function pendingAdmissionReceipt(
  input: RunExecutionSnapshot,
  runId: string,
  turnId: string,
): RunAdmissionReceipt {
  return createAdmissionReceipt({
    runId,
    turnId,
    operationId: input.operationId,
    conversationId: input.conversationId,
    branchId: input.branchId,
    admittedAt: new Date(0).toISOString(),
    profile: input.profile,
    ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    interactions: {},
    text: input.text,
    capabilities: UNKNOWN_RUN_CAPABILITIES,
    admissionStatus: 'pending',
  })
}
