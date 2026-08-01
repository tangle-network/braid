import { AppError, type BraidApplication } from '../../app/application.js'
import { canonicalDigest } from '../../domain/canonical.js'
import type { BraidEventEnvelope } from '../../domain/events.js'
import {
  BRAID_PROTOCOL_VERSION,
  type BraidRequest,
  type BraidResponse,
  type ErrorResponse,
} from './protocol.js'

export interface RpcInput extends AsyncIterable<string | Uint8Array> {}

export interface RpcOutput {
  write(chunk: string): boolean
}

export const RPC_REPLAY_MAX_ENTRIES = 256
export const RPC_REPLAY_MAX_BYTES = 8 * 1024 * 1024

interface RequestRecord {
  readonly digest: string
  readonly responses: string[]
  bytes: number
  replayable: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requestIdOf(value: unknown): string | undefined {
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

function parseRequest(line: string): BraidRequest {
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
  if (typeof value.command !== 'string') {
    throw new AppError('INVALID_COMMAND', 'command must be a string')
  }
  if (!isRecord(value.params) && value.params !== undefined) {
    throw new AppError('INVALID_PARAMS', 'params must be an object')
  }

  const params = isRecord(value.params) ? value.params : {}
  switch (value.command) {
    case 'initialize':
      assertAllowedKeys(value, ['version', 'requestId', 'command', 'params'], 'initialize')
      assertAllowedKeys(params, ['workspace', 'subscribe'], 'initialize.params')
      if (typeof params.workspace !== 'string') {
        throw new AppError('INVALID_PARAMS', 'initialize.params.workspace must be a string')
      }
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
      if (typeof params.text !== 'string') {
        throw new AppError('INVALID_PARAMS', 'send.params.text must be a string')
      }
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
    case 'shutdown':
      assertAllowedKeys(value, ['version', 'requestId', 'command', 'params'], 'shutdown')
      assertAllowedKeys(params, [], 'shutdown.params')
      return { version: 1, requestId: value.requestId, command: 'shutdown' }
    default:
      throw new AppError('UNKNOWN_COMMAND', `Unknown command: ${value.command}`)
  }
}

async function* linesOf(input: RpcInput): AsyncGenerator<string> {
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

function errorResponse(error: unknown, requestId?: string): ErrorResponse {
  if (error instanceof AppError) {
    return {
      version: 1,
      type: 'error',
      ...(requestId ? { requestId } : {}),
      code: error.code,
      message: error.message,
      retryable: false,
    }
  }
  return {
    version: 1,
    type: 'error',
    ...(requestId ? { requestId } : {}),
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  }
}

export async function runRpc(
  app: BraidApplication,
  input: RpcInput,
  output: RpcOutput,
): Promise<number> {
  let initialized = false
  let subscribed = false
  let bufferedEvents: BraidEventEnvelope[] | undefined
  let replayBytes = 0
  const requests = new Map<string, RequestRecord>()
  const write = (response: BraidResponse) => output.write(`${JSON.stringify(response)}\n`)
  const trimReplayHistory = () => {
    while (requests.size > RPC_REPLAY_MAX_ENTRIES || replayBytes > RPC_REPLAY_MAX_BYTES) {
      const oldest = requests.entries().next().value as [string, RequestRecord] | undefined
      if (!oldest) break
      requests.delete(oldest[0])
      replayBytes -= oldest[1].bytes
    }
  }
  const rememberResponse = (record: RequestRecord, response: BraidResponse) => {
    const line = `${JSON.stringify(response)}\n`
    const bytes = Buffer.byteLength(line)
    if (record.replayable && record.bytes + bytes <= RPC_REPLAY_MAX_BYTES) {
      record.responses.push(line)
      record.bytes += bytes
      replayBytes += bytes
      trimReplayHistory()
    } else if (record.replayable) {
      replayBytes -= record.bytes
      record.responses.length = 0
      record.bytes = 0
      record.replayable = false
    }
    output.write(line)
  }
  const unsubscribe = app.subscribe((_state, envelope) => {
    if (!subscribed) return
    if (bufferedEvents) {
      bufferedEvents.push(envelope)
      return
    }
    write({
      version: 1,
      type: 'event',
      sequence: envelope.sequence,
      revision: envelope.revision,
      event: envelope.event,
    })
  })

  try {
    for await (const line of linesOf(input)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        parsed = undefined
      }
      const requestId = requestIdOf(parsed)
      let requestRecord: RequestRecord | undefined
      try {
        const request = parseRequest(line)
        const digest = canonicalDigest(request)
        const previous = requests.get(request.requestId)
        if (previous) {
          if (previous.digest !== digest) {
            write(
              errorResponse(
                new AppError(
                  'REQUEST_ID_CONFLICT',
                  `requestId ${request.requestId} was already used with different input`,
                ),
                request.requestId,
              ),
            )
          } else if (!previous.replayable) {
            write(
              errorResponse(
                new AppError(
                  'REQUEST_REPLAY_UNAVAILABLE',
                  `The cached response for requestId ${request.requestId} exceeded the replay limit`,
                ),
                request.requestId,
              ),
            )
          } else {
            for (const response of previous.responses) output.write(response)
          }
          continue
        }
        requestRecord = { digest, responses: [], bytes: 0, replayable: true }
        requests.set(request.requestId, requestRecord)
        trimReplayHistory()
        const respond = (response: BraidResponse) => {
          if (requestRecord) rememberResponse(requestRecord, response)
          else write(response)
        }
        if (!initialized && request.command !== 'initialize') {
          throw new AppError('INITIALIZE_REQUIRED', 'The first command must be initialize')
        }

        switch (request.command) {
          case 'initialize': {
            if (initialized) throw new AppError('ALREADY_INITIALIZED', 'Already initialized')
            subscribed = request.params.subscribe ?? false
            app.initialize(request.params.workspace)
            initialized = true
            const state = app.state()
            respond({
              version: 1,
              type: 'ack',
              requestId: request.requestId,
              revision: state.revision,
            })
            respond({
              version: 1,
              type: 'state',
              requestId: request.requestId,
              revision: state.revision,
              state,
            })
            break
          }
          case 'get_state': {
            const state = app.state()
            respond({
              version: 1,
              type: 'state',
              requestId: request.requestId,
              revision: state.revision,
              state,
            })
            break
          }
          case 'send': {
            bufferedEvents = []
            const receipt = app.send({
              operationId: request.operationId,
              text: request.params.text,
              ...(request.params.conversationId
                ? { conversationId: request.params.conversationId }
                : {}),
              ...(request.params.branchId ? { branchId: request.params.branchId } : {}),
            })
            respond({
              version: 1,
              type: 'ack',
              requestId: request.requestId,
              operationId: request.operationId,
              revision: receipt.revision,
              replayed: receipt.replayed,
            })
            for (const envelope of bufferedEvents) {
              write({
                version: 1,
                type: 'event',
                sequence: envelope.sequence,
                revision: envelope.revision,
                event: envelope.event,
              })
            }
            bufferedEvents = undefined
            const state = await receipt.completion
            respond({
              version: 1,
              type: 'state',
              requestId: request.requestId,
              revision: state.revision,
              state,
            })
            break
          }
          case 'shutdown': {
            const state = await app.waitForIdle()
            respond({
              version: 1,
              type: 'ack',
              requestId: request.requestId,
              revision: state.revision,
            })
            return 0
          }
          default: {
            const exhaustive: never = request
            return exhaustive
          }
        }
      } catch (error) {
        bufferedEvents = undefined
        const response = errorResponse(error, requestId)
        if (requestRecord) rememberResponse(requestRecord, response)
        else write(response)
      }
    }
    return 0
  } finally {
    unsubscribe()
  }
}
