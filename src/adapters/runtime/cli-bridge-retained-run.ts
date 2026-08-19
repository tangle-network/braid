import type { AgentExactRunControlRef } from '@tangle-network/agent-interface'
import type { CliBridgeProvider } from '@tangle-network/agent-provider-cli-bridge'
import {
  type RetainedRunHandle,
  reconnectRetainedRun,
  recoverRetainedRun,
  startRetainedRun,
} from '@tangle-network/agent-runtime/kernel'
import { canonicalDigest } from '../../domain/canonical.js'
import { publicMaterializationReceipt } from '../../domain/materialization-receipt.js'
import type { RuntimeEventEnvelope } from '../../domain/runtime-events.js'
import type {
  ExecuteTurnInput,
  RetainedExecutionRecoveryContext,
  RetainedRunAdmissionRecord,
  RetainedRunAdmissionRecorder,
} from '../../ports/execution.js'
import { safeExecutionId, stableProviderId } from './production-backend-common.js'
import type { PreparedCliBridgeConnection } from './production-cli-bridge-backend.js'
import type {
  RetainedExecutionPlan,
  RetainedResultProjection,
} from './retained-execution-contract.js'
import {
  finalRetainedEnvelope,
  isTerminalRetainedStatus,
  modelRequestsFromResult,
  retainedCapabilities,
  retainedStatus,
  retainedTurnUsage,
} from './retained-execution-projection.js'

export interface CliBridgeRetainedPlan extends RetainedExecutionPlan {
  readonly prepared: PreparedCliBridgeConnection
  readonly provider: CliBridgeProvider
  readonly environmentId?: string
  readonly environmentIdempotencyKey: string
  readonly executionId: string
}

type HeadlessRetainedAdmission = Extract<
  RetainedRunAdmissionRecord,
  { readonly phase: 'intent' | 'environment' | 'dispatched' }
>

export async function createCliBridgeRetainedPlan(
  prepared: PreparedCliBridgeConnection,
  runId: string,
  controlRef?: AgentExactRunControlRef,
  recovery?: RetainedExecutionRecoveryContext,
): Promise<CliBridgeRetainedPlan> {
  const provider = prepared.provider
  const admission = headlessRetainedAdmission(recovery?.retainedAdmission)
  if (admission !== undefined && admissionProvider(admission) !== provider.name) {
    throw new Error('retained CLI Bridge admission belongs to another provider')
  }
  const persistedControlRef = admission?.phase === 'dispatched' ? admission.controlRef : undefined
  if (
    controlRef !== undefined &&
    persistedControlRef !== undefined &&
    canonicalDigest(controlRef) !== canonicalDigest(persistedControlRef)
  ) {
    throw new Error('retained CLI Bridge control reference conflicts with the persisted run')
  }
  const exactControlRef = controlRef ?? persistedControlRef
  const environmentId =
    exactControlRef?.environmentId ??
    (admission?.phase === 'environment' ? admission.environmentId : undefined)
  const executionId =
    exactControlRef?.executionId ??
    (admission?.phase === 'intent' || admission?.phase === 'environment'
      ? admission.executionId
      : safeExecutionId(runId))
  const environmentIdempotencyKey =
    admission?.idempotencyKey ?? retainedEnvironmentIdempotencyKey(runId)
  const providerName = provider.name
  const capabilities = retainedCapabilities(await provider.capabilities())
  const materializationReceipt = publicMaterializationReceipt({
    ...prepared.materializationReceipt,
    backend: 'environment-provider',
    ...(environmentId === undefined ? {} : { environmentId }),
    providerRunId: exactControlRef?.runId ?? executionId,
    retainedControl: 'exact-after-dispatch',
  })
  const plan: CliBridgeRetainedPlan = {
    prepared,
    provider,
    ...(environmentId === undefined ? {} : { environmentId }),
    environmentIdempotencyKey,
    executionId,
    providerName,
    providerSessionId:
      exactControlRef?.sessionId ??
      (admission?.phase === 'intent' || admission?.phase === 'environment'
        ? admission.sessionId
        : prepared.providerSessionId),
    model: prepared.route,
    capabilities,
    materializationReceipt,
    start: (input) => startCliBridgeRetainedRun(plan, input),
    reconnect: (controlRef) => reconnectCliBridgeRetainedRun(plan, controlRef),
    recover: (input) => recoverCliBridgeRetainedRun(plan, input),
    discover: (braidRunId, signal) => discoverCliBridgeControlRef(plan, braidRunId, signal),
    observe: () => prepared.observation.snapshot(),
    projectStatus: ({ status, detached }) => retainedStatus(status, detached),
    isTerminalStatus: isTerminalRetainedStatus,
    projectResult: (result): RetainedResultProjection => ({
      text: result.text,
      usage: retainedTurnUsage(result.usage, prepared.route, modelRequestsFromResult(result)),
      ...(result.error === undefined ? {} : { error: result.error }),
    }),
    projectFinal: ({ runId: braidRunId, sequence, result }): RuntimeEventEnvelope =>
      finalRetainedEnvelope(
        braidRunId,
        sequence,
        prepared.route,
        result,
        'Execute the retained CLI Bridge turn',
      ),
  }
  return Object.freeze(plan)
}

export async function startCliBridgeRetainedRun(
  plan: CliBridgeRetainedPlan,
  input: ExecuteTurnInput,
): Promise<RetainedRunHandle> {
  if (input.onRetainedAdmission === undefined) {
    throw new Error('Retained CLI Bridge execution requires a durable admission recorder')
  }
  return startRetainedRun({
    provider: plan.provider,
    environment: {
      profile: plan.prepared.profile,
      backend: plan.prepared.runner,
      workspace: { cwd: plan.prepared.workspace },
      idempotencyKey: plan.environmentIdempotencyKey,
    },
    turn: {
      prompt: input.text,
      turnId: safeExecutionId(input.operationId),
      interactions: input.interactions ?? {},
      signal: input.signal,
    },
    identity: {
      sessionId: plan.prepared.providerSessionId,
      executionId: plan.executionId,
    },
    onAdmission: input.onRetainedAdmission,
  })
}

export async function reconnectCliBridgeRetainedRun(
  plan: CliBridgeRetainedPlan,
  controlRef: AgentExactRunControlRef,
): Promise<RetainedRunHandle | null> {
  return reconnectRetainedRun({ provider: plan.provider, controlRef })
}

async function recoverCliBridgeRetainedRun(
  plan: CliBridgeRetainedPlan,
  input: RetainedExecutionRecoveryContext & {
    readonly admission: RetainedRunAdmissionRecord
    readonly onRetainedAdmission?: RetainedRunAdmissionRecorder
    readonly signal?: AbortSignal
  },
): Promise<RetainedRunHandle | null> {
  const admission = headlessRetainedAdmission(input.admission)
  if (admission === undefined) return null
  if (admission.phase === 'intent') {
    if (input.receipt === undefined || input.onRetainedAdmission === undefined) return null
    const result = await recoverRetainedRun({
      provider: plan.provider,
      admission,
      replay: {
        environment: {
          profile: plan.prepared.profile,
          backend: plan.prepared.runner,
          workspace: { cwd: plan.prepared.workspace },
          idempotencyKey: admission.idempotencyKey,
        },
        turn: {
          prompt: input.receipt.requested.text,
          turnId: admission.turnId,
          interactions: input.receipt.requested.interactions ?? {},
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
        identity: {
          sessionId: admission.sessionId,
          executionId: admission.executionId,
        },
      },
      onAdmission: input.onRetainedAdmission,
    })
    return result.outcome === 'recovered' ? result.handle : null
  }
  if (admission.phase !== 'environment') return null
  const result = await recoverRetainedRun({
    provider: plan.provider,
    environmentId: admission.environmentId,
    sessionId: admission.sessionId,
    executionId: admission.executionId,
  })
  return result.outcome === 'recovered' ? result.handle : null
}

/** Recover the exact server-issued digest after a client crashed during dispatch. */
export async function discoverCliBridgeControlRef(
  plan: CliBridgeRetainedPlan,
  _braidRunId: string,
  signal?: AbortSignal,
): Promise<AgentExactRunControlRef | null> {
  if (plan.environmentId === undefined || plan.providerSessionId === undefined) return null
  return plan.provider.lookupRun({
    runId: plan.executionId,
    environmentId: plan.environmentId,
    sessionId: plan.providerSessionId,
    executionId: plan.executionId,
    ...(signal === undefined ? {} : { signal }),
  })
}

function retainedEnvironmentIdempotencyKey(runId: string): string {
  return stableProviderId('environment-braid-', runId)
}

function headlessRetainedAdmission(
  admission: RetainedRunAdmissionRecord | undefined,
): HeadlessRetainedAdmission | undefined {
  if (
    admission?.phase !== 'intent' &&
    admission?.phase !== 'environment' &&
    admission?.phase !== 'dispatched'
  ) {
    return undefined
  }
  return admission
}

function admissionProvider(admission: HeadlessRetainedAdmission): string {
  return admission.phase === 'dispatched' ? admission.controlRef.provider : admission.provider
}
