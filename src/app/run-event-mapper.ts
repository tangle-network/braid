import type {
  InteractionBinding,
  InteractionRequest,
  InteractionRequestMaterial,
  Part,
  StreamEvent,
} from '@tangle-network/agent-interface'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import type {
  BraidEvent,
  ProviderEventMeta,
  RunTerminalStatus,
  TurnUsage,
} from '../domain/events.js'
import { redactSensitiveText, redactStructuredValue } from '../domain/redaction.js'
import type { BraidRuntimeEvent } from '../domain/runtime-events.js'
import type { BraidMessagePart, RunStatus } from '../domain/state.js'
import { isCanonicalIsoDateTime } from '../domain/text.js'
import {
  createInteractionRequest,
  interactionRequestMaterial,
  interactionResponseBinding,
  parseInteractionRequest,
} from './interaction-request.js'
import {
  finiteNonNegativeNumber,
  safeDiagnostic,
  safeProviderDiagnostic,
  safePublicIdentifier,
} from './provider-values.js'

function safeText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? redactSensitiveText(value) : fallback
}

function safeValue(value: unknown): unknown {
  return redactStructuredValue(value, undefined, {
    maxDepth: 6,
    maxItems: 128,
    maxBytes: 32 * 1024,
  })
}

interface SafeInteractionRequest {
  readonly request: InteractionRequest
  readonly responseBinding: InteractionBinding
}

function safeInteractionRequest(value: unknown, runId: string): SafeInteractionRequest {
  const parsed = parseInteractionRequest(value)
  if (parsed === undefined || parsed.binding.runId !== runId)
    return invalidInteractionRequest(runId)
  const material = safeValue(interactionRequestMaterial(parsed))
  if (material === null || typeof material !== 'object' || Array.isArray(material))
    return invalidInteractionRequest(runId)
  try {
    const request = createInteractionRequest({
      ...(material as InteractionRequestMaterial),
      binding: { ...parsed.binding },
    })
    return { request, responseBinding: interactionResponseBinding(parsed) }
  } catch {
    return invalidInteractionRequest(runId)
  }
}

function invalidInteractionRequest(runId: string): SafeInteractionRequest {
  const exactRunId = safePublicIdentifier(runId) ?? 'run-invalid'
  const interactionId = `${exactRunId}:interaction:invalid`
  const request = createInteractionRequest({
    id: interactionId,
    kind: 'provider.invalid.interaction',
    title: 'Provider interaction unavailable',
    answerSpec: { fields: [] },
    allowedOutcomes: ['cancelled'],
    onTimeout: 'fail',
    binding: {
      runId: exactRunId,
      provider: 'braid',
      environmentId: 'environment-invalid',
      sessionId: 'session-invalid',
      executionId: exactRunId,
      interactionId,
    },
  })
  return { request, responseBinding: interactionResponseBinding(request) }
}

export function usageFromMetadata(metadata: Record<string, unknown> | undefined): TurnUsage {
  const tokenUsage =
    metadata?.tokenUsage && typeof metadata.tokenUsage === 'object'
      ? (metadata.tokenUsage as Record<string, unknown>)
      : {}
  const input = finiteNonNegativeNumber(
    typeof tokenUsage.input === 'number' ? tokenUsage.input : tokenUsage.inputTokens,
  )
  const output = finiteNonNegativeNumber(
    typeof tokenUsage.output === 'number' ? tokenUsage.output : tokenUsage.outputTokens,
  )
  const reasoning =
    typeof tokenUsage.reasoningTokens === 'number' ? tokenUsage.reasoningTokens : undefined
  const costUsd = finiteNonNegativeNumber(
    typeof metadata?.costUsd === 'number' ? metadata.costUsd : tokenUsage.cost,
    undefined,
  )
  const model = safePublicIdentifier(metadata?.model)
  return {
    input,
    output,
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(model === undefined ? {} : { model }),
  }
}

function usageFromLlm(event: Extract<RuntimeStreamEvent, { type: 'llm_call' }>): TurnUsage {
  const costUsd = finiteNonNegativeNumber(event.costUsd, undefined)
  const model = safePublicIdentifier(event.model)
  return {
    input: finiteNonNegativeNumber(event.tokensIn),
    output: finiteNonNegativeNumber(event.tokensOut),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(model === undefined ? {} : { model }),
  }
}

export function providerMeta(
  eventId: string,
  sequence: number,
  event: BraidRuntimeEvent,
  receivedAt: string,
): ProviderEventMeta {
  const timestamp =
    'timestamp' in event && typeof event.timestamp === 'string' ? event.timestamp : undefined
  return safeProviderMeta(
    {
      eventId: safePublicIdentifier(eventId) ?? `event-${sequence}`,
      providerSequence: sequence,
      ...(timestamp === undefined ? {} : { occurredAt: timestamp }),
      receivedAt,
    },
    sequence,
  )
}

export function safeProviderMeta(
  value: ProviderEventMeta,
  fallbackSequence: number,
): ProviderEventMeta {
  const cursor = value.cursor === undefined ? undefined : safePublicIdentifier(value.cursor)
  const occurredAt =
    value.occurredAt !== undefined && isCanonicalIsoDateTime(value.occurredAt)
      ? value.occurredAt
      : undefined
  const receivedAt =
    value.receivedAt !== undefined && isCanonicalIsoDateTime(value.receivedAt)
      ? value.receivedAt
      : undefined
  return {
    eventId: safePublicIdentifier(value.eventId) ?? `event-${fallbackSequence}`,
    providerSequence:
      Number.isSafeInteger(value.providerSequence) && value.providerSequence > 0
        ? value.providerSequence
        : fallbackSequence,
    ...(cursor === undefined ? {} : { cursor }),
    ...(occurredAt === undefined ? {} : { occurredAt }),
    ...(receivedAt === undefined ? {} : { receivedAt }),
  }
}

export function terminalStatus(status: string): RunTerminalStatus {
  switch (status) {
    case 'completed':
    case 'failed':
    case 'aborted':
    case 'blocked':
    case 'cancelled':
    case 'expired':
    case 'unknown':
      return status
    default:
      return 'failed'
  }
}

function canonicalPart(part: Part, source: ProviderEventMeta): BraidMessagePart {
  const sourceInfo = {
    eventId: source.eventId,
    sequence: source.providerSequence,
    ...(source.cursor === undefined ? {} : { cursor: source.cursor }),
    ...(source.occurredAt === undefined ? {} : { occurredAt: source.occurredAt }),
  }
  switch (part.type) {
    case 'text':
      return {
        id: safePublicIdentifier(part.id) ?? 'part-text',
        kind: 'text',
        text: safeText(part.text),
        source: sourceInfo,
      }
    case 'reasoning':
      return {
        id: safePublicIdentifier(part.id) ?? 'part-reasoning',
        kind: 'reasoning',
        text: safeText(part.text),
        source: sourceInfo,
      }
    case 'tool': {
      const state = part.state
      return {
        id: safePublicIdentifier(part.id) ?? 'part-tool',
        kind:
          state.status === 'completed' || state.status === 'error' || state.status === 'failed'
            ? 'tool-result'
            : 'tool-call',
        toolName: safePublicIdentifier(part.tool) ?? 'tool',
        ...(part.callID === undefined
          ? {}
          : { callId: safePublicIdentifier(part.callID) ?? 'call' }),
        status: state.status,
        input: safeValue(state.input),
        ...('output' in state && state.output !== undefined
          ? { result: safeValue(state.output) }
          : {}),
        ...('error' in state && state.error !== undefined
          ? { error: safeProviderDiagnostic(state.error, 'RUNTIME_TOOL_ERROR') }
          : {}),
        source: sourceInfo,
      }
    }
    case 'file':
      return {
        id: safePublicIdentifier(part.id) ?? 'part-artifact',
        kind: 'artifact',
        ...(part.filename === undefined ? {} : { title: safeText(part.filename) }),
        ...(part.mediaType === undefined ? {} : { mimeType: safeText(part.mediaType) }),
        ...(part.url === undefined ? {} : { uri: safeText(part.url) }),
        source: sourceInfo,
      }
    case 'subtask':
      return {
        id: safePublicIdentifier(part.id) ?? 'part-subtask',
        kind: 'system',
        title: safeText(part.description),
        text: safeText(part.prompt),
        metadata: { agent: safePublicIdentifier(part.agent) ?? 'agent' },
        source: sourceInfo,
      }
    default: {
      const exhaustive: never = part
      return exhaustive
    }
  }
}

function statusFromCanonical(
  status: Extract<StreamEvent, { type: 'status' }>['status'],
): RunStatus {
  switch (status) {
    case 'started':
      return 'starting'
    case 'processing':
      return 'streaming'
    case 'completed':
      return 'running'
    case 'failed':
      return 'failed'
    default: {
      const exhaustive: never = status
      return exhaustive
    }
  }
}

export function providerEventFor(
  runId: string,
  event: BraidRuntimeEvent,
  provider: ProviderEventMeta,
): BraidEvent {
  const detailEvent =
    event.type === 'raw'
      ? ({ type: 'raw', event: { redacted: true } } as BraidRuntimeEvent)
      : event.type === 'unknown'
        ? ({ type: 'unknown', payload: { redacted: true } } as BraidRuntimeEvent)
        : event
  switch (event.type) {
    case 'text_delta':
      return { kind: 'run.text.delta', runId, text: safeText(event.text), provider }
    case 'reasoning_delta':
      return {
        kind: 'run.reasoning.delta',
        runId,
        partId: `${runId}:reasoning`,
        text: safeText(event.text),
        provider,
      }
    case 'tool_call':
      return {
        kind: 'run.tool.call',
        runId,
        partId:
          safePublicIdentifier(event.toolCallId ?? `${runId}:tool:${provider.eventId}`) ??
          `${runId}:tool`,
        toolName: safePublicIdentifier(event.toolName) ?? 'tool',
        ...(event.toolCallId === undefined
          ? {}
          : { callId: safePublicIdentifier(event.toolCallId) ?? 'call' }),
        ...(event.args === undefined ? {} : { input: safeValue(event.args) }),
        provider,
      }
    case 'tool_result':
      return {
        kind: 'run.tool.result',
        runId,
        partId:
          safePublicIdentifier(event.toolCallId ?? `${runId}:tool:${provider.eventId}`) ??
          `${runId}:tool`,
        toolName: safePublicIdentifier(event.toolName) ?? 'tool',
        ...(event.toolCallId === undefined
          ? {}
          : { callId: safePublicIdentifier(event.toolCallId) ?? 'call' }),
        ...(event.result === undefined ? {} : { result: safeValue(event.result) }),
        provider,
      }
    case 'llm_call':
      return { kind: 'run.usage', runId, usage: usageFromLlm(event), provider }
    case 'artifact':
      return {
        kind: 'run.artifact',
        runId,
        artifactId: safePublicIdentifier(event.artifactId) ?? `${runId}:artifact`,
        ...(event.name === undefined ? {} : { name: safeText(event.name) }),
        ...(event.mimeType === undefined ? {} : { mimeType: safeText(event.mimeType) }),
        ...(event.uri === undefined ? {} : { uri: safeText(event.uri) }),
        ...(event.metadata === undefined
          ? {}
          : { metadata: safeValue(event.metadata) as Readonly<Record<string, unknown>> }),
        provider,
      }
    case 'proposal_created':
      return {
        kind: 'run.proposal',
        runId,
        proposalId: safePublicIdentifier(event.proposalId) ?? `${runId}:proposal`,
        title: safeText(event.title),
        ...(event.status === undefined ? {} : { status: event.status }),
        provider,
      }
    case 'backend_error':
      return {
        kind: 'run.error',
        runId,
        message: safeProviderDiagnostic(event.message, 'RUNTIME_BACKEND_ERROR'),
        recoverable: event.recoverable,
        provider,
      }
    case 'final':
      return {
        kind: 'run.finished',
        runId,
        status: terminalStatus(event.status),
        finalText: safeText(event.text),
        usage: usageFromMetadata(event.metadata),
        ...(event.error === undefined
          ? {}
          : { error: safeDiagnostic(event.error.message, 'RUNTIME_FINAL_ERROR') }),
        ...(event.reason === undefined
          ? {}
          : { reason: safeProviderDiagnostic(event.reason, 'RUNTIME_FINAL_REASON') }),
        provider,
      }
    case 'message.part.updated': {
      const part = canonicalPart(event.part, provider)
      return {
        kind: 'run.part.updated',
        runId,
        part,
        ...(event.delta === undefined ? {} : { delta: safeText(event.delta) }),
        provider,
      }
    }
    case 'interaction':
      return {
        kind: 'run.interaction',
        runId,
        ...safeInteractionRequest(event.request, runId),
        provider,
      }
    case 'interaction.cancel':
      return {
        kind: 'run.interaction.cancelled',
        runId,
        interactionId: safePublicIdentifier(event.id) ?? `${runId}:interaction`,
        ...(event.reason === undefined ? {} : { reason: safeText(event.reason) }),
        provider,
      }
    case 'warning':
      return {
        kind: 'run.warning',
        runId,
        code: safeProviderDiagnostic(event.code, 'RUNTIME_WARNING'),
        message: safeProviderDiagnostic(event.message, 'RUNTIME_WARNING'),
        provider,
      }
    case 'status':
      return {
        kind: 'run.status.changed',
        runId,
        status: statusFromCanonical(event.status),
        ...(event.detail === undefined
          ? {}
          : { detail: safeProviderDiagnostic(event.detail, 'RUNTIME_STATUS') }),
        provider,
      }
    case 'unknown':
      return {
        kind: 'run.provider.event',
        runId,
        envelope: {
          runId,
          eventId: provider.eventId,
          sequence: provider.providerSequence,
          receivedAt: provider.receivedAt ?? new Date().toISOString(),
          event: safeValue(detailEvent) as BraidRuntimeEvent,
        },
        provider,
      }
    default:
      return {
        kind: 'run.provider.event',
        runId,
        envelope: {
          runId,
          eventId: provider.eventId,
          sequence: provider.providerSequence,
          ...(provider.cursor === undefined ? {} : { cursor: provider.cursor }),
          ...(provider.occurredAt === undefined ? {} : { occurredAt: provider.occurredAt }),
          receivedAt: provider.receivedAt ?? new Date().toISOString(),
          event: safeValue(detailEvent) as BraidRuntimeEvent,
        },
        provider,
      }
  }
}

export function eventIdFor(runId: string, event: BraidRuntimeEvent, sequence: number): string {
  if (event.type === 'message.part.updated') return `${runId}:part:${event.part.id}:${sequence}`
  if (event.type === 'session.updated') return `${runId}:session:${event.sessionId}:${sequence}`
  if (event.type === 'interaction') return `${runId}:interaction:${event.request.id}`
  if (event.type === 'interaction.cancel') return `${runId}:interaction-cancel:${event.id}`
  return `${runId}:runtime:${sequence}`
}
