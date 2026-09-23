import {
  InteractionAnswerSpecSchema,
  type InteractionAnswerSpec,
} from '@tangle-network/agent-interface'
import type { InteractionCapabilities, InteractionRecord } from '../../domain/interaction-state.js'
import {
  offeredPermissionScopes,
  validateAnswerSpec,
  type PermissionScope,
} from '../../domain/interaction.js'
import { sanitizeTerminalText } from './sanitize.js'

export type InteractionSurface = 'question' | 'permission' | 'plan' | 'generic'

const KNOWN_INTERACTION_KINDS = new Set(['question', 'permission', 'plan'])

export type AnswerFieldView =
  | {
      readonly type: 'text'
      readonly name: string
      readonly label: string
      readonly required: boolean
      readonly multiline: boolean
      readonly placeholder?: string
      readonly defaultValue?: string
      readonly masked: false
    }
  | {
      readonly type: 'number'
      readonly name: string
      readonly label: string
      readonly required: boolean
      readonly minimum?: number
      readonly maximum?: number
      readonly defaultValue?: number
      readonly masked: false
    }
  | {
      readonly type: 'boolean'
      readonly name: string
      readonly label: string
      readonly required: boolean
      readonly defaultValue?: boolean
      readonly masked: false
    }
  | {
      readonly type: 'select'
      readonly name: string
      readonly label: string
      readonly required: boolean
      readonly multi: boolean
      readonly allowCustom: boolean
      readonly options: readonly {
        readonly value: string
        readonly label: string
        readonly description?: string
      }[]
      readonly defaultValue?: readonly string[]
      readonly masked: false
    }
  | {
      readonly type: 'secret'
      readonly name: string
      readonly label: string
      readonly required: boolean
      readonly placeholder?: string
      readonly masked: true
    }

export interface AnswerSpecView {
  readonly valid: boolean
  readonly containsSecret: boolean
  readonly supported: boolean
  readonly fields: readonly AnswerFieldView[]
  readonly error?: string
}

export interface InteractionSubjectView {
  readonly type: string
  readonly title: string
  readonly target?: string
  readonly detail?: string
  readonly preview?: string
}

export interface InteractionViewModel {
  readonly key: string
  readonly runId: string
  readonly interactionId: string
  readonly providerSessionId?: string
  readonly profileDigest?: string
  readonly connectionId?: string
  readonly workspaceId?: string
  readonly conversationId?: string
  readonly branchId?: string
  readonly model?: string
  readonly runner?: string
  readonly requestRevision?: number
  readonly kind: string
  readonly surface: InteractionSurface
  readonly title: string
  readonly body?: string
  readonly subject?: InteractionSubjectView
  readonly answerSpec: AnswerSpecView
  readonly status: InteractionRecord['status']
  readonly queuePosition: number
  readonly waitingCount: number
  readonly remainingMs?: number
  readonly allowedScopes: readonly PermissionScope[]
  readonly canRespond: boolean
  readonly canCancel: boolean
  readonly capabilityError?: string
}

function freeze<T>(value: T): Readonly<T> {
  const seen = new WeakSet<object>()
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== 'object' || seen.has(candidate)) return
    seen.add(candidate)
    for (const child of Object.values(candidate)) visit(child)
    Object.freeze(candidate)
  }
  visit(value)
  return value as Readonly<T>
}

function text(value: string, limit = 4_096): string {
  const sanitized = sanitizeTerminalText(value)
  return sanitized.length <= limit ? sanitized : `${sanitized.slice(0, limit)}…`
}

function buildFieldView(field: InteractionAnswerSpec['fields'][number]): AnswerFieldView {
  switch (field.type) {
    case 'text':
      return {
        type: 'text',
        name: text(field.name, 256),
        label: text(field.label, 512),
        required: field.required === true,
        multiline: field.multiline === true,
        ...(field.placeholder === undefined ? {} : { placeholder: text(field.placeholder, 512) }),
        ...(field.default === undefined ? {} : { defaultValue: text(field.default) }),
        masked: false,
      }
    case 'number':
      return {
        type: 'number',
        name: text(field.name, 256),
        label: text(field.label, 512),
        required: field.required === true,
        ...(field.min === undefined ? {} : { minimum: field.min }),
        ...(field.max === undefined ? {} : { maximum: field.max }),
        ...(field.default === undefined ? {} : { defaultValue: field.default }),
        masked: false,
      }
    case 'boolean':
      return {
        type: 'boolean',
        name: text(field.name, 256),
        label: text(field.label, 512),
        required: field.required === true,
        ...(field.default === undefined ? {} : { defaultValue: field.default }),
        masked: false,
      }
    case 'select':
      return {
        type: 'select',
        name: text(field.name, 256),
        label: text(field.label, 512),
        required: field.required === true,
        multi: field.multi === true,
        allowCustom: field.allowCustom === true,
        options: field.options.map((option) => ({
          value: text(option.value, 512),
          label: text(option.label, 512),
          ...(option.description === undefined
            ? {}
            : { description: text(option.description, 2_048) }),
        })),
        ...(field.default === undefined ? {} : { defaultValue: field.default }),
        masked: false,
      }
    case 'secret':
      return {
        type: 'secret',
        name: text(field.name, 256),
        label: text(field.label, 512),
        required: field.required === true,
        ...(field.placeholder === undefined ? {} : { placeholder: text(field.placeholder, 512) }),
        masked: true,
      }
    default: {
      const exhaustive: never = field
      return exhaustive
    }
  }
}

export function buildAnswerSpecView(input: unknown): AnswerSpecView {
  return buildAnswerSpecViewForCapabilities(input)
}

function buildAnswerSpecViewForCapabilities(
  input: unknown,
  capabilities?: InteractionCapabilities,
): AnswerSpecView {
  const parsed = InteractionAnswerSpecSchema.safeParse(input)
  if (!parsed.success) {
    return freeze({
      valid: false,
      containsSecret: false,
      supported: false,
      fields: [],
      error: 'This interaction has an invalid answer specification and can only be cancelled.',
    })
  }
  const spec = parsed.data
  const specValidation = validateAnswerSpec(spec)
  if (!specValidation.ok) {
    return freeze({
      valid: false,
      containsSecret: spec.fields.some((field) => field.type === 'secret'),
      supported: false,
      fields: [],
      error: 'This interaction has an invalid answer specification and can only be cancelled.',
    })
  }
  const unsupported = capabilities
    ? spec.fields
        .filter((field) => !capabilities.answerTypes.includes(field.type))
        .map((field) => field.type)
    : []
  const unsupportedTypes = [...new Set(unsupported)]
  return freeze({
    valid: true,
    supported: unsupportedTypes.length === 0,
    containsSecret: spec.fields.some((field) => field.type === 'secret'),
    fields: spec.fields.map(buildFieldView),
    ...(unsupportedTypes.length === 0
      ? {}
      : {
          error: `This provider does not support ${unsupportedTypes.join(', ')} answers; cancel is available.`,
        }),
  })
}

function subjectView(record: InteractionRecord): InteractionSubjectView | undefined {
  const subject = record.request.subject
  if (!subject) return undefined
  switch (subject.type) {
    case 'tool':
      return { type: 'tool', title: 'Tool request', target: text(subject.toolName, 512) }
    case 'command':
      return { type: 'command', title: 'Command request', target: text(subject.command, 4_096) }
    case 'file':
      return {
        type: 'file',
        title: 'File request',
        target: text(subject.path, 4_096),
        ...(subject.preview === undefined ? {} : { preview: text(subject.preview) }),
      }
    case 'resource':
      return { type: 'resource', title: 'Resource request', target: text(subject.uri, 4_096) }
    default: {
      const exhaustive: never = subject
      return exhaustive
    }
  }
}

function surfaceFor(kind: string): InteractionSurface {
  if (kind === 'question') return 'question'
  if (kind === 'permission') return 'permission'
  if (kind === 'plan') return 'plan'
  return 'generic'
}

function remainingMs(record: InteractionRecord, now: string): number | undefined {
  if (!record.deadlineAt) return undefined
  const deadline = Date.parse(record.deadlineAt)
  const current = Date.parse(now)
  if (!Number.isFinite(deadline) || !Number.isFinite(current)) return undefined
  return Math.max(0, deadline - current)
}

export function buildInteractionView(
  record: InteractionRecord,
  pending: readonly InteractionRecord[],
  now: string,
  capabilities?: InteractionCapabilities,
): InteractionViewModel {
  const ordered = pending
    .concat(
      record.status === 'responding' && !pending.some((item) => item.key === record.key)
        ? [record]
        : [],
    )
    .sort((left, right) => left.arrivalSequence - right.arrivalSequence)
  const queuePosition = ordered.findIndex((item) => item.key === record.key)
  const active = record.status === 'pending'
  const subject = subjectView(record)
  const remaining = remainingMs(record, now)
  const answerSpec = buildAnswerSpecViewForCapabilities(record.request.answerSpec, capabilities)
  const unsupportedKind = capabilities && !capabilities.kinds.includes(record.request.kind)
  const unknownKind = !KNOWN_INTERACTION_KINDS.has(record.request.kind)
  const supportsSecret = !answerSpec.containsSecret || capabilities?.secretAnswers !== false
  const serialQueueBlocked =
    capabilities?.concurrentRequests === false && ordered[0]?.key !== record.key
  const allowedScopes = capabilities
    ? offeredPermissionScopes(record.request).filter((scope) => capabilities.scopes.includes(scope))
    : offeredPermissionScopes(record.request)
  const permissionScopeUnavailable =
    record.request.kind === 'permission' && allowedScopes.length === 0
  return freeze({
    key: record.key,
    runId: record.runId,
    interactionId: record.interactionId,
    ...(record.providerSessionId === undefined
      ? {}
      : { providerSessionId: record.providerSessionId }),
    ...(record.profileDigest === undefined ? {} : { profileDigest: record.profileDigest }),
    ...(record.connectionId === undefined ? {} : { connectionId: record.connectionId }),
    ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
    ...(record.conversationId === undefined ? {} : { conversationId: record.conversationId }),
    ...(record.branchId === undefined ? {} : { branchId: record.branchId }),
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(record.runner === undefined ? {} : { runner: record.runner }),
    ...(record.requestRevision === undefined ? {} : { requestRevision: record.requestRevision }),
    kind: text(record.request.kind, 256),
    surface: surfaceFor(record.request.kind),
    title: text(record.request.title),
    ...(record.request.body === undefined ? {} : { body: text(record.request.body) }),
    ...(subject === undefined ? {} : { subject }),
    answerSpec,
    status: record.status,
    queuePosition: queuePosition < 0 ? -1 : queuePosition + 1,
    waitingCount: ordered.length,
    ...(remaining === undefined ? {} : { remainingMs: remaining }),
    allowedScopes,
    canRespond:
      active &&
      answerSpec.valid &&
      answerSpec.supported &&
      supportsSecret &&
      !permissionScopeUnavailable &&
      !unsupportedKind &&
      !unknownKind &&
      !serialQueueBlocked,
    canCancel: active,
    ...(unknownKind
      ? {
          capabilityError:
            'This interaction kind is not supported by Braid and can only be cancelled.',
        }
      : unsupportedKind
        ? { capabilityError: `This provider does not support ${record.request.kind} interactions.` }
        : !supportsSecret
          ? { capabilityError: 'This provider cannot receive secret answers.' }
          : permissionScopeUnavailable
            ? {
                capabilityError:
                  'This provider does not support any permission scope offered by the request.',
              }
            : serialQueueBlocked
              ? {
                  capabilityError:
                    'This provider accepts one interaction at a time; respond to the first request.',
                }
              : {}),
  })
}

export function buildQuestionView(
  record: InteractionRecord,
  pending: readonly InteractionRecord[],
  now: string,
  capabilities?: InteractionCapabilities,
): InteractionViewModel {
  return buildInteractionView(record, pending, now, capabilities)
}

export function buildPermissionView(
  record: InteractionRecord,
  pending: readonly InteractionRecord[],
  now: string,
  capabilities?: InteractionCapabilities,
): InteractionViewModel {
  return buildInteractionView(record, pending, now, capabilities)
}

export function buildPlanView(
  record: InteractionRecord,
  pending: readonly InteractionRecord[],
  now: string,
  capabilities?: InteractionCapabilities,
): InteractionViewModel {
  return buildInteractionView(record, pending, now, capabilities)
}

export function buildInteractionViews(
  state: { readonly interactions: readonly InteractionRecord[] },
  now: string,
  capabilities?: InteractionCapabilities,
): readonly InteractionViewModel[] {
  const active = state.interactions
    .filter(
      (interaction) => interaction.status === 'pending' || interaction.status === 'responding',
    )
    .sort((left, right) => left.arrivalSequence - right.arrivalSequence)
  return freeze(
    active
      .sort((left, right) => left.arrivalSequence - right.arrivalSequence)
      .map((interaction) => buildInteractionView(interaction, active, now, capabilities)),
  )
}
