import type { TokenUsage } from '@tangle-network/agent-interface'
import type {
  AgentEnvironmentCapabilities,
  AgentTurnResult,
} from '@tangle-network/agent-interface/environment-provider'
import type { TurnUsage } from '../../domain/entities.js'
import type { RuntimeEventEnvelope } from '../../domain/runtime-events.js'
import type { RunStatus } from '../../domain/state.js'
import type { RunCapabilities } from '../../ports/execution.js'

export function retainedCapabilities(
  environment: AgentEnvironmentCapabilities,
  options: {
    readonly sessionContinuation?: boolean
    readonly exactStatus?: boolean
  } = {},
): RunCapabilities {
  return Object.freeze({
    streaming: {
      live: environment.streaming.live,
      replay: environment.streaming.replay,
      detach: environment.streaming.detach,
      turnIdempotency: environment.streaming.turnIdempotency,
    },
    sessions: {
      continue: options.sessionContinuation ?? environment.sessions.continue,
      messages: false,
    },
    controls: {
      cancel: true,
      steer: false,
      queue: true,
      status: options.exactStatus ?? true,
      recreate: true,
    },
    events: { stableIdentity: true, sequence: true, cursor: true },
    usage: environment.usage,
    environment,
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
  intent: string,
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
      task: { id: runId, intent },
      status: result.success ? 'completed' : 'failed',
      reason: result.success ? 'completed' : (result.error ?? 'Retained run failed'),
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
        : { error: { kind: 'backend', message: result.error } }),
      timestamp,
    },
  }
}

export function modelRequestsFromResult(result: AgentTurnResult): number | undefined {
  const value = result.metadata?.modelRequests
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
