import {
  AgentExactRunControlRefSchema,
  type AgentExactRunControlRef,
} from '@tangle-network/agent-interface'
import type { AgentEnvironmentProvider } from '@tangle-network/agent-interface/environment-provider'
import {
  reconnectRetainedRun,
  startRetainedRun,
  type RetainedRunHandle,
} from '@tangle-network/agent-runtime/kernel'
import type { ExecuteTurnInput } from '../../ports/execution.js'
import { safeExecutionId } from './production-backend-common.js'
import type { PreparedCliBridgeConnection } from './production-cli-bridge-backend.js'

const MAX_STATUS_BYTES = 64 * 1024

export interface CliBridgeRetainedPlan {
  readonly prepared: PreparedCliBridgeConnection
  readonly provider: AgentEnvironmentProvider
  readonly environmentId: string
  readonly executionId: string
}

export async function createCliBridgeRetainedPlan(
  prepared: PreparedCliBridgeConnection,
  runId: string,
): Promise<CliBridgeRetainedPlan> {
  const { createCliBridgeProvider } = await import('@tangle-network/agent-provider-cli-bridge')
  return Object.freeze({
    prepared,
    provider: createCliBridgeProvider({
      baseUrl: prepared.bridgeUrl,
      bearerToken: prepared.bearerToken,
      defaultModel: prepared.route,
      ...(prepared.fetch === undefined ? {} : { fetch: prepared.fetch }),
    }),
    environmentId: retainedEnvironmentId(runId),
    executionId: safeExecutionId(runId),
  })
}

export async function startCliBridgeRetainedRun(
  plan: CliBridgeRetainedPlan,
  input: ExecuteTurnInput,
): Promise<RetainedRunHandle> {
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
      signal: input.signal,
    },
    identity: {
      sessionId: plan.prepared.providerSessionId,
      executionId: plan.executionId,
    },
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
  runId: string,
  signal?: AbortSignal,
): Promise<AgentExactRunControlRef | null> {
  const response = await (plan.prepared.fetch ?? globalThis.fetch)(
    `${plan.prepared.bridgeUrl}/v1/runs/${encodeURIComponent(runId)}`,
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
  if (snapshot.id !== runId) {
    throw new Error('cli-bridge run discovery returned another run')
  }
  return AgentExactRunControlRefSchema.parse({
    runId,
    provider: plan.provider.name,
    environmentId: plan.environmentId,
    sessionId: plan.prepared.providerSessionId,
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
