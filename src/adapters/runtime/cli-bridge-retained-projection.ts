import type { TokenUsage } from '@tangle-network/agent-interface'
import type { AgentTurnResult } from '@tangle-network/agent-interface/environment-provider'
import { canonicalDigest } from '../../domain/canonical.js'
import type { TurnUsage } from '../../domain/entities.js'
import type { RuntimeEventEnvelope } from '../../domain/runtime-events.js'
import type { RunStatus } from '../../domain/state.js'
import type { ExecuteTurnInput, RunCapabilities } from '../../ports/execution.js'
import { canonicalAgentProfileDigestHex } from '../agent-interface/profile-runtime.js'
import type { PreparedCliBridgeConnection } from './production-cli-bridge-backend.js'

export function retainedExecutionKey(input: ExecuteTurnInput): string {
  return canonicalDigest({
    runId: input.runId,
    operationId: input.operationId,
    text: input.text,
    profile: canonicalAgentProfileDigestHex(input.profile),
    connectionId: input.connectionId ?? null,
    workspaceRoot: input.workspaceRoot ?? null,
    sessionId: input.sessionId ?? null,
    contextBoundary: input.contextBoundary ?? null,
  })
}

export function retainedCapabilities(prepared: PreparedCliBridgeConnection): RunCapabilities {
  return Object.freeze({
    streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
    sessions: { continue: prepared.capabilities.sessions.continue, messages: false },
    controls: { cancel: true, steer: false, queue: true, status: true, recreate: true },
    events: { stableIdentity: true, sequence: true, cursor: true },
    usage: true,
    environment: prepared.capabilities,
  })
}

export function retainedStatus(status: string | null, detached: boolean): RunStatus {
  if (detached && ['pending', 'provisioning', 'running', 'stopped'].includes(status ?? '')) {
    return 'detached'
  }
  switch (status) {
    case 'pending':
    case 'provisioning':
      return 'starting'
    case 'running':
      return 'streaming'
    case 'completed':
      return 'completed'
    case 'cancelled':
      return 'cancelled'
    case 'failed':
      return 'failed'
    case 'expired':
      return 'expired'
    default:
      return 'unknown'
  }
}

export function isTerminalRetainedStatus(status: RunStatus): boolean {
  return ['completed', 'cancelled', 'failed', 'expired', 'aborted', 'blocked'].includes(status)
}

export function retainedTurnUsage(
  usage: TokenUsage | undefined,
  model: string | undefined,
  calls?: number,
): TurnUsage {
  return {
    input: usage?.inputTokens ?? 0,
    output: usage?.outputTokens ?? 0,
    ...(calls === undefined ? {} : { calls }),
    ...(usage === undefined ? { tokensKnown: false as const } : {}),
    ...(usage?.reasoningTokens === undefined ? {} : { reasoning: usage.reasoningTokens }),
    ...(usage?.cost === undefined ? {} : { costUsd: usage.cost }),
    ...(usage?.cost === undefined ? { usdKnown: false as const } : {}),
    ...(model === undefined ? {} : { model }),
  }
}

export function finalRetainedEnvelope(
  runId: string,
  sequence: number,
  model: string,
  result: AgentTurnResult,
): RuntimeEventEnvelope {
  const timestamp = new Date().toISOString()
  const usage = retainedTurnUsage(result.usage, model, modelRequestsFromResult(result))
  return {
    runId,
    eventId: `${runId}:final`,
    sequence,
    receivedAt: timestamp,
    event: {
      type: 'final',
      task: { id: runId, intent: 'Execute the retained CLI Bridge turn' },
      status: result.success ? 'completed' : 'failed',
      reason: result.success ? 'completed' : (result.error ?? 'CLI Bridge run failed'),
      text: result.text,
      metadata: {
        model,
        tokenUsage: {
          input: usage.input,
          output: usage.output,
          ...(usage.reasoning === undefined ? {} : { reasoningTokens: usage.reasoning }),
        },
        ...(usage.tokensKnown === false ? { tokensKnown: false } : {}),
        ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
        ...(usage.usdKnown === false ? { usdKnown: false } : {}),
        ...(usage.calls === undefined ? {} : { llmCalls: usage.calls }),
      },
      ...(result.success || result.error === undefined
        ? {}
        : {
            error: { kind: 'backend', message: result.error },
          }),
      timestamp,
    },
  }
}

export function modelRequestsFromResult(result: AgentTurnResult): number | undefined {
  const value = result.metadata?.modelRequests
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
