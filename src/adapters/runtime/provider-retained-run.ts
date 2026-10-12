import type {
  AgentExactRunControlRef,
  AgentProfile,
  HarnessType,
  WorkspaceRequest,
} from '@tangle-network/agent-interface'
import type { AgentEnvironmentProvider } from '@tangle-network/agent-interface/environment-provider'
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
import { exactTurnId, safeExecutionId } from './production-backend-common.js'
import type { ConnectionResourceRequest } from '../../domain/entities.js'
import type { ExecutionObservationSource } from './prepared-execution.js'
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

/** Connection-bound facts consumed by the shared retained execution lifecycle. */
export interface PreparedRetainedProviderConnection {
  readonly profile: Readonly<AgentProfile>
  readonly model: string
  readonly runner: HarnessType
  readonly provider: AgentEnvironmentProvider
  readonly capabilities: import('@tangle-network/agent-interface').AgentEnvironmentCapabilities
  readonly observation?: ExecutionObservationSource
  readonly executionId?: string
  readonly environmentId?: string
  readonly providerRunId?: string
  readonly providerSessionId: string
  readonly workspaceRequest?: Readonly<WorkspaceRequest>
  readonly resourceRequest?: ConnectionResourceRequest
  readonly environmentIdempotencyKey: string
  readonly environmentName: string
  readonly environmentMetadata: Readonly<Record<string, unknown>>
  readonly discoverControlRef?: (
    braidRunId: string,
    signal?: AbortSignal,
    executionId?: string,
  ) => Promise<AgentExactRunControlRef | null>
  readonly materializationReceipt: Readonly<Record<string, unknown>>
}

export interface ProviderRetainedPlan extends RetainedExecutionPlan {
  readonly runId: string
  readonly prepared: PreparedRetainedProviderConnection
  readonly provider: AgentEnvironmentProvider
  readonly environmentIdempotencyKey: string
  readonly executionId: string
}

type HeadlessRetainedAdmission = Extract<
  RetainedRunAdmissionRecord,
  { readonly phase: 'intent' | 'environment' | 'dispatched' }
>

export function createProviderRetainedPlan(
  prepared: PreparedRetainedProviderConnection,
  runId: string,
  controlRef?: AgentExactRunControlRef,
  recovery?: RetainedExecutionRecoveryContext,
): ProviderRetainedPlan {
  const provider = prepared.provider
  const admission = headlessRetainedAdmission(recovery?.retainedAdmission)
  if (admission !== undefined && admissionProvider(admission) !== provider.name) {
    throw new Error('Retained provider admission belongs to another provider')
  }
  const persistedControlRef = admission?.phase === 'dispatched' ? admission.controlRef : undefined
  if (
    controlRef !== undefined &&
    persistedControlRef !== undefined &&
    canonicalDigest(controlRef) !== canonicalDigest(persistedControlRef)
  ) {
    throw new Error('Retained provider control reference conflicts with the persisted run')
  }
  const exactControlRef = controlRef ?? persistedControlRef
  const environmentId =
    exactControlRef?.environmentId ??
    (admission?.phase === 'environment' ? admission.environmentId : undefined) ??
    prepared.environmentId
  const executionId =
    exactControlRef?.executionId ??
    (admission?.phase === 'intent' || admission?.phase === 'environment'
      ? admission.executionId
      : (prepared.executionId ?? safeExecutionId(runId)))
  const environmentIdempotencyKey = admission?.idempotencyKey ?? prepared.environmentIdempotencyKey
  const plan: ProviderRetainedPlan = {
    runId,
    prepared,
    provider,
    environmentIdempotencyKey,
    executionId,
    providerName: provider.name,
    ...(environmentId === undefined ? {} : { environmentId }),
    providerSessionId:
      exactControlRef?.sessionId ??
      (admission?.phase === 'intent' || admission?.phase === 'environment'
        ? admission.sessionId
        : prepared.providerSessionId),
    model: prepared.model,
    capabilities: retainedCapabilities(prepared.capabilities, {
      sessionContinuation: prepared.capabilities.sessions.continue,
    }),
    materializationReceipt: publicMaterializationReceipt({
      ...prepared.materializationReceipt,
      providerRunId: exactControlRef?.runId ?? prepared.providerRunId ?? executionId,
      retainedControl: 'exact-after-dispatch',
    }),
    start: (input) => startProviderRetainedRun(plan, input),
    reconnect: (exact) => reconnectRetainedRun({ provider: plan.provider, controlRef: exact }),
    recover: (input) => recoverProviderRetainedRun(plan, input),
    discover: async (braidRunId, signal) => {
      const exact = (await prepared.discoverControlRef?.(braidRunId, signal, executionId)) ?? null
      if (exact === null) return null
      if (exact.executionId !== executionId) {
        throw new Error('Provider retained lookup returned another execution')
      }
      return exact
    },
    observe: () => prepared.observation?.snapshot() ?? Promise.resolve(undefined),
    projectStatus: ({ status, detached }) => retainedStatus(status, detached),
    isTerminalStatus: isTerminalRetainedStatus,
    projectResult: (result): RetainedResultProjection => ({
      text: result.text,
      usage: retainedTurnUsage(result.usage, prepared.model, modelRequestsFromResult(result)),
      ...(result.error === undefined ? {} : { error: result.error }),
    }),
    projectFinal: ({ runId: braidRunId, sequence, result }): RuntimeEventEnvelope =>
      finalRetainedEnvelope(
        braidRunId,
        sequence,
        prepared.model,
        result,
        'Execute the retained provider turn',
      ),
  }
  return Object.freeze(plan)
}

export async function startProviderRetainedRun(
  plan: ProviderRetainedPlan,
  input: ExecuteTurnInput,
): Promise<RetainedRunHandle> {
  if (input.onRetainedAdmission === undefined) {
    throw new Error('Retained provider execution requires a durable admission recorder')
  }
  // A retained create may return an existing environment for the same key.
  // Do not destroy it after an ambiguous dispatch failure without a provider-issued creation receipt.
  const turn = {
    ...(input.contextTransfer === undefined ? {} : { contextTransfer: input.contextTransfer }),
    prompt: input.text,
    turnId: exactTurnId(input),
    interactions: input.interactions ?? {},
    signal: input.signal,
  }
  return startRetainedRun({
    provider: plan.provider,
    ...(input.contextTransferReceipt === undefined
      ? {}
      : { contextTransferReceipt: input.contextTransferReceipt }),
    environment: {
      profile: plan.prepared.profile,
      backend: plan.prepared.runner,
      ...(plan.prepared.workspaceRequest === undefined
        ? {}
        : { workspace: plan.prepared.workspaceRequest }),
      ...(plan.prepared.resourceRequest === undefined
        ? {}
        : { resources: plan.prepared.resourceRequest }),
      name: plan.prepared.environmentName,
      metadata: plan.prepared.environmentMetadata,
      idempotencyKey: plan.environmentIdempotencyKey,
    },
    turn,
    identity: {
      sessionId: plan.providerSessionId ?? plan.prepared.providerSessionId,
      executionId: plan.executionId,
    },
    onAdmission: input.onRetainedAdmission,
  })
}

async function recoverProviderRetainedRun(
  plan: ProviderRetainedPlan,
  input: RetainedExecutionRecoveryContext & {
    readonly admission: RetainedRunAdmissionRecord
    readonly onRetainedAdmission?: RetainedRunAdmissionRecorder
    readonly signal?: AbortSignal
  },
): Promise<RetainedRunHandle | null> {
  const admission = headlessRetainedAdmission(input.admission)
  if (admission === undefined) return null
  if (admissionProvider(admission) !== plan.provider.name) {
    throw new Error('Retained provider admission belongs to another provider')
  }
  if (admission.phase === 'intent') {
    if (input.receipt === undefined || input.onRetainedAdmission === undefined) return null
    const result = await recoverRetainedRun({
      provider: plan.provider,
      admission,
      replay: {
        ...(input.receipt.requested.portableContextTransferReceipt === undefined
          ? {}
          : { contextTransferReceipt: input.receipt.requested.portableContextTransferReceipt }),
        environment: {
          profile: plan.prepared.profile,
          backend: plan.prepared.runner,
          ...(plan.prepared.workspaceRequest === undefined
            ? {}
            : { workspace: plan.prepared.workspaceRequest }),
          ...(plan.prepared.resourceRequest === undefined
            ? {}
            : { resources: plan.prepared.resourceRequest }),
          name: plan.prepared.environmentName,
          metadata: plan.prepared.environmentMetadata,
          idempotencyKey: admission.idempotencyKey,
        },
        turn: {
          ...(input.receipt.requested.portableContextTransferRequest === undefined
            ? {}
            : { contextTransfer: input.receipt.requested.portableContextTransferRequest }),
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
  if (plan.prepared.discoverControlRef === undefined) {
    const recovered = await recoverRetainedRun({
      provider: plan.provider,
      environmentId: admission.environmentId,
      sessionId: admission.sessionId,
      executionId: admission.executionId,
    })
    return recovered.outcome === 'recovered' ? recovered.handle : null
  }
  const controlRef = await plan.prepared.discoverControlRef(
    plan.runId,
    input.signal,
    admission.executionId,
  )
  if (controlRef === null) return null
  if (
    controlRef.provider !== plan.provider.name ||
    controlRef.environmentId !== admission.environmentId ||
    controlRef.sessionId !== admission.sessionId ||
    controlRef.executionId !== admission.executionId
  ) {
    throw new Error('Provider retained lookup returned another admitted run')
  }
  return reconnectRetainedRun({ provider: plan.provider, controlRef })
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
