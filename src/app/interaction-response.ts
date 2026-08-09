import {
  InteractionResponseCommandSchema,
  InteractionResponseSchema,
  interactionResponseCommandDigest,
  type InteractionBinding,
  validateInteractionResponse,
  type InteractionDataValue,
  type InteractionRequest,
  type InteractionResponse,
  type InteractionResponseCommand,
} from '@tangle-network/agent-interface'
import { canonicalDigest } from '../domain/canonical.js'
import type {
  NonSecretInteractionData,
  NonSecretInteractionValue,
} from '../domain/entities-interactions.js'
import { AppError } from './errors.js'

const MAX_FIELDS = 64
const MAX_NAME_BYTES = 256
const MAX_VALUE_BYTES = 64 * 1024
const MAX_ARRAY_ITEMS = 128

export interface CheckedInteractionResponse {
  readonly response: InteractionResponse
  readonly publicData?: NonSecretInteractionData
  readonly dataDigest?: string
  readonly containsSecret: boolean
}

export function interactionHasSecretField(request: InteractionRequest): boolean {
  return request.answerSpec.fields.some(
    (field) => field.type === 'secret' || isSecretName(field.name),
  )
}

export function checkInteractionResponse(
  request: InteractionRequest,
  response: unknown,
): CheckedInteractionResponse {
  const parsed = InteractionResponseSchema.safeParse(response)
  if (!parsed.success)
    throw new AppError('INVALID_INTERACTION_RESPONSE', 'Interaction response is invalid')
  const bounded = boundResponse(applyDefaults(request, parsed.data))
  const validation = validateInteractionResponse(request, bounded)
  if (!validation.ok)
    throw new AppError(
      'INVALID_INTERACTION_RESPONSE',
      `Interaction response does not match its answer specification (${validation.errors.length} validation error${validation.errors.length === 1 ? '' : 's'})`,
    )
  const secretNames = new Set(
    request.answerSpec.fields
      .filter((field) => field.type === 'secret' || isSecretName(field.name))
      .map((field) => field.name),
  )
  const containsSecret =
    interactionHasSecretField(request) ||
    Object.entries(bounded.data ?? {}).some(
      ([name, value]) => secretNames.has(name) || isSecretReference(value),
    )
  const publicData = containsSecret ? undefined : publicInteractionData(bounded.data)
  return {
    response: bounded,
    ...(publicData === undefined ? {} : { publicData, dataDigest: canonicalDigest(publicData) }),
    containsSecret,
  }
}

export function createInteractionResponseCommand(
  binding: InteractionBinding,
  operationId: string,
  response: InteractionResponse,
): InteractionResponseCommand {
  const material = { binding, response }
  const command: InteractionResponseCommand = {
    operationId,
    binding,
    response,
    commandDigest: interactionResponseCommandDigest(material),
  }
  const parsed = InteractionResponseCommandSchema.safeParse(command)
  if (!parsed.success)
    throw new AppError('INVALID_INTERACTION_RESPONSE', 'Interaction response command is invalid')
  return command
}

function applyDefaults(
  request: InteractionRequest,
  response: InteractionResponse,
): InteractionResponse {
  if (response.outcome !== 'accepted') return response
  const data: Record<string, InteractionDataValue> = cloneInteractionData(response.data)
  let changed = response.data !== undefined
  for (const field of request.answerSpec.fields) {
    if (data[field.name] !== undefined || !('default' in field) || field.default === undefined)
      continue
    data[field.name] = Array.isArray(field.default) ? [...field.default] : field.default
    changed = true
  }
  return changed ? { ...response, data } : response
}

function boundResponse(response: InteractionResponse): InteractionResponse {
  if (Buffer.byteLength(response.id, 'utf8') > MAX_NAME_BYTES)
    throw new AppError('INVALID_INTERACTION_RESPONSE', 'Interaction id is too long')
  if (response.data === undefined) return { id: response.id, outcome: response.outcome }
  const entries = Object.entries(response.data)
  if (entries.length > MAX_FIELDS)
    throw new AppError('INVALID_INTERACTION_RESPONSE', 'Interaction response has too many fields')
  const data: Record<string, InteractionDataValue> = {}
  for (const [name, value] of entries) {
    if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES)
      throw new AppError('INVALID_INTERACTION_RESPONSE', 'Interaction field name is too long')
    if (typeof value === 'string') {
      if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES)
        throw new AppError('INVALID_INTERACTION_RESPONSE', 'Interaction response text is too long')
      data[name] = value
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      if (typeof value === 'number' && !Number.isFinite(value))
        throw new AppError('INVALID_INTERACTION_RESPONSE', 'Interaction number is not finite')
      data[name] = value
    } else if (
      Array.isArray(value) &&
      value.length <= MAX_ARRAY_ITEMS &&
      value.every((item) => typeof item === 'string')
    ) {
      if (value.some((item) => Buffer.byteLength(item, 'utf8') > MAX_VALUE_BYTES))
        throw new AppError('INVALID_INTERACTION_RESPONSE', 'Interaction option is too long')
      data[name] = value.slice()
    } else if (isSecretReference(value)) {
      if (Buffer.byteLength(value.handleId, 'utf8') > MAX_NAME_BYTES)
        throw new AppError('INVALID_INTERACTION_RESPONSE', 'Interaction secret handle is too long')
      data[name] = { kind: 'secret_handle', handleId: value.handleId, oneUse: true }
    } else {
      throw new AppError('INVALID_INTERACTION_RESPONSE', 'Interaction response data is not bounded')
    }
  }
  return { id: response.id, outcome: response.outcome, data }
}

function cloneInteractionData(
  data: InteractionResponse['data'],
): Record<string, InteractionDataValue> {
  const clone: Record<string, InteractionDataValue> = {}
  for (const [name, value] of Object.entries(data ?? {}))
    clone[name] = Array.isArray(value)
      ? [...value]
      : isSecretReference(value)
        ? { kind: 'secret_handle', handleId: value.handleId, oneUse: true }
        : value
  return clone
}

function publicInteractionData(
  data: InteractionResponse['data'],
): NonSecretInteractionData | undefined {
  if (data === undefined) return undefined
  const result: Record<string, NonSecretInteractionValue> = {}
  for (const [name, value] of Object.entries(data)) {
    if (isSecretReference(value)) return undefined
    result[name] = Array.isArray(value) ? [...value] : value
  }
  return result
}

function isSecretReference(
  value: InteractionDataValue,
): value is Extract<InteractionDataValue, { readonly kind: 'secret_handle' }> {
  return typeof value === 'object' && !Array.isArray(value)
}

function isSecretName(name: string): boolean {
  return /(?:password|passphrase|token|secret|credential|authorization|cookie|private|api[_-]?key)/iu.test(
    name,
  )
}
