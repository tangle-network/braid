import {
  type AgentExactRunControlRef,
  AgentExactRunControlRefSchema,
} from '@tangle-network/agent-interface'
import type { AgentEnvironmentProvider } from '@tangle-network/agent-interface/environment-provider'
import {
  type RetainedRunHandle,
  reconnectRetainedRun,
  startRetainedRun,
} from '@tangle-network/agent-runtime/kernel'
import { publicMaterializationReceipt } from '../../domain/materialization-receipt.js'
import type { RuntimeEventEnvelope } from '../../domain/runtime-events.js'
import type { ExecuteTurnInput } from '../../ports/execution.js'
import { safeExecutionId } from './production-backend-common.js'
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

const MAX_STATUS_BYTES = 64 * 1024

export interface CliBridgeRetainedPlan extends RetainedExecutionPlan {
  readonly prepared: PreparedCliBridgeConnection
  readonly provider: AgentEnvironmentProvider
  readonly environmentId: string
  readonly executionId: string
}

export async function createCliBridgeRetainedPlan(
  prepared: PreparedCliBridgeConnection,
  runId: string,
  controlRef?: AgentExactRunControlRef,
): Promise<CliBridgeRetainedPlan> {
  const { createCliBridgeProvider } = await import('@tangle-network/agent-provider-cli-bridge')
  const provider = createCliBridgeProvider({
    baseUrl: prepared.bridgeUrl,
    bearerToken: prepared.bearerToken,
    defaultModel: prepared.route,
    ...(prepared.fetch === undefined ? {} : { fetch: prepared.fetch }),
  })
  const environmentId = controlRef?.environmentId ?? retainedEnvironmentId(runId)
  const executionId = controlRef?.executionId ?? safeExecutionId(runId)
  const providerName = provider.name
  const capabilities = retainedCapabilities(prepared.capabilities)
  const materializationReceipt = publicMaterializationReceipt({
    ...prepared.materializationReceipt,
    backend: 'environment-provider',
    environmentId,
    providerRunId: controlRef?.runId ?? executionId,
    retainedControl: 'exact-after-dispatch',
  })
  const plan: CliBridgeRetainedPlan = {
    prepared,
    provider,
    environmentId,
    executionId,
    providerName,
    providerSessionId: controlRef?.sessionId ?? prepared.providerSessionId,
    model: prepared.route,
    capabilities,
    materializationReceipt,
    start: (input) => startCliBridgeRetainedRun(plan, input),
    reconnect: (controlRef) => reconnectCliBridgeRetainedRun(plan, controlRef),
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
      idempotencyKey: plan.environmentId,
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

/** Recover the exact server-issued digest after a client crashed during dispatch. */
export async function discoverCliBridgeControlRef(
  plan: CliBridgeRetainedPlan,
  _braidRunId: string,
  signal?: AbortSignal,
): Promise<AgentExactRunControlRef | null> {
  const providerRunId = plan.executionId
  const response = await (plan.prepared.fetch ?? globalThis.fetch)(
    `${plan.prepared.bridgeUrl}/v1/runs/${encodeURIComponent(providerRunId)}`,
    {
      method: 'GET',
      headers: { authorization: `Bearer ${plan.prepared.bearerToken}` },
      ...(signal === undefined ? {} : { signal }),
    },
  )
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`cli-bridge run discovery returned HTTP ${response.status}`)
  }
  const body = await boundedResponseText(response)
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    throw new Error('cli-bridge run discovery returned invalid JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('cli-bridge run discovery returned an invalid run snapshot')
  }
  const snapshot = value as Record<string, unknown>
  if (snapshot.id !== providerRunId) {
    throw new Error('cli-bridge run discovery returned another run identity')
  }
  return AgentExactRunControlRefSchema.parse({
    runId: snapshot.id,
    provider: plan.provider.name,
    environmentId: plan.environmentId,
    sessionId: plan.providerSessionId,
    executionId: plan.executionId,
    requestDigest: snapshot.requestDigest,
  })
}

export function retainedEnvironmentId(runId: string): string {
  return `environment-braid-${safeExecutionId(runId)}`
}

async function boundedResponseText(response: Response): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let byteLength = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      byteLength += next.value.byteLength
      if (byteLength > MAX_STATUS_BYTES) {
        await reader.cancel('CLI Bridge run discovery response exceeded 64 KiB')
        throw new Error('cli-bridge run discovery response exceeded 64 KiB')
      }
      chunks.push(decoder.decode(next.value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  } finally {
    reader.releaseLock()
  }
}
