import type { AgentExactRunControlRef } from '@tangle-network/agent-interface'
import type { AgentEnvironmentProvider } from '@tangle-network/agent-interface/environment-provider'
import {
  type RetainedRunHandle,
  reconnectRetainedRun,
  startRetainedRun,
} from '@tangle-network/agent-runtime/kernel'
import { publicMaterializationReceipt } from '../../domain/materialization-receipt.js'
import type { RuntimeEventEnvelope } from '../../domain/runtime-events.js'
import type { ExecuteTurnInput } from '../../ports/execution.js'
import type { PreparedTangleRetainedConnection } from './production-tangle-sandbox-backend.js'
import { safeExecutionId } from './production-backend-common.js'
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

export interface TangleRetainedPlan extends RetainedExecutionPlan {
  readonly prepared: PreparedTangleRetainedConnection
  readonly provider: AgentEnvironmentProvider
  readonly executionId: string
}

export function createTangleRetainedPlan(
  prepared: PreparedTangleRetainedConnection,
  runId: string,
  controlRef?: AgentExactRunControlRef,
): TangleRetainedPlan {
  const executionId = controlRef?.executionId ?? safeExecutionId(runId)
  const plan: TangleRetainedPlan = {
    prepared,
    provider: prepared.provider,
    executionId,
    providerName: prepared.provider.name,
    exactStatus: false,
    ...(controlRef === undefined ? {} : { environmentId: controlRef.environmentId }),
    providerSessionId: controlRef?.sessionId ?? prepared.providerSessionId,
    model: prepared.model,
    capabilities: retainedCapabilities(prepared.capabilities, {
      sessionContinuation: false,
      exactStatus: false,
    }),
    materializationReceipt: publicMaterializationReceipt({
      ...prepared.materializationReceipt,
      providerRunId: controlRef?.runId ?? executionId,
      retainedControl: 'exact-after-dispatch',
    }),
    start: (input) => startTangleRetainedRun(plan, input),
    reconnect: (exact) => reconnectRetainedRun({ provider: plan.provider, controlRef: exact }),
    discover: async (braidRunId, signal) => {
      const exact = await prepared.discoverControlRef(braidRunId, signal)
      if (exact === null) return null
      if (exact.executionId !== executionId) {
        throw new Error('Tangle retained lookup returned another execution')
      }
      return exact
    },
    observe: () => prepared.observation.snapshot(),
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
        'Execute the retained Tangle sandbox turn',
      ),
  }
  return Object.freeze(plan)
}

export async function startTangleRetainedRun(
  plan: TangleRetainedPlan,
  input: ExecuteTurnInput,
): Promise<RetainedRunHandle> {
  // A retained create may return an existing environment for the same key.
  // Do not destroy it after an ambiguous dispatch failure without a provider-issued creation receipt.
  return startRetainedRun({
    provider: plan.provider,
    environment: {
      profile: plan.prepared.profile,
      backend: plan.prepared.runner,
      name: plan.prepared.environmentName,
      metadata: plan.prepared.environmentMetadata,
      idempotencyKey: plan.prepared.environmentIdempotencyKey,
    },
    turn: {
      prompt: input.text,
      turnId: safeExecutionId(input.operationId),
      signal: input.signal,
    },
    identity: {
      sessionId: plan.prepared.providerSessionId,
      executionId: plan.executionId,
    },
  })
}
