import type { InteractionRequest } from '@tangle-network/agent-interface'
import type { BraidEvent, BraidEventEnvelope, ProviderEventMeta } from '../../domain/events.js'
import type { RunAdmissionReceipt, RunCapabilities } from '../../domain/receipts.js'
import type { BraidMessagePart } from '../../domain/state.js'
import type { TranscriptPartView } from './models.js'
import { boundVisibleText, redactStructuredValue, sanitizeTerminalText } from './sanitize.js'

const MAX_EVENT_ITEMS = 128
const MAX_EVENT_BYTES = 64 * 1024

function safe(value: unknown): unknown {
  return redactStructuredValue(value, undefined, {
    maxDepth: 6,
    maxItems: MAX_EVENT_ITEMS,
    maxBytes: MAX_EVENT_BYTES,
  })
}

function safeWithin(
  value: unknown,
  limits: { readonly maxDepth: number; readonly maxItems: number; readonly maxBytes: number },
): unknown {
  return redactStructuredValue(value, undefined, limits)
}

function boundedAdmissionText(value: unknown, maxBytes = 4096): string | undefined {
  if (typeof value !== 'string') return undefined
  const projected = safeWithin(value, { maxDepth: 1, maxItems: 1, maxBytes })
  return typeof projected === 'string' ? projected : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? boundVisibleText(value) : undefined
}

function sourceOf(event: BraidEvent): ProviderEventMeta | undefined {
  return 'provider' in event && event.provider ? event.provider : undefined
}

function withSource(event: BraidEvent, value: Record<string, unknown>): Record<string, unknown> {
  const source = sourceOf(event)
  return source === undefined ? value : { ...value, source: safe(source) }
}

export function projectSemanticEvent(
  envelope: BraidEventEnvelope,
): Readonly<Record<string, unknown>> {
  const event = envelope.event
  const source = sourceOf(event)
  const runId = 'runId' in event && typeof event.runId === 'string' ? event.runId : undefined
  const base = {
    ...(runId === undefined ? {} : { runId }),
    ...(source === undefined ? {} : { source: safe(source) }),
  }
  switch (event.kind) {
    case 'run.text.delta': {
      const value = text(event.text) ?? ''
      return withSource(event, {
        ...base,
        text: value,
        part: { kind: 'text', status: 'running', text: value },
      })
    }
    case 'run.reasoning.delta': {
      const value = text(event.text) ?? ''
      return withSource(event, {
        ...base,
        reasoning: value,
        part: { id: event.partId, kind: 'reasoning', status: 'running', text: value },
      })
    }
    case 'run.part.updated':
      return withSource(event, {
        ...base,
        part: semanticPart(event.part),
        ...(event.delta === undefined ? {} : { delta: text(event.delta) ?? '' }),
      })
    case 'run.tool.call':
      return withSource(event, {
        ...base,
        tool: {
          id: event.partId,
          callId: event.callId,
          name: event.toolName,
          status: 'running',
          ...(event.input === undefined ? {} : { input: safe(event.input) }),
        },
        part: {
          id: event.partId,
          kind: 'tool',
          status: 'running',
          text: '',
          ...(event.input === undefined ? {} : { input: safe(event.input) }),
        },
      })
    case 'run.tool.result':
      return withSource(event, {
        ...base,
        tool: {
          id: event.partId,
          callId: event.callId,
          name: event.toolName,
          status: event.error === undefined ? 'complete' : 'failed',
          ...(event.result === undefined ? {} : { result: safe(event.result) }),
          ...(event.error === undefined ? {} : { error: sanitizeTerminalText(event.error) }),
        },
        part: {
          id: event.partId,
          kind: 'result',
          status: event.error === undefined ? 'complete' : 'failed',
          text: '',
          ...(event.result === undefined ? {} : { result: safe(event.result) }),
          ...(event.error === undefined ? {} : { error: sanitizeTerminalText(event.error) }),
        },
      })
    case 'run.artifact':
      return withSource(event, {
        ...base,
        artifact: safe({
          id: event.artifactId,
          name: event.name,
          mimeType: event.mimeType,
          uri: event.uri,
          metadata: event.metadata,
        }),
        part: {
          id: event.artifactId,
          kind: 'artifact',
          status: 'complete',
          text: text(event.name ?? event.uri) ?? '',
          ...(event.artifactId === undefined ? {} : { artifactId: event.artifactId }),
          ...(event.uri === undefined ? {} : { uri: event.uri }),
          ...(event.mimeType === undefined ? {} : { mimeType: event.mimeType }),
          ...(event.metadata === undefined ? {} : { metadata: safe(event.metadata) }),
        },
      })
    case 'run.proposal':
      return withSource(event, {
        ...base,
        proposal: safe({ id: event.proposalId, title: event.title, status: event.status }),
        part: {
          id: event.proposalId,
          kind: 'proposal',
          status: 'complete',
          text: text(event.title) ?? '',
        },
      })
    case 'run.warning':
      return withSource(event, {
        ...base,
        warning: safe({ code: event.code, message: event.message }),
        text: text(event.message) ?? '',
      })
    case 'run.error':
      return withSource(event, {
        ...base,
        error: safe({ message: event.message, recoverable: event.recoverable }),
        text: text(event.message) ?? '',
      })
    case 'run.finished':
      return withSource(event, {
        ...base,
        status: event.status,
        completeness: event.status === 'unknown' ? 'unknown' : 'complete',
        finalText: text(event.finalText) ?? '',
        usage: safe(event.usage),
        ...(event.reason === undefined ? {} : { reason: text(event.reason) ?? 'RUNTIME_STATUS' }),
        ...(event.error === undefined ? {} : { error: text(event.error) ?? 'RUNTIME_ERROR' }),
      })
    case 'run.interaction':
      return withSource(event, {
        ...base,
        interaction: semanticInteractionRequest(event.request),
      })
    case 'run.interaction.cancelled':
      return withSource(event, {
        ...base,
        interaction: safe({ id: event.interactionId, status: 'cancelled', reason: event.reason }),
      })
    case 'run.provider.event':
      return event.envelope.event.type === 'session.updated'
        ? withSource(event, {
            ...base,
            harnessSession: safe({
              id: event.envelope.event.sessionId,
              title: event.envelope.event.title,
              time: event.envelope.event.time,
            }),
          })
        : withSource(event, { ...base, unknown: safe(event.envelope.event) })
    case 'run.queue.added':
      return {
        ...base,
        queue: {
          operationId: event.operationId,
          runId: event.runId,
          text: text(event.text) ?? '',
          position: event.position,
          status: 'queued',
        },
      }
    case 'run.queue.removed':
      return {
        ...base,
        queue: { operationId: event.operationId, runId: event.runId, status: 'removed' },
      }
    case 'run.control.requested':
      return {
        ...base,
        control: safe({
          operationId: event.operationId,
          runId: event.runId,
          control: event.control,
          status: 'requested',
          reason: event.reason,
          text: event.text,
        }),
      }
    case 'run.cancel.requested':
      return {
        ...base,
        control: safe({
          operationId: event.operationId,
          runId: event.runId,
          control: 'cancel',
          status: 'requested',
          reason: event.reason,
        }),
      }
    case 'run.control.acknowledged':
      return {
        ...base,
        control: safe({
          operationId: event.operationId,
          runId: event.runId,
          control: event.control,
          status: event.outcome,
          detail: event.detail,
        }),
      }
    case 'run.requested':
      return {
        ...base,
        text: text(event.text) ?? '',
        ...(event.receipt === undefined
          ? {}
          : { admission: semanticAdmissionReceipt(event.receipt) }),
        status: 'admitted',
      }
    case 'run.unknown':
      return {
        ...base,
        status: 'unknown',
        completeness: 'unknown',
        error: text(event.detail) ?? 'RUNTIME_UNKNOWN',
      }
    case 'run.detached':
      return {
        ...base,
        status: 'detached',
        completeness: 'streaming',
        ...(event.cursor === undefined ? {} : { cursor: text(event.cursor) ?? '' }),
        ...(event.detail === undefined ? {} : { detail: text(event.detail) ?? '' }),
      }
    case 'run.reconnecting':
      return {
        ...base,
        status: 'reconnecting',
        completeness: 'streaming',
        ...(event.after === undefined ? {} : { cursor: text(event.after) ?? '' }),
      }
    case 'run.reconciled':
      return {
        ...base,
        status: event.status,
        completeness: event.status === 'unknown' ? 'unknown' : 'complete',
        evidence: event.evidence,
        ...(event.detail === undefined ? {} : { detail: text(event.detail) ?? 'RUNTIME_STATUS' }),
      }
    default:
      return { ...base, value: safe(event) }
  }
}

/** Keep stable run identity independent of the size of provider capability data. */
function semanticAdmissionReceipt(receipt: RunAdmissionReceipt): Readonly<Record<string, unknown>> {
  const requested = receipt.requested
  return {
    version: receipt.version,
    runId: boundedAdmissionText(receipt.runId) ?? '',
    turnId: boundedAdmissionText(receipt.turnId) ?? '',
    operationId: boundedAdmissionText(receipt.operationId) ?? '',
    conversationId: boundedAdmissionText(receipt.conversationId) ?? '',
    branchId: boundedAdmissionText(receipt.branchId) ?? '',
    admittedAt: boundedAdmissionText(receipt.admittedAt) ?? '',
    profileDigest: boundedAdmissionText(receipt.profileDigest) ?? '',
    requested: {
      text: boundedAdmissionText(requested.text, 8 * 1024) ?? '',
      profile: safeWithin(requested.profile, {
        maxDepth: 6,
        maxItems: 64,
        maxBytes: 12 * 1024,
      }),
      ...(requested.connectionId === undefined
        ? {}
        : { connectionId: boundedAdmissionText(requested.connectionId) ?? '' }),
      ...(requested.mode === undefined ? {} : { mode: boundedAdmissionText(requested.mode) ?? '' }),
      ...(requested.interactions === undefined
        ? {}
        : {
            interactions: safeWithin(requested.interactions, {
              maxDepth: 4,
              maxItems: 32,
              maxBytes: 4 * 1024,
            }),
          }),
      ...(requested.model === undefined
        ? {}
        : { model: boundedAdmissionText(requested.model) ?? '' }),
      ...(requested.runner === undefined
        ? {}
        : { runner: boundedAdmissionText(requested.runner) ?? '' }),
      ...(requested.contextPlanDigest === undefined
        ? {}
        : { contextPlanDigest: boundedAdmissionText(requested.contextPlanDigest) ?? '' }),
    },
    capabilities: semanticRunCapabilities(receipt.capabilities),
    ...(receipt.provider === undefined
      ? {}
      : { provider: boundedAdmissionText(receipt.provider) ?? '' }),
    ...(receipt.requestedSessionId === undefined
      ? {}
      : { requestedSessionId: boundedAdmissionText(receipt.requestedSessionId) ?? '' }),
    ...(receipt.environmentId === undefined
      ? {}
      : { environmentId: boundedAdmissionText(receipt.environmentId) ?? '' }),
    ...(receipt.providerSessionId === undefined
      ? {}
      : { providerSessionId: boundedAdmissionText(receipt.providerSessionId) ?? '' }),
    ...(receipt.materializationReceipt === undefined
      ? {}
      : {
          materializationReceipt: safeWithin(receipt.materializationReceipt, {
            maxDepth: 6,
            maxItems: 64,
            maxBytes: 12 * 1024,
          }),
        }),
    ...(receipt.contextTransfer === undefined
      ? {}
      : {
          contextTransfer: safeWithin(receipt.contextTransfer, {
            maxDepth: 4,
            maxItems: 16,
            maxBytes: 2 * 1024,
          }),
        }),
    ...(receipt.nativeContextBoundaryProof === undefined
      ? {}
      : {
          nativeContextBoundaryProof: safeWithin(receipt.nativeContextBoundaryProof, {
            maxDepth: 4,
            maxItems: 32,
            maxBytes: 4 * 1024,
          }),
        }),
    ...(receipt.warnings === undefined
      ? {}
      : {
          warnings: receipt.warnings
            .slice(0, 64)
            .map((warning) => boundedAdmissionText(warning, 1024) ?? 'PROVIDER_WARNING'),
        }),
    ...(receipt.admissionStatus === undefined ? {} : { admissionStatus: receipt.admissionStatus }),
    requestDigest: boundedAdmissionText(receipt.requestDigest) ?? '',
    capabilitiesDigest: boundedAdmissionText(receipt.capabilitiesDigest) ?? '',
    ...(receipt.materializationDigest === undefined
      ? {}
      : { materializationDigest: boundedAdmissionText(receipt.materializationDigest) ?? '' }),
    digest: boundedAdmissionText(receipt.digest) ?? '',
  }
}

function semanticRunCapabilities(capabilities: RunCapabilities): Readonly<Record<string, unknown>> {
  return {
    streaming: {
      live: capabilities.streaming.live,
      replay: capabilities.streaming.replay,
      detach: capabilities.streaming.detach,
      turnIdempotency: capabilities.streaming.turnIdempotency,
    },
    sessions: {
      continue: capabilities.sessions.continue,
      messages: capabilities.sessions.messages,
    },
    controls: {
      cancel: capabilities.controls.cancel,
      steer: capabilities.controls.steer,
      queue: capabilities.controls.queue,
      status: capabilities.controls.status,
      recreate: capabilities.controls.recreate,
    },
    events: {
      stableIdentity: capabilities.events.stableIdentity,
      sequence: capabilities.events.sequence,
      cursor: capabilities.events.cursor,
    },
    usage: capabilities.usage,
    ...(capabilities.environment === undefined
      ? {}
      : {
          environment: safeWithin(capabilities.environment, {
            maxDepth: 6,
            maxItems: 128,
            maxBytes: 16 * 1024,
          }),
        }),
  }
}

function semanticInteractionRequest(
  request: InteractionRequest,
): Readonly<Record<string, unknown>> {
  return {
    id: text(request.id) ?? '',
    kind: text(request.kind) ?? '',
    title: text(request.title) ?? '',
    ...(request.body === undefined ? {} : { body: text(request.body) ?? '' }),
    ...(request.subject === undefined
      ? {}
      : { subject: semanticInteractionSubject(request.subject) }),
    answerSpec: semanticAnswerSpec(request.answerSpec),
    ...(request.responseScopes === undefined
      ? {}
      : { responseScopes: request.responseScopes.map((scope) => text(scope) ?? '') }),
    ...(request.allowedOutcomes === undefined
      ? {}
      : { allowedOutcomes: request.allowedOutcomes.map((outcome) => text(outcome) ?? '') }),
  }
}

function semanticInteractionSubject(
  subject: NonNullable<InteractionRequest['subject']>,
): Readonly<Record<string, unknown>> {
  switch (subject.type) {
    case 'tool':
      return { type: 'tool', toolName: text(subject.toolName) ?? '' }
    case 'command':
      return { type: 'command', command: text(subject.command) ?? '' }
    case 'file':
      return {
        type: 'file',
        path: text(subject.path) ?? '',
        ...(subject.preview === undefined ? {} : { preview: text(subject.preview) ?? '' }),
      }
    case 'resource':
      return { type: 'resource', uri: text(subject.uri) ?? '' }
  }
}

function semanticAnswerSpec(
  answerSpec: InteractionRequest['answerSpec'],
): Readonly<Record<string, unknown>> {
  return {
    fields: answerSpec.fields.map((field) => {
      const base = {
        type: field.type,
        name: text(field.name) ?? '',
        label: text(field.label) ?? '',
        ...(field.required === undefined ? {} : { required: field.required }),
      }
      switch (field.type) {
        case 'text':
          return {
            ...base,
            ...(field.multiline === undefined ? {} : { multiline: field.multiline }),
            ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
          }
        case 'number':
          return {
            ...base,
            ...(field.min === undefined ? {} : { min: field.min }),
            ...(field.max === undefined ? {} : { max: field.max }),
          }
        case 'boolean':
          return base
        case 'select':
          return {
            ...base,
            options: field.options.map((option) => ({
              value: text(option.value) ?? '',
              label: text(option.label) ?? '',
              ...(option.description === undefined
                ? {}
                : { description: text(option.description) ?? '' }),
            })),
            ...(field.multi === undefined ? {} : { multi: field.multi }),
            ...(field.allowCustom === undefined ? {} : { allowCustom: field.allowCustom }),
          }
        case 'secret':
          return {
            ...base,
            ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
          }
        default:
          return base
      }
    }),
  }
}

export function semanticPart(part: BraidMessagePart, visibleText?: string): TranscriptPartView {
  const kind: TranscriptPartView['kind'] =
    part.kind === 'tool-call'
      ? 'tool'
      : part.kind === 'tool-result'
        ? 'result'
        : part.kind === 'proposal'
          ? 'analysis'
          : part.kind === 'interaction'
            ? 'system'
            : part.kind
  return {
    id: part.id,
    kind,
    text: visibleText ?? boundVisibleText(part.text ?? part.title ?? ''),
    ...(part.status && isPartStatus(part.status) ? { status: part.status } : {}),
    ...(part.title === undefined
      ? {}
      : { subject: { type: part.kind, title: sanitizeTerminalText(part.title) } }),
    ...(part.source?.eventId === undefined ? {} : { sourceEventId: part.source.eventId }),
    ...(part.toolName === undefined ? {} : { toolName: sanitizeTerminalText(part.toolName) }),
    ...(part.callId === undefined ? {} : { callId: sanitizeTerminalText(part.callId) }),
    ...(part.input === undefined ? {} : { input: safe(part.input) }),
    ...(part.result === undefined ? {} : { result: safe(part.result) }),
    ...(part.error === undefined ? {} : { error: sanitizeTerminalText(part.error) }),
    ...(part.artifactId === undefined ? {} : { artifactId: sanitizeTerminalText(part.artifactId) }),
    ...(part.uri === undefined ? {} : { uri: sanitizeTerminalText(part.uri) }),
    ...(part.mimeType === undefined ? {} : { mimeType: sanitizeTerminalText(part.mimeType) }),
    ...(part.metadata === undefined
      ? {}
      : { metadata: safe(part.metadata) as Readonly<Record<string, unknown>> }),
  }
}

function isPartStatus(value: string): value is NonNullable<TranscriptPartView['status']> {
  return ['queued', 'running', 'complete', 'failed', 'cancelled', 'unknown'].includes(value)
}

export function semanticPayloadText(payload: Readonly<Record<string, unknown>>): string {
  const direct = payload.text ?? payload.reasoning ?? payload.finalText
  if (typeof direct === 'string') return direct
  const part = payload.part
  if (part && typeof part === 'object' && !Array.isArray(part)) {
    const value = part as Record<string, unknown>
    const partText = value.text
    if (typeof partText === 'string' && partText) return partText
  }
  for (const key of [
    'warning',
    'error',
    'interaction',
    'artifact',
    'proposal',
    'tool',
    'control',
    'queue',
    'unknown',
  ]) {
    const value = payload[key]
    if (value === undefined) continue
    if (typeof value === 'string') return value
    if (value && typeof value === 'object') {
      const candidate = value as Record<string, unknown>
      for (const field of [
        'message',
        'prompt',
        'title',
        'name',
        'detail',
        'status',
        'text',
        'uri',
        'reason',
      ]) {
        if (typeof candidate[field] === 'string') return candidate[field] as string
      }
      return JSON.stringify(value)
    }
  }
  return ''
}
