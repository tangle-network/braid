import {
  type AgentProfile,
  NativeContextBoundaryProofSchema,
} from '@tangle-network/agent-interface'
import {
  canonicalAgentProfileDigestHex,
  snapshotAgentProfile,
} from '../adapters/agent-interface/profile-runtime.js'
import { canonicalDigest } from '../domain/canonical.js'
import type { RunAdmissionReceipt, RunCapabilities } from '../domain/receipts.js'
import type {
  ExecuteTurnInput,
  ExecutionAdmission,
  ExecutionCapabilities,
} from '../ports/execution.js'
import { DEFAULT_RUN_CAPABILITIES, UNKNOWN_RUN_CAPABILITIES } from '../ports/execution.js'
import type { AdmissionPort, ExecutionAccess, StateReader } from './application-ports.js'
import type { SendInput } from './application-types.js'
import { AppError } from './errors.js'
import { branchHasVisibleHistory, resolveNativeContinuationRun } from './run-continuation.js'

export function validateNativeProof(
  context: StateReader & ExecutionAccess,
  input: SendInput &
    Pick<ExecuteTurnInput, 'profile' | 'connectionId'> & {
      readonly sessionSource?: 'caller' | 'continuation'
    },
): void {
  if (!input.nativeContextBoundaryProof) {
    if (input.sessionId !== undefined && input.sessionSource !== 'continuation')
      throw new AppError(
        'NATIVE_CONTINUATION_UNVERIFIED',
        'A caller-supplied provider session requires a valid native context boundary proof',
      )
    return
  }
  const parsed = NativeContextBoundaryProofSchema.safeParse(input.nativeContextBoundaryProof)
  if (!parsed.success)
    throw new AppError(
      'NATIVE_CONTINUATION_UNVERIFIED',
      'The native continuation proof is malformed',
    )
  const proof = parsed.data
  const state = context.currentState()
  const source = resolveNativeContinuationRun({
    state,
    conversationId: input.conversationId ?? state.conversationId,
    branchId: input.branchId ?? state.branchId,
    profile: input.profile,
    ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
  })
  const control = source?.controlRef
  const proofMatchesControl =
    control !== undefined &&
    control.runId === proof.runId &&
    control.provider === proof.provider &&
    control.environmentId === proof.environmentId &&
    control.sessionId === proof.sessionId &&
    control.executionId === proof.executionId &&
    control.requestDigest === proof.requestDigest
  if (
    !source ||
    !proofMatchesControl ||
    !input.sessionId ||
    source.providerSessionId !== proof.sessionId ||
    input.sessionId !== proof.sessionId
  )
    throw new AppError(
      'NATIVE_CONTINUATION_UNVERIFIED',
      'The native continuation proof is not bound to the completed run at this branch tip',
    )
}

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
}

export function validateExecutionContext(
  state: ReturnType<StateReader['currentState']>,
  input: ExecuteTurnInput,
  admission: ExecutionAdmission | undefined,
): void {
  const receipt = admission?.materializationReceipt
  if (receipt?.portableContext !== 'unavailable') return
  if (input.sessionId !== undefined && input.contextBoundary === undefined) return
  const hasHistory = branchHasVisibleHistory({
    state,
    conversationId: state.conversationId,
    branchId: state.branchId,
  })
  if (!hasHistory) return
  throw new AppError(
    'CONTEXT_TRANSFER_UNAVAILABLE',
    'This provider cannot transfer the existing branch history across its current environment; select a supported continuation or start a new branch',
  )
}

export function validateProfile(profile: Readonly<AgentProfile>): void {
  try {
    snapshotAgentProfile(profile)
  } catch (error) {
    throw new AppError(
      'PROFILE_INVALID',
      error instanceof Error ? error.message : 'The selected profile is invalid',
    )
  }
}

export function admissionProfileDigest(profile: Readonly<AgentProfile>): string {
  return canonicalAgentProfileDigestHex(profile)
}

export function validateAdmissionDigests(
  receipt: RunAdmissionReceipt,
  admission: ExecutionAdmission | undefined,
  exactRequestDigest: string,
  exactProfileDigest: string,
): void {
  if (!admission) return
  if (admission.requestDigest !== undefined && admission.requestDigest !== exactRequestDigest)
    throw new AppError(
      'ADMISSION_DIGEST_MISMATCH',
      'Provider request digest did not match admission',
    )
  if (admission.profileDigest !== undefined && admission.profileDigest !== exactProfileDigest)
    throw new AppError(
      'ADMISSION_DIGEST_MISMATCH',
      'Provider profile digest did not match admission',
    )
  if (
    admission.capabilitiesDigest !== undefined &&
    admission.capabilitiesDigest !== receipt.capabilitiesDigest
  )
    throw new AppError(
      'ADMISSION_DIGEST_MISMATCH',
      'Provider capability digest did not match admission',
    )
  if (
    admission.materializationDigest !== undefined &&
    admission.materializationDigest !== receipt.materializationDigest
  )
    throw new AppError(
      'ADMISSION_DIGEST_MISMATCH',
      'Provider materialization digest did not match admission',
    )
}

export function resolveSyncAdmission(
  context: AdmissionPort,
  input: ExecuteTurnInput,
): ExecutionAdmission | undefined {
  const rawAdmission = context.execution.admit?.(input)
  if (isPromiseLike(rawAdmission))
    throw new AppError('ASYNC_ADMISSION_REQUIRED', 'Run admission must be awaited before dispatch')
  return rawAdmission
}

export async function resolveAsyncAdmission(
  context: AdmissionPort,
  input: ExecuteTurnInput,
): Promise<ExecutionAdmission | undefined> {
  return context.execution.admit ? await context.execution.admit(input) : undefined
}

export function resolveSyncCapabilities(
  context: ExecutionAccess,
  input: ExecuteTurnInput,
): RunCapabilities {
  const source = context.execution.capabilities
  const capabilities =
    typeof source === 'function'
      ? source(input)
      : source === undefined
        ? UNKNOWN_RUN_CAPABILITIES
        : capabilitiesFromLegacy(source)
  if (isPromiseLike(capabilities))
    throw new AppError(
      'ASYNC_ADMISSION_REQUIRED',
      'Provider capabilities must be awaited before dispatch',
    )
  if (!capabilities) return UNKNOWN_RUN_CAPABILITIES
  assertRunCapabilities(capabilities)
  return capabilities
}

export async function resolveAsyncCapabilities(
  context: ExecutionAccess,
  input: ExecuteTurnInput,
): Promise<RunCapabilities> {
  const source = context.execution.capabilities
  const capabilities =
    typeof source === 'function'
      ? await source(input)
      : source === undefined
        ? UNKNOWN_RUN_CAPABILITIES
        : capabilitiesFromLegacy(source)
  if (!capabilities) return UNKNOWN_RUN_CAPABILITIES
  assertRunCapabilities(capabilities)
  return capabilities
}

function assertRunCapabilities(value: RunCapabilities): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof value.streaming?.live !== 'boolean' ||
    typeof value.streaming?.replay !== 'boolean' ||
    typeof value.controls?.cancel !== 'boolean' ||
    typeof value.controls?.queue !== 'boolean' ||
    typeof value.events?.sequence !== 'boolean'
  )
    throw new AppError('ADMISSION_UNAVAILABLE', 'Provider capabilities were malformed')
}

function capabilitiesFromLegacy(capabilities: ExecutionCapabilities): RunCapabilities {
  return {
    ...DEFAULT_RUN_CAPABILITIES,
    controls: { ...DEFAULT_RUN_CAPABILITIES.controls, cancel: capabilities.cancel },
  }
}

export function isPromiseLike<T>(value: T | Promise<T> | undefined): value is Promise<T> {
  return Boolean(value && typeof (value as Promise<T>).then === 'function')
}
