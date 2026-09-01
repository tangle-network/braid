import type { AgentEnvironmentCapabilities } from '@tangle-network/agent-interface/environment-provider'
import type { TurnUsage } from '../../domain/entities.js'
import { redactSensitiveText } from '../../domain/redaction.js'
import type { BraidFinalRuntimeEvent, RuntimeEventEnvelope } from '../../domain/runtime-events.js'
import type { RunStatus } from '../../domain/state.js'
import type { RunCapabilities } from '../../ports/execution.js'
import type { RetainedTurnResult } from './retained-execution-contract.js'

export function retainedCapabilities(
  environment: AgentEnvironmentCapabilities,
  options: {
    readonly sessionContinuation?: boolean
    readonly exactStatus?: boolean
  } = {},
): RunCapabilities {
  const retainedControl =
    environment.retainedControl?.exactRunIdentity === true &&
    environment.retainedControl.resultIdentity === true &&
    environment.retainedControl.eventIdentity === true &&
    environment.retainedControl.cancellationIdempotency === true
  const exactStatus = retainedControl && (options.exactStatus ?? true)
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
      cancel: retainedControl,
      steer: false,
      queue: true,
      status: exactStatus,
      recreate: retainedControl,
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
  usage: RetainedTurnResult['usage'],
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
  result: RetainedTurnResult,
  intent: string,
): RuntimeEventEnvelope {
  const timestamp = new Date().toISOString()
  const usage = retainedTurnUsage(result.usage, model, modelRequestsFromResult(result))
  const cancelled = !result.success && result.metadata?.status === 'cancelled'
  const status: Extract<RunStatus, 'completed' | 'cancelled' | 'failed'> = result.success
    ? 'completed'
    : cancelled
      ? 'cancelled'
      : 'failed'
  const event: BraidFinalRuntimeEvent = {
    type: 'final',
    task: { id: runId, intent },
    status,
    // Provider failure text can carry a credential, so it is redacted here,
    // where runtime text first enters Braid.
    reason: result.success
      ? 'completed'
      : redactSensitiveText(
          result.error ?? (cancelled ? 'Retained run cancelled' : 'Retained run failed'),
        ),
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
  }
  return {
    runId,
    eventId: `${runId}:final`,
    sequence,
    receivedAt: timestamp,
    event,
  }
}

export function modelRequestsFromResult(result: RetainedTurnResult): number | undefined {
  const value = result.metadata?.modelRequests
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
