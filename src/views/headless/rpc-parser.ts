import {
  HEADLESS_COMMAND_NAMES,
  isMutatingHeadlessCommand,
  type HeadlessCommandName,
} from '../shared/headless-commands.js'
import {
  BRAID_PROTOCOL_VERSION,
  type BraidRequest,
  type GenericRpcRequest,
  type RpcCommandName,
} from './protocol.js'
import { RpcParseError } from './rpc-errors.js'
import { linesOf } from './rpc-framing.js'
import {
  MAX_RPC_COMMAND_TEXT_BYTES,
  MAX_RPC_FIELD_BYTES,
  MAX_RPC_LINE_BYTES,
  MAX_RPC_OPERATION_ID_BYTES,
  MAX_RPC_REQUEST_ID_BYTES,
} from './rpc-types.js'
import { utf8ByteLength } from '../../domain/utf8.js'

export {
  MAX_RPC_COMMAND_TEXT_BYTES,
  MAX_RPC_FIELD_BYTES,
  MAX_RPC_LINE_BYTES,
  MAX_RPC_OPERATION_ID_BYTES,
  MAX_RPC_REQUEST_ID_BYTES,
  RpcParseError,
  linesOf,
}

const PARAMETER_KEYS: Readonly<Record<HeadlessCommandName, readonly string[]>> = {
  initialize: ['workspace', 'subscribe'],
  get_state: ['projection'],
  subscribe: [],
  unsubscribe: [],
  list_profiles: ['query'],
  select_profile: ['ref', 'expectedRevision'],
  validate_profile: ['ref'],
  save_profile: ['ref', 'profile', 'expectedRevision'],
  list_connections: ['query'],
  test_connection: ['connectionId'],
  select_connection: ['connectionId', 'expectedRevision'],
  set_run_override: ['runner', 'model', 'effort', 'mode', 'clear'],
  new_conversation: ['title', 'profileRef', 'connectionId'],
  list_conversations: ['query', 'workspace', 'status'],
  open_conversation: ['conversationId', 'branchId'],
  set_draft: ['conversationId', 'branchId', 'text'],
  send: ['conversationId', 'branchId', 'text'],
  queue: ['conversationId', 'branchId', 'text'],
  remove_queued: ['conversationId', 'branchId', 'queueId'],
  steer: ['runId', 'text'],
  respond_interaction: ['runId', 'interactionId', 'response'],
  cancel_run: ['runId', 'reason'],
  branch: ['conversationId', 'branchId', 'messageId', 'text'],
  clone: ['conversationId', 'branchId', 'title'],
  plan_fork: ['conversationId', 'branchId', 'messageId', 'workspace', 'runner', 'model', 'effort'],
  execute_fork: ['planDigest', 'workspace', 'operation'],
  ask: ['source', 'question', 'profileRef', 'connectionId'],
  analyze: ['source', 'recipe', 'profileRef', 'connectionId'],
  compare: ['left', 'right', 'profileRef', 'connectionId'],
  promote_analysis: ['analysisId', 'findingIds', 'conversationId', 'branchId'],
  get_graph: ['conversationId', 'branchId', 'query'],
  get_activity: ['conversationId', 'branchId', 'runId'],
  get_details: ['entityType', 'entityId'],
  steer_worker: ['supervisorId', 'workerId', 'text'],
  cancel_worker: ['supervisorId', 'workerId', 'reason'],
  export: ['target', 'format', 'includeRaw', 'destination'],
  shutdown: [],
}

type ParameterType = 'string' | 'boolean' | 'number' | 'record' | 'string[]'

const PARAMETER_TYPES: Readonly<
  Record<HeadlessCommandName, Readonly<Record<string, ParameterType>>>
> = {
  initialize: { workspace: 'string', subscribe: 'boolean' },
  get_state: { projection: 'string' },
  subscribe: {},
  unsubscribe: {},
  list_profiles: { query: 'string' },
  select_profile: { ref: 'string', expectedRevision: 'number' },
  validate_profile: { ref: 'string' },
  save_profile: { ref: 'string', profile: 'record', expectedRevision: 'number' },
  list_connections: { query: 'string' },
  test_connection: { connectionId: 'string' },
  select_connection: { connectionId: 'string', expectedRevision: 'number' },
  set_run_override: {
    runner: 'string',
    model: 'string',
    effort: 'string',
    mode: 'string',
    clear: 'boolean',
  },
  new_conversation: { title: 'string', profileRef: 'string', connectionId: 'string' },
  list_conversations: { query: 'string', workspace: 'string', status: 'string' },
  open_conversation: { conversationId: 'string', branchId: 'string' },
  set_draft: { conversationId: 'string', branchId: 'string', text: 'string' },
  send: { conversationId: 'string', branchId: 'string', text: 'string' },
  queue: { conversationId: 'string', branchId: 'string', text: 'string' },
  remove_queued: { conversationId: 'string', branchId: 'string', queueId: 'string' },
  steer: { runId: 'string', text: 'string' },
  respond_interaction: { runId: 'string', interactionId: 'string', response: 'record' },
  cancel_run: { runId: 'string', reason: 'string' },
  branch: { conversationId: 'string', branchId: 'string', messageId: 'string', text: 'string' },
  clone: { conversationId: 'string', branchId: 'string', title: 'string' },
  plan_fork: {
    conversationId: 'string',
    branchId: 'string',
    messageId: 'string',
    workspace: 'string',
    runner: 'string',
    model: 'string',
    effort: 'string',
  },
  execute_fork: { planDigest: 'string', workspace: 'string', operation: 'record' },
  ask: { source: 'string', question: 'string', profileRef: 'string', connectionId: 'string' },
  analyze: { source: 'string', recipe: 'string', profileRef: 'string', connectionId: 'string' },
  compare: { left: 'string', right: 'string', profileRef: 'string', connectionId: 'string' },
  promote_analysis: {
    analysisId: 'string',
    findingIds: 'string[]',
    conversationId: 'string',
    branchId: 'string',
  },
  get_graph: { conversationId: 'string', branchId: 'string', query: 'string' },
  get_activity: { conversationId: 'string', branchId: 'string', runId: 'string' },
  get_details: { entityType: 'string', entityId: 'string' },
  steer_worker: { supervisorId: 'string', workerId: 'string', text: 'string' },
  cancel_worker: { supervisorId: 'string', workerId: 'string', reason: 'string' },
  export: {
    target: 'string',
    format: 'string',
    includeRaw: 'boolean',
    destination: 'string',
  },
  shutdown: {},
}

const REQUIRED_PARAMETERS: Readonly<Partial<Record<HeadlessCommandName, readonly string[]>>> = {
  select_profile: ['ref'],
  validate_profile: ['ref'],
  save_profile: ['ref', 'profile'],
  test_connection: ['connectionId'],
  select_connection: ['connectionId'],
  open_conversation: ['conversationId'],
  set_draft: ['text'],
  queue: ['text'],
  remove_queued: ['queueId'],
  steer: ['runId', 'text'],
  respond_interaction: ['runId', 'interactionId', 'response'],
  branch: ['conversationId', 'branchId', 'messageId'],
  clone: ['conversationId', 'branchId'],
  plan_fork: ['conversationId', 'branchId'],
  execute_fork: ['planDigest'],
  ask: ['source', 'question'],
  analyze: ['source', 'recipe'],
  compare: ['left', 'right'],
  promote_analysis: ['analysisId', 'findingIds'],
  get_details: ['entityType', 'entityId'],
  steer_worker: ['supervisorId', 'workerId', 'text'],
  cancel_worker: ['supervisorId', 'workerId'],
  export: ['target'],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function requestIdOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.requestId !== 'string') return undefined
  return utf8ByteLength(value.requestId) <= MAX_RPC_REQUEST_ID_BYTES ? value.requestId : undefined
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown)
    throw new RpcParseError('INVALID_PARAMS', `${label} contains unknown field ${unknown}`)
}

function parameterMatches(value: unknown, type: ParameterType): boolean {
  if (type === 'string') return typeof value === 'string'
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'string[]')
    return Array.isArray(value) && value.every((item) => typeof item === 'string')
  return isRecord(value)
}

function assertParameterTypes(command: HeadlessCommandName, params: Record<string, unknown>): void {
  for (const [key, type] of Object.entries(PARAMETER_TYPES[command])) {
    if (params[key] !== undefined && !parameterMatches(params[key], type)) {
      throw new RpcParseError('INVALID_PARAMS', `${command}.params.${key} must be ${type}`)
    }
  }
  for (const key of REQUIRED_PARAMETERS[command] ?? []) {
    if (params[key] === undefined) {
      throw new RpcParseError('INVALID_PARAMS', `${command}.params.${key} is required`)
    }
  }
}

function assertString(
  value: unknown,
  label: string,
  maxBytes = MAX_RPC_FIELD_BYTES,
  code = 'INVALID_PARAMS',
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcParseError('INVALID_PARAMS', `${label} must be a non-empty string`)
  }
  if (utf8ByteLength(value) > maxBytes) {
    throw new RpcParseError(code, `${label} must not exceed ${maxBytes} UTF-8 bytes`)
  }
  return value
}

const COMMAND_TEXT_FIELDS = new Set([
  'set_draft.text',
  'send.text',
  'queue.text',
  'steer.text',
  'branch.text',
  'ask.question',
  'steer_worker.text',
])

function assertRecordStringBounds(value: unknown, label: string, depth = 0): void {
  if (depth > 64) throw new RpcParseError('INVALID_PARAMS', `${label} is too deeply nested`)
  if (typeof value === 'string') {
    if (utf8ByteLength(value) > MAX_RPC_FIELD_BYTES) {
      throw new RpcParseError(
        'INVALID_PARAMS',
        `${label} must not exceed ${MAX_RPC_FIELD_BYTES} UTF-8 bytes`,
      )
    }
    return
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries())
      assertRecordStringBounds(item, `${label}[${index}]`, depth + 1)
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (utf8ByteLength(key) > MAX_RPC_FIELD_BYTES) {
      throw new RpcParseError('INVALID_PARAMS', `${label} contains an overlong field name`)
    }
    assertRecordStringBounds(child, `${label}.${key}`, depth + 1)
  }
}

function assertParameterByteBounds(
  command: HeadlessCommandName,
  params: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') {
      const limit = COMMAND_TEXT_FIELDS.has(`${command}.${key}`)
        ? MAX_RPC_COMMAND_TEXT_BYTES
        : MAX_RPC_FIELD_BYTES
      if (utf8ByteLength(value) > limit) {
        throw new RpcParseError(
          'INVALID_PARAMS',
          `${command}.params.${key} must not exceed ${limit} UTF-8 bytes`,
        )
      }
    } else if (value !== undefined) {
      assertRecordStringBounds(value, `${command}.params.${key}`)
    }
  }
}

function assertCommand(value: unknown): value is RpcCommandName {
  return typeof value === 'string' && (HEADLESS_COMMAND_NAMES as readonly string[]).includes(value)
}

function genericRequest(
  value: Record<string, unknown>,
  command: Exclude<RpcCommandName, 'initialize' | 'get_state' | 'send' | 'shutdown'>,
  params: Record<string, unknown>,
): GenericRpcRequest {
  const operationId = value.operationId
  if (operationId !== undefined) {
    if (typeof operationId !== 'string' || operationId.length === 0) {
      throw new RpcParseError('INVALID_OPERATION_ID', 'operationId must be a non-empty string')
    }
    if (utf8ByteLength(operationId) > MAX_RPC_OPERATION_ID_BYTES) {
      throw new RpcParseError(
        'INVALID_OPERATION_ID',
        `operationId must not exceed ${MAX_RPC_OPERATION_ID_BYTES} UTF-8 bytes`,
      )
    }
  }
  if (isMutatingHeadlessCommand(command) && operationId === undefined) {
    throw new RpcParseError('OPERATION_ID_REQUIRED', `${command} requires operationId`)
  }
  return {
    version: 1,
    requestId: value.requestId as string,
    command,
    params,
    ...(typeof operationId === 'string' ? { operationId } : {}),
  }
}

export function parseRequest(line: string): BraidRequest {
  if (utf8ByteLength(line) > MAX_RPC_LINE_BYTES) {
    throw new RpcParseError(
      'LINE_TOO_LARGE',
      `JSONL line must not exceed ${MAX_RPC_LINE_BYTES} bytes`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new RpcParseError('MALFORMED_JSON', 'Input is not valid JSON')
  }
  if (!isRecord(parsed)) throw new RpcParseError('INVALID_REQUEST', 'Request must be an object')
  assertAllowedKeys(parsed, ['version', 'requestId', 'operationId', 'command', 'params'], 'request')
  if (parsed.version !== BRAID_PROTOCOL_VERSION) {
    throw new RpcParseError('UNSUPPORTED_VERSION', 'Only protocol version 1 is supported')
  }
  const requestId = assertString(parsed.requestId, 'requestId', MAX_RPC_REQUEST_ID_BYTES)
  const command = parsed.command
  if (!assertCommand(command)) {
    throw new RpcParseError(
      'UNKNOWN_COMMAND',
      `Unknown command: ${String(command)}`,
      HEADLESS_COMMAND_NAMES,
    )
  }
  if (
    parsed.operationId !== undefined &&
    (typeof parsed.operationId !== 'string' || parsed.operationId.length === 0)
  ) {
    throw new RpcParseError('INVALID_OPERATION_ID', 'operationId must be a non-empty string')
  }
  if (
    typeof parsed.operationId === 'string' &&
    utf8ByteLength(parsed.operationId) > MAX_RPC_OPERATION_ID_BYTES
  ) {
    throw new RpcParseError(
      'INVALID_OPERATION_ID',
      `operationId must not exceed ${MAX_RPC_OPERATION_ID_BYTES} UTF-8 bytes`,
    )
  }
  if (parsed.params !== undefined && !isRecord(parsed.params)) {
    throw new RpcParseError('INVALID_PARAMS', 'params must be an object')
  }
  const params = parsed.params ?? {}
  assertAllowedKeys(params, PARAMETER_KEYS[command], `${command}.params`)
  if (isMutatingHeadlessCommand(command) && typeof parsed.operationId !== 'string') {
    throw new RpcParseError('OPERATION_ID_REQUIRED', `${command} requires operationId`)
  }
  assertParameterTypes(command, params)
  assertParameterByteBounds(command, params)

  switch (command) {
    case 'initialize':
      if (parsed.operationId !== undefined) {
        throw new RpcParseError('INVALID_PARAMS', 'initialize does not accept operationId')
      }
      if (typeof params.workspace !== 'string') {
        throw new RpcParseError('INVALID_PARAMS', 'initialize.params.workspace must be a string')
      }
      if (params.subscribe !== undefined && typeof params.subscribe !== 'boolean') {
        throw new RpcParseError('INVALID_PARAMS', 'initialize.params.subscribe must be a boolean')
      }
      return {
        version: 1,
        requestId,
        command,
        params: {
          workspace: params.workspace,
          ...(typeof params.subscribe === 'boolean' ? { subscribe: params.subscribe } : {}),
        },
      }
    case 'get_state':
      if (parsed.operationId !== undefined) {
        throw new RpcParseError('INVALID_PARAMS', 'get_state does not accept operationId')
      }
      if (params.projection !== undefined && typeof params.projection !== 'string') {
        throw new RpcParseError('INVALID_PARAMS', 'get_state.params.projection must be a string')
      }
      if (
        params.projection !== undefined &&
        params.projection !== 'full' &&
        params.projection !== 'summary'
      ) {
        throw new RpcParseError(
          'INVALID_PARAMS',
          'get_state.params.projection must be full or summary',
        )
      }
      return {
        version: 1,
        requestId,
        command,
        params:
          params.projection === 'full' || params.projection === 'summary'
            ? { projection: params.projection }
            : {},
      }
    case 'send':
      if (typeof parsed.operationId !== 'string' || parsed.operationId.length === 0) {
        throw new RpcParseError('OPERATION_ID_REQUIRED', 'send requires operationId')
      }
      if (typeof params.text !== 'string') {
        throw new RpcParseError('INVALID_PARAMS', 'send.params.text must be a string')
      }
      if (params.conversationId !== undefined && typeof params.conversationId !== 'string') {
        throw new RpcParseError('INVALID_PARAMS', 'send.params.conversationId must be a string')
      }
      if (params.branchId !== undefined && typeof params.branchId !== 'string') {
        throw new RpcParseError('INVALID_PARAMS', 'send.params.branchId must be a string')
      }
      return {
        version: 1,
        requestId,
        operationId: parsed.operationId,
        command,
        params: {
          text: params.text,
          ...(typeof params.conversationId === 'string'
            ? { conversationId: params.conversationId }
            : {}),
          ...(typeof params.branchId === 'string' ? { branchId: params.branchId } : {}),
        },
      }
    case 'shutdown':
      if (typeof parsed.operationId !== 'string' || parsed.operationId.length === 0) {
        throw new RpcParseError('OPERATION_ID_REQUIRED', 'shutdown requires operationId')
      }
      return {
        version: 1,
        requestId,
        operationId: parsed.operationId,
        command,
        params: {},
      }
    default:
      return genericRequest(parsed, command, params)
  }
}
