import type { InteractionResponse } from '@tangle-network/agent-interface'
import { AppError } from '../../app/application.js'
import { assertBoundedString, MAX_ID_BYTES } from '../../domain/bounds.js'
import type { CancelInteractionRequest, RespondInteractionRequest } from './protocol.js'

type InteractionCommand = 'respond_interaction' | 'cancel_interaction'

const BINDING_FIELDS = [
  'runId',
  'interactionId',
  'providerSessionId',
  'profileDigest',
  'connectionId',
  'workspaceId',
  'conversationId',
  'branchId',
  'model',
  'runner',
  'requestRevision',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown) throw new AppError('INVALID_PARAMS', `${label} contains unknown field ${unknown}`)
}

function boundedId(value: string, label: string): void {
  try {
    assertBoundedString(value, label, MAX_ID_BYTES)
  } catch (error) {
    throw new AppError(
      'INPUT_TOO_LARGE',
      error instanceof Error ? error.message : `${label} exceeds the UTF-8 byte limit`,
    )
  }
}

function interactionResponse(value: unknown): InteractionResponse {
  if (!isRecord(value)) throw new AppError('INVALID_PARAMS', 'response must be an object')
  if (typeof value.id !== 'string' || value.id.length === 0) {
    throw new AppError('INVALID_PARAMS', 'response.id must be a non-empty string')
  }
  boundedId(value.id, 'response.id')
  if (
    value.outcome !== 'accepted' &&
    value.outcome !== 'declined' &&
    value.outcome !== 'cancelled'
  ) {
    throw new AppError('INVALID_PARAMS', 'response.outcome is invalid')
  }
  if (value.data !== undefined && !isRecord(value.data)) {
    throw new AppError('INVALID_PARAMS', 'response.data must be an object')
  }
  return {
    id: value.id,
    outcome: value.outcome,
    ...(value.data === undefined ? {} : { data: value.data as InteractionResponse['data'] }),
  }
}

export function parseInteractionCommand(
  value: Record<string, unknown>,
  params: Record<string, unknown>,
  command: InteractionCommand,
): RespondInteractionRequest | CancelInteractionRequest {
  const allowed = ['version', 'requestId', 'operationId', 'command', 'params'] as const
  assertAllowedKeys(value, allowed, command)
  assertAllowedKeys(
    params,
    command === 'respond_interaction' ? [...BINDING_FIELDS, 'response'] : BINDING_FIELDS,
    `${command}.params`,
  )
  if (typeof value.operationId !== 'string' || value.operationId.length === 0) {
    throw new AppError('OPERATION_ID_REQUIRED', `${command} requires operationId`)
  }
  boundedId(value.operationId, `${command}.operationId`)
  for (const field of ['runId', 'interactionId'] as const) {
    if (typeof params[field] !== 'string' || params[field].length === 0) {
      throw new AppError('INVALID_PARAMS', `${field} must be a non-empty string`)
    }
    boundedId(params[field], field)
  }
  for (const field of BINDING_FIELDS.slice(2, -1)) {
    if (
      params[field] !== undefined &&
      (typeof params[field] !== 'string' || params[field].length === 0)
    ) {
      throw new AppError('INVALID_PARAMS', `${field} must be a non-empty string`)
    }
    if (typeof params[field] === 'string') boundedId(params[field], field)
  }
  if (
    params.requestRevision !== undefined &&
    (typeof params.requestRevision !== 'number' ||
      !Number.isSafeInteger(params.requestRevision) ||
      params.requestRevision < 1)
  ) {
    throw new AppError('INVALID_PARAMS', 'requestRevision must be a positive safe integer')
  }
  const binding = {
    runId: params.runId as string,
    interactionId: params.interactionId as string,
    ...(typeof params.providerSessionId === 'string'
      ? { providerSessionId: params.providerSessionId }
      : {}),
    ...(typeof params.profileDigest === 'string' ? { profileDigest: params.profileDigest } : {}),
    ...(typeof params.connectionId === 'string' ? { connectionId: params.connectionId } : {}),
    ...(typeof params.workspaceId === 'string' ? { workspaceId: params.workspaceId } : {}),
    ...(typeof params.conversationId === 'string' ? { conversationId: params.conversationId } : {}),
    ...(typeof params.branchId === 'string' ? { branchId: params.branchId } : {}),
    ...(typeof params.model === 'string' ? { model: params.model } : {}),
    ...(typeof params.runner === 'string' ? { runner: params.runner } : {}),
    ...(typeof params.requestRevision === 'number'
      ? { requestRevision: params.requestRevision }
      : {}),
  }
  if (command === 'cancel_interaction') {
    return {
      version: 1,
      requestId: value.requestId as string,
      operationId: value.operationId,
      command,
      params: binding,
    }
  }
  return {
    version: 1,
    requestId: value.requestId as string,
    operationId: value.operationId,
    command,
    params: { ...binding, response: interactionResponse(params.response) },
  }
}
