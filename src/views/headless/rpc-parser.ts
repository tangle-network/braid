import { parseConfidentialWorkspaceForkRequest } from '../../app/confidential-workspace-fork.js'
import {
  HEADLESS_COMMAND_NAMES,
  type HeadlessCommandName,
  isMutatingHeadlessCommand,
} from '../shared/headless-commands.js'
import {
  BRAID_PROTOCOL_VERSION,
  type BraidRequest,
  type GenericRpcRequest,
  type RpcCommandName,
} from './protocol.js'
import {
  assertBoundedIdentifier,
  assertBoundedRequestShape,
  MAX_PROTOCOL_ITEMS,
  MAX_PROTOCOL_LIST_ITEMS,
  MAX_RPC_LINE_BYTES,
} from './protocol-limits.js'
import {
  AUTOMATION_PARAMETER_KEYS,
  AUTOMATION_PARAMETER_TYPES,
  AUTOMATION_REQUIRED_PARAMETERS,
} from './rpc-automation-commands.js'
import { RpcParseError } from './rpc-errors.js'
import { validateInteractionParameters } from './rpc-interaction-commands.js'
import type { RpcInput } from './rpc-types.js'

export { RpcParseError } from './rpc-errors.js'

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
  upsert_connection: ['record', 'expectedRevision'],
  test_connection: ['connectionId'],
  select_connection: ['connectionId', 'expectedRevision'],
  remove_connection: ['connectionId', 'expectedRevision'],
  set_run_override: ['runner', 'model', 'effort', 'mode', 'clear'],
  new_conversation: ['title', 'profileRef', 'connectionId'],
  list_conversations: ['query', 'workspace', 'status'],
  open_conversation: ['conversationId', 'branchId'],
  rename_conversation: ['conversationId', 'title'],
  archive_conversation: ['conversationId', 'archived'],
  delete_conversation: ['conversationId'],
  set_draft: ['conversationId', 'branchId', 'text'],
  import_conversation: ['content', 'source', 'title'],
  send: ['conversationId', 'branchId', 'text'],
  queue: ['conversationId', 'branchId', 'text'],
  remove_queued: ['conversationId', 'branchId', 'queueId'],
  steer: ['runId', 'text'],
  cancel: ['runId', 'reason'],
  detach: ['runId'],
  reconnect: ['runId'],
  reconcile: ['runId'],
  respond_interaction: ['runId', 'interactionId', 'response'],
  cancel_interaction: ['runId', 'interactionId'],
  ...AUTOMATION_PARAMETER_KEYS,
  cancel_run: ['runId', 'reason'],
  branch: ['conversationId', 'branchId', 'messageId', 'text'],
  clone: ['conversationId', 'branchId', 'title'],
  plan_fork: [
    'conversationId',
    'branchId',
    'messageId',
    'workspace',
    'runner',
    'model',
    'effort',
    'text',
    'destinationProvider',
    'confidential',
  ],
  execute_fork: [
    'planDigest',
    'conversationId',
    'branchId',
    'messageId',
    'workspace',
    'runner',
    'model',
    'effort',
    'text',
    'acceptedDigest',
    'destinationProvider',
    'confidential',
  ],
  ask: ['source', 'question', 'profileRef', 'connectionId'],
  analyze: ['source', 'recipe', 'analystIds', 'profileRef', 'connectionId'],
  compare: ['left', 'right', 'profileRef', 'connectionId'],
  promote_analysis: ['analysisId', 'findingIds', 'conversationId', 'branchId'],
  cancel_analysis: ['analysisId', 'reason'],
  get_graph: ['conversationId', 'branchId', 'query'],
  get_activity: ['conversationId', 'branchId', 'runId'],
  get_details: ['entityType', 'entityId'],
  refresh_supervision: [],
  steer_worker: ['supervisorId', 'workerId', 'text'],
  cancel_worker: ['supervisorId', 'workerId', 'reason'],
  cancel_supervisor: ['supervisorId', 'reason'],
  attach_worker: ['supervisorId', 'workerId'],
  export: ['target', 'format', 'includeRaw', 'destination'],
  shutdown: ['mode'],
}

type ParameterType = 'string' | 'boolean' | 'string-or-boolean' | 'number' | 'record' | 'string[]'

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
  upsert_connection: { record: 'record', expectedRevision: 'number' },
  test_connection: { connectionId: 'string' },
  select_connection: { connectionId: 'string', expectedRevision: 'number' },
  remove_connection: { connectionId: 'string', expectedRevision: 'number' },
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
  rename_conversation: { conversationId: 'string', title: 'string' },
  archive_conversation: { conversationId: 'string', archived: 'boolean' },
  delete_conversation: { conversationId: 'string' },
  set_draft: { conversationId: 'string', branchId: 'string', text: 'string' },
  import_conversation: { content: 'string', source: 'string', title: 'string' },
  send: { conversationId: 'string', branchId: 'string', text: 'string' },
  queue: { conversationId: 'string', branchId: 'string', text: 'string' },
  remove_queued: { conversationId: 'string', branchId: 'string', queueId: 'string' },
  steer: { runId: 'string', text: 'string' },
  cancel: { runId: 'string', reason: 'string' },
  detach: { runId: 'string' },
  reconnect: { runId: 'string' },
  reconcile: { runId: 'string' },
  respond_interaction: { runId: 'string', interactionId: 'string', response: 'record' },
  cancel_interaction: { runId: 'string', interactionId: 'string' },
  ...AUTOMATION_PARAMETER_TYPES,
  cancel_run: { runId: 'string', reason: 'string' },
  branch: { conversationId: 'string', branchId: 'string', messageId: 'string', text: 'string' },
  clone: { conversationId: 'string', branchId: 'string', title: 'string' },
  plan_fork: {
    conversationId: 'string',
    branchId: 'string',
    messageId: 'string',
    workspace: 'string-or-boolean',
    runner: 'string',
    model: 'string',
    effort: 'string',
    text: 'string',
    destinationProvider: 'string',
    confidential: 'record',
  },
  execute_fork: {
    planDigest: 'string',
    conversationId: 'string',
    branchId: 'string',
    messageId: 'string',
    workspace: 'string-or-boolean',
    runner: 'string',
    model: 'string',
    effort: 'string',
    text: 'string',
    acceptedDigest: 'string',
    destinationProvider: 'string',
    confidential: 'record',
  },
  ask: { source: 'string', question: 'string', profileRef: 'string', connectionId: 'string' },
  analyze: {
    source: 'string',
    recipe: 'string',
    analystIds: 'string[]',
    profileRef: 'string',
    connectionId: 'string',
  },
  compare: { left: 'string', right: 'string', profileRef: 'string', connectionId: 'string' },
  promote_analysis: {
    analysisId: 'string',
    findingIds: 'string[]',
    conversationId: 'string',
    branchId: 'string',
  },
  cancel_analysis: { analysisId: 'string', reason: 'string' },
  get_graph: { conversationId: 'string', branchId: 'string', query: 'string' },
  get_activity: { conversationId: 'string', branchId: 'string', runId: 'string' },
  get_details: { entityType: 'string', entityId: 'string' },
  refresh_supervision: {},
  steer_worker: { supervisorId: 'string', workerId: 'string', text: 'string' },
  cancel_worker: { supervisorId: 'string', workerId: 'string', reason: 'string' },
  cancel_supervisor: { supervisorId: 'string', reason: 'string' },
  attach_worker: { supervisorId: 'string', workerId: 'string' },
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
  upsert_connection: ['record'],
  test_connection: ['connectionId'],
  select_connection: ['connectionId'],
  remove_connection: ['connectionId'],
  open_conversation: ['conversationId'],
  rename_conversation: ['conversationId', 'title'],
  archive_conversation: ['conversationId', 'archived'],
  delete_conversation: ['conversationId'],
  set_draft: ['text'],
  queue: ['text'],
  remove_queued: ['queueId'],
  steer: ['runId', 'text'],
  cancel: [],
  detach: [],
  reconnect: ['runId'],
  reconcile: ['runId'],
  respond_interaction: ['runId', 'interactionId', 'response'],
  cancel_interaction: ['runId', 'interactionId'],
  ...AUTOMATION_REQUIRED_PARAMETERS,
  branch: ['conversationId', 'branchId', 'messageId'],
  clone: ['conversationId', 'branchId'],
  plan_fork: ['conversationId', 'branchId'],
  execute_fork: ['planDigest'],
  ask: ['source', 'question'],
  analyze: ['source'],
  compare: ['left', 'right'],
  promote_analysis: ['analysisId', 'findingIds'],
  cancel_analysis: ['analysisId'],
  get_details: ['entityType', 'entityId'],
  steer_worker: ['supervisorId', 'workerId', 'text'],
  cancel_worker: ['supervisorId', 'workerId'],
  cancel_supervisor: ['supervisorId'],
  attach_worker: ['supervisorId', 'workerId'],
  export: ['target'],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
  if (unknown)
    throw new RpcParseError('INVALID_PARAMS', `${label} contains unknown field ${unknown}`)
}

function parameterMatches(value: unknown, type: ParameterType): boolean {
  if (type === 'string') return typeof value === 'string'
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'string-or-boolean') return typeof value === 'string' || typeof value === 'boolean'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'string[]')
    return (
      Array.isArray(value) &&
      value.length <= MAX_PROTOCOL_ITEMS &&
      value.every((item) => typeof item === 'string')
    )
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
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && isIdentifierParameter(key))
      assertBoundedIdentifier(value, `${command}.params.${key}`)
    if (Array.isArray(value)) {
      if (value.length > MAX_PROTOCOL_LIST_ITEMS)
        throw new RpcParseError('INVALID_PARAMS', `${command}.params.${key} has too many items`)
      if (isIdentifierParameter(key)) {
        for (const [index, item] of value.entries()) {
          if (typeof item !== 'string') continue
          assertBoundedIdentifier(item, `${command}.params.${key}[${index}]`)
        }
      }
    }
  }
}

function isIdentifierParameter(key: string): boolean {
  return /(?:ids|id|ref|digest|cursor|workspace|connection|session|profile|queue|runner|model)$/iu.test(
    key,
  )
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcParseError('INVALID_PARAMS', `${label} must be a non-empty string`)
  }
  return value
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
  if (operationId !== undefined && (typeof operationId !== 'string' || operationId.length === 0)) {
    throw new RpcParseError('INVALID_OPERATION_ID', 'operationId must be a non-empty string')
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
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new RpcParseError('MALFORMED_JSON', 'Input is not valid JSON')
  }
  if (!isRecord(parsed)) throw new RpcParseError('INVALID_REQUEST', 'Request must be an object')
  assertBoundedRequestShape(parsed)
  assertAllowedKeys(parsed, ['version', 'requestId', 'operationId', 'command', 'params'], 'request')
  if (parsed.version !== BRAID_PROTOCOL_VERSION) {
    throw new RpcParseError('UNSUPPORTED_VERSION', 'Only protocol version 1 is supported')
  }
  const requestId = assertBoundedIdentifier(
    assertString(parsed.requestId, 'requestId'),
    'requestId',
  )
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
  if (typeof parsed.operationId === 'string')
    assertBoundedIdentifier(parsed.operationId, 'operationId')
  if (parsed.params !== undefined && !isRecord(parsed.params)) {
    throw new RpcParseError('INVALID_PARAMS', 'params must be an object')
  }
  const params = parsed.params ?? {}
  assertAllowedKeys(params, PARAMETER_KEYS[command], `${command}.params`)
  if (isMutatingHeadlessCommand(command) && typeof parsed.operationId !== 'string') {
    throw new RpcParseError('OPERATION_ID_REQUIRED', `${command} requires operationId`)
  }
  assertParameterTypes(command, params)
  const normalizedParams = normalizeForkParameters(command, params)

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
      if (
        params.mode !== undefined &&
        params.mode !== 'wait' &&
        params.mode !== 'detach' &&
        params.mode !== 'cancel'
      ) {
        throw new RpcParseError(
          'INVALID_PARAMS',
          'shutdown.params.mode must be wait, detach, or cancel',
        )
      }
      return {
        version: 1,
        requestId,
        operationId: parsed.operationId,
        command,
        params: typeof params.mode === 'string' ? { mode: params.mode } : {},
      }
    default:
      if (command === 'respond_interaction' || command === 'cancel_interaction')
        validateInteractionParameters(command, params)
      return genericRequest(parsed, command, normalizedParams)
  }
}

function normalizeForkParameters(
  command: HeadlessCommandName,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (command !== 'plan_fork' && command !== 'execute_fork') return params
  try {
    const confidential = parseConfidentialWorkspaceForkRequest(params.confidential)
    return confidential === undefined ? params : { ...params, confidential }
  } catch {
    throw new RpcParseError(
      'INVALID_PARAMS',
      `${command}.params.confidential must be a valid confidential workspace-fork request`,
    )
  }
}

export async function* linesOf(input: RpcInput): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffered = ''
  let bufferedBytes = 0
  for await (const chunk of input) {
    let decoded: string
    try {
      decoded = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    } catch {
      throw new RpcParseError('INVALID_UTF8', 'Input contains malformed UTF-8')
    }
    buffered += decoded
    bufferedBytes += Buffer.byteLength(decoded, 'utf8')
    if (bufferedBytes > MAX_RPC_LINE_BYTES && buffered.indexOf('\n') === -1)
      throw new RpcParseError('LINE_TOO_LARGE', 'Input line exceeds the 5 MiB limit')
    let newline = buffered.indexOf('\n')
    while (newline >= 0) {
      const line = buffered.slice(0, newline).replace(/\r$/u, '')
      if (Buffer.byteLength(line, 'utf8') > MAX_RPC_LINE_BYTES)
        throw new RpcParseError('LINE_TOO_LARGE', 'Input line exceeds the 5 MiB limit')
      buffered = buffered.slice(newline + 1)
      bufferedBytes = Buffer.byteLength(buffered, 'utf8')
      yield line
      newline = buffered.indexOf('\n')
    }
  }
  try {
    buffered += decoder.decode()
  } catch {
    throw new RpcParseError('INVALID_UTF8', 'Input contains malformed UTF-8')
  }
  const line = buffered.replace(/\r$/u, '')
  if (Buffer.byteLength(line, 'utf8') > MAX_RPC_LINE_BYTES)
    throw new RpcParseError('LINE_TOO_LARGE', 'Input line exceeds the 5 MiB limit')
  if (line.length > 0) yield line
}
