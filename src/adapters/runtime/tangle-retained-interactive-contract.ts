import type { AgentExactRunControlRef } from '@tangle-network/agent-interface'
import type {
  RetainedInteractiveAdmission,
  RetainedInteractiveAdmissionHook,
  RetainedInteractiveStartedAdmission,
} from '@tangle-network/agent-runtime/kernel'
import { workspaceRequestDigest } from '../../app/workspace-request.js'
import { canonicalDigest } from '../../domain/canonical.js'
import { publicMaterializationReceipt } from '../../domain/materialization-receipt.js'
import type { RunAdmissionReceipt } from '../../domain/receipts.js'
import type { RetainedRunAdmissionRecord } from '../../domain/run-contracts.js'
import type {
  ExecutionPort,
  RetainedRunAdmissionRecorder,
  RunCapabilities,
} from '../../ports/execution.js'
import { stableProviderId } from './production-backend-common.js'
import type { PreparedTangleRetainedConnection } from './production-tangle-sandbox-backend.js'

type StatusInput = Parameters<NonNullable<ExecutionPort['status']>>[0]
type ReconnectInput = Parameters<NonNullable<ExecutionPort['reconnect']>>[0]

export type TangleInteractiveRecoveryInput = StatusInput &
  Partial<Pick<ReconnectInput, 'after' | 'afterSequence' | 'onRetainedAdmission'>>

export function assertInteractiveProvider(prepared: PreparedTangleRetainedConnection): void {
  const interactive = prepared.capabilities.interactiveAgent
  if (
    interactive?.start !== true ||
    interactive.control !== true ||
    interactive.status !== true ||
    interactive.attach !== true ||
    interactive.reattach !== true ||
    interactive.sendPrompt !== true ||
    interactive.input !== true ||
    interactive.resize !== true ||
    interactive.stop !== true
  ) {
    throw new Error('Tangle retained connection does not support exact interactive agents')
  }
}

export function interactiveRunCapabilities(
  prepared: PreparedTangleRetainedConnection,
): RunCapabilities {
  const { interactions: _interactions, ...environment } = prepared.capabilities
  return Object.freeze({
    streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
    sessions: { continue: true, messages: false },
    controls: { cancel: true, steer: false, queue: false, status: true, recreate: true },
    events: { stableIdentity: true, sequence: true, cursor: true },
    usage: false,
    environment,
  })
}

export function interactiveMaterializationReceipt(
  prepared: PreparedTangleRetainedConnection,
): Readonly<Record<string, unknown>> {
  const workspaceRequestDigestValue = workspaceRequestDigest(prepared.workspaceRequest)
  return publicMaterializationReceipt({
    provider: prepared.provider.name,
    backend: 'environment-provider',
    surface: 'interactive-agent',
    lifecycle: 'retained',
    execution: 'agent-runtime-retained-interactive',
    cleanup: 'explicit',
    continuity: 'session',
    idleTtlSeconds: prepared.idleTtlSeconds,
    model: prepared.model,
    runner: prepared.runner,
    ...(workspaceRequestDigestValue === undefined
      ? {}
      : { workspaceRequestDigest: workspaceRequestDigestValue }),
  })
}

export function interactiveEnvironment(
  prepared: PreparedTangleRetainedConnection,
  runId: string,
  idempotencyKey = interactiveEnvironmentIdempotencyKey(runId),
  profile = prepared.profile,
) {
  return {
    profile,
    backend: prepared.runner,
    name: stableProviderId('braid-interactive-', runId),
    metadata: {
      owner: 'braid',
      lifecycle: 'retained',
      surface: 'interactive-agent',
    },
    ...(prepared.workspaceRequest === undefined ? {} : { workspace: prepared.workspaceRequest }),
    idempotencyKey,
  }
}

export function interactiveIdempotencyKey(runId: string): string {
  return stableProviderId('interactive-braid-', runId)
}

function interactiveEnvironmentIdempotencyKey(runId: string): string {
  return stableProviderId('env-braid-interactive-', runId)
}

export function requireAdmissionRecorder(
  recorder: RetainedRunAdmissionRecorder | undefined,
): RetainedInteractiveAdmissionHook {
  if (recorder === undefined) {
    throw new Error('Retained Tangle interactive execution requires a durable admission recorder')
  }
  return (admission) => recorder(admission)
}

export function requireRecoveryReceipt(
  input: RunAdmissionReceipt | undefined,
): RunAdmissionReceipt {
  if (input === undefined) {
    throw new Error('Interactive intent recovery requires the original run receipt')
  }
  return input
}

export function requireInteractiveAdmission(
  value: RetainedRunAdmissionRecord | undefined,
): RetainedInteractiveAdmission {
  switch (value?.phase) {
    case 'interactive_intent':
    case 'interactive_environment':
    case 'interactive_started':
      return value
    default:
      throw new Error('Interactive recovery requires a canonical interactive admission')
  }
}

export function interactiveAdmissionOrUndefined(
  value: RetainedRunAdmissionRecord | undefined,
): RetainedInteractiveAdmission | undefined {
  if (value === undefined) return undefined
  return requireInteractiveAdmission(value)
}

export function interactiveSessionId(admission: RetainedInteractiveAdmission): string | undefined {
  if (admission.phase === 'interactive_intent') return admission.sessionId
  return admission.phase === 'interactive_environment'
    ? admission.request.run.sessionId
    : admission.ref.run.sessionId
}

export function assertInteractiveAdmissionMatchesInput(
  admission: RetainedInteractiveAdmission,
  input: Pick<TangleInteractiveRecoveryInput, 'providerSessionId' | 'controlRef'>,
): void {
  if (admission.phase === 'interactive_started') {
    assertStartedAdmissionMatchesInput(admission, input)
    return
  }
  const sessionId = interactiveSessionId(admission)
  if (input.providerSessionId !== undefined && input.providerSessionId !== sessionId) {
    throw new Error('Interactive provider session conflicts with the saved admission')
  }
  if (input.controlRef !== undefined) {
    throw new Error('Interactive control reference conflicts with the saved admission')
  }
}

export function assertStartedAdmissionMatchesInput(
  admission: RetainedInteractiveStartedAdmission,
  input: Pick<TangleInteractiveRecoveryInput, 'providerSessionId' | 'controlRef'>,
): void {
  if (
    input.providerSessionId !== undefined &&
    input.providerSessionId !== admission.ref.run.sessionId
  ) {
    throw new Error('Interactive provider session conflicts with the saved process reference')
  }
  if (
    input.controlRef !== undefined &&
    canonicalDigest(input.controlRef) !== canonicalDigest(admission.ref.run)
  ) {
    throw new Error('Interactive control reference conflicts with the saved process reference')
  }
}

export function assertExactControl(
  input: {
    readonly providerSessionId?: string
    readonly controlRef?: AgentExactRunControlRef
  },
  actual: AgentExactRunControlRef | undefined,
): void {
  if (
    (input.providerSessionId !== undefined || input.controlRef !== undefined) &&
    actual === undefined
  ) {
    throw new Error('Interactive exact control reference is unavailable')
  }
  if (
    input.providerSessionId !== undefined &&
    actual !== undefined &&
    input.providerSessionId !== actual.sessionId
  ) {
    throw new Error('Interactive provider session conflicts with the saved run')
  }
  if (
    input.controlRef !== undefined &&
    actual !== undefined &&
    canonicalDigest(input.controlRef) !== canonicalDigest(actual)
  ) {
    throw new Error('Interactive control reference conflicts with the saved run')
  }
}
