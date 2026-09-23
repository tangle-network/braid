import {
  InteractionAnswerSpecSchema,
  InteractionRequestSchema,
  PERMISSION_GRANT_FIELD,
  validateInteractionAnswer,
  type InteractionAnswerSpec,
  type InteractionData,
  type InteractionResponse,
  type InteractionSubject,
} from '@tangle-network/agent-interface'
import { canonicalDigest } from './canonical.js'
import {
  assertBoundedStructure,
  boundedText as boundedUtf8Text,
  BoundError,
  MAX_INTERACTION_FIELDS,
  MAX_INTERACTION_TIMEOUT_MS,
  MAX_RPC_LINE_BYTES,
  MAX_SELECT_OPTIONS,
  MAX_TEXT_BYTES,
} from './bounds.js'
import { keyedDigest } from './identity.js'
import { sanitizeTerminalText } from '../views/shared/sanitize.js'

export type InteractionOutcome = 'accepted' | 'declined' | 'cancelled'

export type SafeInteractionSubject =
  | { readonly type: 'tool'; readonly toolName: string }
  | { readonly type: 'command'; readonly command: string }
  | { readonly type: 'file'; readonly path: string; readonly preview?: string }
  | { readonly type: 'resource'; readonly uri: string }

/**
 * The application projection of a provider request.
 *
 * The canonical request remains the transport contract. This projection is
 * deliberately smaller: provider-owned tool input is never durable, and all
 * user-facing strings are bounded and terminal-safe before a view sees them.
 */
export interface SafeInteractionRequest {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly body?: string
  readonly subject?: SafeInteractionSubject
  readonly answerSpec: InteractionAnswerSpec
  readonly default?: {
    readonly outcome: InteractionOutcome
    readonly data?: NonSecretInteractionData
  }
  readonly timeoutMs?: number
  readonly onTimeout?: 'default' | 'fail' | 'wait'
}

export type NonSecretInteractionValue = string | number | boolean | readonly string[]
export type NonSecretInteractionData = Readonly<Record<string, NonSecretInteractionValue>>

export interface InteractionValidationSuccess {
  readonly ok: true
  readonly containsSecret: boolean
  readonly publicData: NonSecretInteractionData
  readonly dataDigest?: string
}

export interface InteractionValidationFailure {
  readonly ok: false
  readonly errors: readonly string[]
}

export type InteractionDataValidation = InteractionValidationSuccess | InteractionValidationFailure

export interface ParsedInteractionRequest {
  readonly ok: true
  readonly request: SafeInteractionRequest
  readonly safeRequest: SafeInteractionRequest
  readonly containsSecret: boolean
}

export interface InvalidInteractionRequest {
  readonly ok: false
  readonly errors: readonly string[]
}

export type InteractionRequestValidation = ParsedInteractionRequest | InvalidInteractionRequest

function boundedText(value: string, limit = 16_384): string {
  const safe = sanitizeTerminalText(value)
  return boundedUtf8Text(safe, Math.min(limit, MAX_TEXT_BYTES))
}

function safeSubject(subject: InteractionSubject | undefined): SafeInteractionSubject | undefined {
  if (!subject) return undefined
  switch (subject.type) {
    case 'tool':
      return { type: 'tool', toolName: boundedText(subject.toolName, 512) }
    case 'command':
      return { type: 'command', command: boundedText(subject.command, 4_096) }
    case 'file':
      return {
        type: 'file',
        path: boundedText(subject.path, 4_096),
        ...(subject.preview === undefined ? {} : { preview: boundedText(subject.preview) }),
      }
    case 'resource':
      return { type: 'resource', uri: boundedText(subject.uri, 4_096) }
    default: {
      const exhaustive: never = subject
      return exhaustive
    }
  }
}

function subjectTarget(subject: SafeInteractionSubject): string {
  switch (subject.type) {
    case 'tool':
      return subject.toolName
    case 'command':
      return subject.command
    case 'file':
      return subject.path
    case 'resource':
      return subject.uri
    default: {
      const exhaustive: never = subject
      return exhaustive
    }
  }
}

function safeAnswerSpec(spec: InteractionAnswerSpec): InteractionAnswerSpec {
  return {
    fields: spec.fields.map((field) => {
      switch (field.type) {
        case 'text':
          return {
            ...field,
            name: boundedText(field.name, 256),
            label: boundedText(field.label, 512),
            ...(field.placeholder === undefined
              ? {}
              : { placeholder: boundedText(field.placeholder, 512) }),
            ...(field.default === undefined ? {} : { default: boundedText(field.default) }),
          }
        case 'number':
          return {
            ...field,
            name: boundedText(field.name, 256),
            label: boundedText(field.label, 512),
          }
        case 'boolean':
          return {
            ...field,
            name: boundedText(field.name, 256),
            label: boundedText(field.label, 512),
          }
        case 'select':
          return {
            ...field,
            name: boundedText(field.name, 256),
            label: boundedText(field.label, 512),
            options: field.options.map((option) => ({
              value: boundedText(option.value, 512),
              label: boundedText(option.label, 512),
              ...(option.description === undefined
                ? {}
                : { description: boundedText(option.description, 2_048) }),
            })),
            ...(field.default === undefined
              ? {}
              : { default: field.default.map((value) => boundedText(value, 512)) }),
          }
        case 'secret':
          return {
            ...field,
            name: boundedText(field.name, 256),
            label: boundedText(field.label, 512),
            ...(field.placeholder === undefined
              ? {}
              : { placeholder: boundedText(field.placeholder, 512) }),
          }
        default: {
          const exhaustive: never = field
          return exhaustive
        }
      }
    }),
  }
}

export interface AnswerSpecValidationSuccess {
  readonly ok: true
}

export interface AnswerSpecValidationFailure {
  readonly ok: false
  readonly errors: readonly string[]
}

export type AnswerSpecValidation = AnswerSpecValidationSuccess | AnswerSpecValidationFailure

/** Validate the canonical shape plus invariants the shared schema leaves open. */
export function validateAnswerSpec(input: unknown): AnswerSpecValidation {
  try {
    assertBoundedStructure(input, {
      maxBytes: MAX_TEXT_BYTES,
      maxTotalBytes: MAX_RPC_LINE_BYTES,
      maxDepth: 12,
      maxArrayLength: MAX_INTERACTION_FIELDS,
      maxObjectKeys: MAX_INTERACTION_FIELDS,
      maxFields: MAX_INTERACTION_FIELDS * 2,
    })
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : 'Answer specification is too large'],
    }
  }
  const parsed = InteractionAnswerSpecSchema.safeParse(input)
  if (!parsed.success) return { ok: false, errors: ['Invalid answer specification'] }
  if (parsed.data.fields.length > MAX_INTERACTION_FIELDS) {
    return { ok: false, errors: ['Answer specification contains too many fields'] }
  }
  const names = new Set<string>()
  for (const field of parsed.data.fields) {
    if (!field.name || names.has(field.name)) {
      return {
        ok: false,
        errors: ['Answer specification field names must be unique and non-empty'],
      }
    }
    if (!field.label) {
      return { ok: false, errors: ['Answer specification field labels must be non-empty'] }
    }
    names.add(field.name)
    if (field.type === 'number') {
      if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
        return { ok: false, errors: ['Answer specification number bounds are invalid'] }
      }
    }
    if (field.type === 'select') {
      if (field.options.length > MAX_SELECT_OPTIONS) {
        return { ok: false, errors: ['Answer specification contains too many select options'] }
      }
      const optionValues = new Set<string>()
      for (const option of field.options) {
        if (!option.value || !option.label || optionValues.has(option.value)) {
          return {
            ok: false,
            errors: ['Answer specification select options must be unique and non-empty'],
          }
        }
        optionValues.add(option.value)
      }
      if (!field.multi && field.default !== undefined && field.default.length > 1) {
        return { ok: false, errors: ['Answer specification single-select defaults are invalid'] }
      }
      if (field.default?.some((value) => !optionValues.has(value) && field.allowCustom !== true)) {
        return { ok: false, errors: ['Answer specification select defaults are invalid'] }
      }
    }
  }
  return { ok: true }
}

export function answerSpecContainsSecret(spec: InteractionAnswerSpec): boolean {
  return spec.fields.some((field) => field.type === 'secret')
}

export function interactionAnswerTypes(
  spec: InteractionAnswerSpec,
): readonly InteractionAnswerSpec['fields'][number]['type'][] {
  return [...new Set(spec.fields.map((field) => field.type))]
}

export function parseInteractionRequest(input: unknown): InteractionRequestValidation {
  try {
    assertBoundedStructure(input, {
      maxBytes: MAX_TEXT_BYTES,
      maxTotalBytes: MAX_RPC_LINE_BYTES,
      maxDepth: 16,
      maxArrayLength: MAX_INTERACTION_FIELDS,
      maxObjectKeys: MAX_INTERACTION_FIELDS,
      maxFields: MAX_INTERACTION_FIELDS * 4,
    })
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof BoundError ? error.message : 'Interaction request is too large'],
    }
  }
  const parsed = InteractionRequestSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, errors: ['Interaction request is not a valid canonical request'] }
  }
  const request = parsed.data
  if (
    request.timeoutMs !== undefined &&
    (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs > MAX_INTERACTION_TIMEOUT_MS)
  ) {
    return { ok: false, errors: ['Interaction timeout is outside the supported bound'] }
  }
  const spec = safeAnswerSpec(request.answerSpec)
  const specValidation = validateAnswerSpec(spec)
  if (!specValidation.ok) return specValidation
  const containsSecret = answerSpecContainsSecret(spec)
  const safeSubjectValue = request.subject === undefined ? undefined : safeSubject(request.subject)
  const safeKind = boundedText(request.kind, 256)
  const safeTitle = boundedText(request.title, 4_096)
  const safeId = boundedText(request.id, 512)
  if (!safeId || !safeKind || !safeTitle) {
    return { ok: false, errors: ['Interaction request text is not renderable'] }
  }
  if (safeSubjectValue && !subjectTarget(safeSubjectValue)) {
    return { ok: false, errors: ['Interaction subject is not renderable'] }
  }
  const defaultValidation = request.default
    ? validateInteractionData(spec, request.default.outcome, request.default.data)
    : undefined
  if (
    request.default !== undefined &&
    (defaultValidation === undefined || !defaultValidation.ok || defaultValidation.containsSecret)
  ) {
    return { ok: false, errors: ['Interaction request contains an invalid default answer'] }
  }
  const safeRequest: SafeInteractionRequest = {
    id: safeId,
    kind: safeKind,
    title: safeTitle,
    ...(request.body === undefined ? {} : { body: boundedText(request.body) }),
    ...(safeSubjectValue === undefined ? {} : { subject: safeSubjectValue }),
    answerSpec: spec,
    ...(defaultValidation?.ok && !defaultValidation.containsSecret && request.default
      ? {
          default: {
            outcome: request.default.outcome,
            ...(Object.keys(defaultValidation.publicData).length === 0
              ? {}
              : { data: defaultValidation.publicData }),
          },
        }
      : {}),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(request.onTimeout === undefined ? {} : { onTimeout: request.onTimeout }),
  }
  return {
    ok: true,
    request: safeRequest,
    safeRequest,
    containsSecret,
  }
}

function isInteractionValue(value: unknown): value is NonSecretInteractionValue {
  if (typeof value === 'string' || typeof value === 'boolean') {
    return true
  }
  if (typeof value === 'number') return Number.isFinite(value)
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string')
}

function safeInteractionValue(value: NonSecretInteractionValue): NonSecretInteractionValue {
  if (typeof value === 'string') return boundedText(value)
  if (Array.isArray(value)) return value.map((item) => boundedText(item, 4_096))
  return value
}

export function publicInteractionData(
  spec: InteractionAnswerSpec,
  data: InteractionData | undefined,
): NonSecretInteractionData {
  const secretFields = new Set(
    spec.fields.filter((field) => field.type === 'secret').map((field) => field.name),
  )
  const result: Record<string, NonSecretInteractionValue> = {}
  for (const [name, value] of Object.entries(data ?? {})) {
    if (secretFields.has(name) || !isInteractionValue(value)) continue
    result[name] = safeInteractionValue(value)
  }
  return result
}

/** Convert a redacted projection back to the mutable wire shape for one call. */
export function canonicalInteractionData(data: NonSecretInteractionData): InteractionData {
  return Object.fromEntries(
    Object.entries(data).map(([name, value]) => [name, Array.isArray(value) ? [...value] : value]),
  ) as InteractionData
}

export function validateInteractionData(
  spec: InteractionAnswerSpec,
  outcome: InteractionOutcome,
  data: InteractionData | undefined,
): InteractionDataValidation {
  try {
    assertBoundedStructure(data ?? {}, {
      maxBytes: MAX_TEXT_BYTES,
      maxTotalBytes: MAX_TEXT_BYTES,
      maxDepth: 8,
      maxArrayLength: MAX_INTERACTION_FIELDS,
      maxObjectKeys: MAX_INTERACTION_FIELDS,
      maxFields: MAX_INTERACTION_FIELDS,
    })
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : 'Answer is too large'] }
  }
  if (outcome !== 'accepted') {
    if (data !== undefined && Object.keys(data).length > 0) {
      return { ok: false, errors: ['Only accepted interactions may include answer data'] }
    }
    return {
      ok: true,
      containsSecret: false,
      publicData: {},
      dataDigest: canonicalDigest({}),
    }
  }

  if (Object.values(data ?? {}).some((value) => !isInteractionValue(value))) {
    return { ok: false, errors: ['Answer contains an unsupported value'] }
  }

  const validation = validateInteractionAnswer(spec, data)
  if (!validation.ok)
    return { ok: false, errors: ['Answer does not match the answer specification'] }

  const knownFields = new Set(spec.fields.map((field) => field.name))
  const unknownField = Object.keys(data ?? {}).find((name) => !knownFields.has(name))
  if (unknownField) return { ok: false, errors: ['Answer contains an unknown field'] }

  const containsSecret = answerSpecContainsSecret(spec)
  const publicData = publicInteractionData(spec, data)
  return {
    ok: true,
    containsSecret,
    publicData,
    ...(containsSecret ? {} : { dataDigest: canonicalDigest(data ?? {}) }),
  }
}

export function interactionResponseDigest(
  request: SafeInteractionRequest,
  response: Pick<InteractionResponse, 'outcome' | 'data'>,
): string | undefined {
  if (answerSpecContainsSecret(request.answerSpec)) return undefined
  return canonicalDigest({ outcome: response.outcome, data: response.data ?? {} })
}

export function interactionRequestDigest(request: SafeInteractionRequest): string {
  return canonicalDigest({ schema: 'braid.interaction-request.v1', request })
}

export function interactionResponseFingerprint(
  request: SafeInteractionRequest,
  response: Pick<InteractionResponse, 'outcome' | 'data'>,
  secretKey: string | Uint8Array,
): string {
  const value = { outcome: response.outcome, data: response.data ?? {} }
  return answerSpecContainsSecret(request.answerSpec)
    ? keyedDigest(value, secretKey)
    : canonicalDigest(value)
}

export type PermissionScope = 'once' | 'session' | 'persistent' | 'deny'

export function offeredPermissionScopes(
  request: Pick<SafeInteractionRequest, 'answerSpec' | 'kind'>,
): readonly PermissionScope[] {
  if (request.kind !== 'permission') return []
  const field = request.answerSpec.fields.find(
    (candidate) => candidate.name === PERMISSION_GRANT_FIELD && candidate.type === 'select',
  )
  if (field?.type !== 'select') return []
  const scopes: PermissionScope[] = []
  for (const option of field.options) {
    if (option.value === 'allow_once') scopes.push('once')
    if (option.value === 'allow_session') scopes.push('session')
    if (option.value === 'allow_always') scopes.push('persistent')
    if (option.value === 'deny') scopes.push('deny')
  }
  return scopes
}

export function permissionScopeOffered(
  request: Pick<SafeInteractionRequest, 'answerSpec' | 'kind'>,
  scope: PermissionScope,
): boolean {
  return offeredPermissionScopes(request).includes(scope)
}
