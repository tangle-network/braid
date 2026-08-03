import type { InteractionResponse } from '@tangle-network/agent-interface'
import { AppError } from '../../app/application.js'
import { BRAID_PROTOCOL_VERSION, type BraidRequest } from './protocol.js'

export interface RpcInput extends AsyncIterable<string | Uint8Array> {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function interactionResponse(value: unknown): InteractionResponse {
  if (!isRecord(value)) throw new AppError('INVALID_PARAMS', 'response must be an object')
  if (typeof value.id !== 'string' || value.id.length === 0) {
    throw new AppError('INVALID_PARAMS', 'response.id must be a non-empty string')
  }
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

export function requestIdOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  return typeof value.requestId === 'string' ? value.requestId : undefined
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown) throw new AppError('INVALID_PARAMS', `${label} contains unknown field ${unknown}`)
}

export function parseRpcRequest(line: string): BraidRequest {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new AppError('MALFORMED_JSON', 'Input is not valid JSON')
  }
  if (!isRecord(value)) throw new AppError('INVALID_REQUEST', 'Request must be an object')
  if (value.version !== BRAID_PROTOCOL_VERSION) {
    throw new AppError('UNSUPPORTED_VERSION', 'Only protocol version 1 is supported')
  }
  if (typeof value.requestId !== 'string' || value.requestId.length === 0) {
    throw new AppError('INVALID_REQUEST_ID', 'requestId must be a non-empty string')
  }
  if (typeof value.command !== 'string')
    throw new AppError('INVALID_COMMAND', 'command must be a string')
  if (!isRecord(value.params) && value.params !== undefined) {
    throw new AppError('INVALID_PARAMS', 'params must be an object')
  }

  const params = isRecord(value.params) ? value.params : {}
  switch (value.command) {
    case 'initialize':
      assertAllowedKeys(value, ['version', 'requestId', 'command', 'params'], 'initialize')
      assertAllowedKeys(params, ['workspace', 'subscribe'], 'initialize.params')
      if (typeof params.workspace !== 'string')
        throw new AppError('INVALID_PARAMS', 'initialize.params.workspace must be a string')
      if (params.subscribe !== undefined && typeof params.subscribe !== 'boolean') {
        throw new AppError('INVALID_PARAMS', 'initialize.params.subscribe must be a boolean')
      }
      return {
        version: 1,
        requestId: value.requestId,
        command: 'initialize',
        params: {
          workspace: params.workspace,
          ...(typeof params.subscribe === 'boolean' ? { subscribe: params.subscribe } : {}),
        },
      }
    case 'get_state':
      assertAllowedKeys(value, ['version', 'requestId', 'command', 'params'], 'get_state')
      assertAllowedKeys(params, [], 'get_state.params')
      return { version: 1, requestId: value.requestId, command: 'get_state' }
    case 'send':
      assertAllowedKeys(value, ['version', 'requestId', 'operationId', 'command', 'params'], 'send')
      assertAllowedKeys(params, ['text', 'conversationId', 'branchId'], 'send.params')
      if (typeof value.operationId !== 'string' || value.operationId.length === 0) {
        throw new AppError('OPERATION_ID_REQUIRED', 'send requires operationId')
      }
      if (typeof params.text !== 'string')
        throw new AppError('INVALID_PARAMS', 'send.params.text must be a string')
      if (params.conversationId !== undefined && typeof params.conversationId !== 'string') {
        throw new AppError('INVALID_PARAMS', 'send.params.conversationId must be a string')
      }
      if (params.branchId !== undefined && typeof params.branchId !== 'string') {
        throw new AppError('INVALID_PARAMS', 'send.params.branchId must be a string')
      }
      return {
        version: 1,
        requestId: value.requestId,
        operationId: value.operationId,
        command: 'send',
        params: {
          text: params.text,
          ...(typeof params.conversationId === 'string'
            ? { conversationId: params.conversationId }
            : {}),
          ...(typeof params.branchId === 'string' ? { branchId: params.branchId } : {}),
        },
      }
    case 'respond_interaction':
      assertAllowedKeys(
        value,
        ['version', 'requestId', 'operationId', 'command', 'params'],
        'respond_interaction',
      )
      assertAllowedKeys(
        params,
        [
          'runId',
          'interactionId',
          'providerSessionId',
          'profileDigest',
          'connectionId',
          'workspaceId',
          'runner',
          'response',
        ],
        'respond_interaction.params',
      )
      if (typeof value.operationId !== 'string' || value.operationId.length === 0) {
        throw new AppError('OPERATION_ID_REQUIRED', 'respond_interaction requires operationId')
      }
      for (const field of ['runId', 'interactionId'] as const) {
        if (typeof params[field] !== 'string' || params[field].length === 0) {
          throw new AppError('INVALID_PARAMS', `${field} must be a non-empty string`)
        }
      }
      for (const field of [
        'providerSessionId',
        'profileDigest',
        'connectionId',
        'workspaceId',
        'runner',
      ] as const) {
        if (
          params[field] !== undefined &&
          (typeof params[field] !== 'string' || params[field].length === 0)
        ) {
          throw new AppError('INVALID_PARAMS', `${field} must be a non-empty string`)
        }
      }
      return {
        version: 1,
        requestId: value.requestId,
        operationId: value.operationId,
        command: 'respond_interaction',
        params: {
          runId: params.runId as string,
          interactionId: params.interactionId as string,
          ...(typeof params.providerSessionId === 'string'
            ? { providerSessionId: params.providerSessionId }
            : {}),
          ...(typeof params.profileDigest === 'string'
            ? { profileDigest: params.profileDigest }
            : {}),
          ...(typeof params.connectionId === 'string' ? { connectionId: params.connectionId } : {}),
          ...(typeof params.workspaceId === 'string' ? { workspaceId: params.workspaceId } : {}),
          ...(typeof params.runner === 'string' ? { runner: params.runner } : {}),
          response: interactionResponse(params.response),
        },
      }
    case 'shutdown':
      assertAllowedKeys(value, ['version', 'requestId', 'command', 'params'], 'shutdown')
      assertAllowedKeys(params, [], 'shutdown.params')
      return { version: 1, requestId: value.requestId, command: 'shutdown' }
    default:
      throw new AppError('UNKNOWN_COMMAND', `Unknown command: ${value.command}`)
  }
}

export async function* linesOf(input: RpcInput): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffered = ''
  for await (const chunk of input) {
    buffered += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    let newline = buffered.indexOf('\n')
    while (newline >= 0) {
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      if (line.length > 0) yield line
      newline = buffered.indexOf('\n')
    }
  }
  buffered += decoder.decode()
  if (buffered.length > 0) yield buffered
}
