import { AppError } from '../../app/application.js'
import {
  type ComparisonArmBinding,
  type ComparisonRunRecord,
  validateComparisonRunRecord,
} from '../../analysis/comparison.js'
import { BRAID_PROTOCOL_VERSION, type BraidRequest } from './protocol.js'
import { parseJsonLine } from './jsonl.js'

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

function boundedString(value: unknown, label: string, max = 4_096): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > max)
    throw new AppError('INVALID_PARAMS', `${label} must be a bounded non-empty string`)
  return value
}

function boundedRunRows(value: unknown, label: string): readonly ComparisonRunRecord[] {
  if (!Array.isArray(value) || value.length > 4_096)
    throw new AppError('INVALID_PARAMS', `${label} must be a bounded array`)
  return value.map((row, index) => {
    if (!isRecord(row)) throw new AppError('INVALID_PARAMS', `${label}[${index}] must be an object`)
    try {
      return validateComparisonRunRecord(row)
    } catch {
      throw new AppError('INVALID_PARAMS', `${label}[${index}] is not a valid run record`)
    }
  })
}

function boundedBinding(
  value: unknown,
  label: string,
  arm: ComparisonArmBinding['arm'],
): ComparisonArmBinding {
  if (!isRecord(value)) throw new AppError('INVALID_PARAMS', `${label} must be an object`)
  assertAllowedKeys(
    value,
    ['experimentId', 'arm', 'sourceDigest', 'sourceRunId', 'profileDigest', 'model', 'receiptId'],
    label,
  )
  if (value.arm !== arm) throw new AppError('INVALID_PARAMS', `${label}.arm must be ${arm}`)
  return {
    experimentId: boundedString(value.experimentId, `${label}.experimentId`),
    arm,
    sourceDigest: boundedString(value.sourceDigest, `${label}.sourceDigest`),
    sourceRunId: boundedString(value.sourceRunId, `${label}.sourceRunId`),
    profileDigest: boundedString(value.profileDigest, `${label}.profileDigest`),
    model: boundedString(value.model, `${label}.model`),
    receiptId: boundedString(value.receiptId, `${label}.receiptId`),
  }
}

export function parseRequest(line: string): BraidRequest {
  const value = parseJsonLine(line)
  if (!isRecord(value)) throw new AppError('INVALID_REQUEST', 'Request must be an object')
  if (value.version !== BRAID_PROTOCOL_VERSION)
    throw new AppError('UNSUPPORTED_VERSION', 'Only protocol version 1 is supported')
  if (typeof value.requestId !== 'string' || value.requestId.length === 0)
    throw new AppError('INVALID_REQUEST_ID', 'requestId must be a non-empty string')
  const requestId = boundedString(value.requestId, 'requestId', 256)
  if (typeof value.command !== 'string')
    throw new AppError('INVALID_COMMAND', 'command must be a string')
  if (!isRecord(value.params) && value.params !== undefined)
    throw new AppError('INVALID_PARAMS', 'params must be an object')
  const params = isRecord(value.params) ? value.params : {}
  switch (value.command) {
    case 'initialize':
      assertAllowedKeys(value, ['version', 'requestId', 'command', 'params'], 'initialize')
      assertAllowedKeys(params, ['workspace', 'subscribe'], 'initialize.params')
      if (typeof params.workspace !== 'string')
        throw new AppError('INVALID_PARAMS', 'initialize.params.workspace must be a string')
      if (params.subscribe !== undefined && typeof params.subscribe !== 'boolean')
        throw new AppError('INVALID_PARAMS', 'initialize.params.subscribe must be a boolean')
      return {
        version: 1,
        requestId,
        command: 'initialize',
        params: {
          workspace: boundedString(params.workspace, 'initialize.params.workspace'),
          ...(typeof params.subscribe === 'boolean' ? { subscribe: params.subscribe } : {}),
        },
      }
    case 'get_state':
      assertAllowedKeys(value, ['version', 'requestId', 'command', 'params'], 'get_state')
      assertAllowedKeys(params, [], 'get_state.params')
      return { version: 1, requestId, command: 'get_state' }
    case 'send':
      assertAllowedKeys(value, ['version', 'requestId', 'operationId', 'command', 'params'], 'send')
      assertAllowedKeys(params, ['text', 'conversationId', 'branchId'], 'send.params')
      if (typeof value.operationId !== 'string' || value.operationId.length === 0)
        throw new AppError('OPERATION_ID_REQUIRED', 'send requires operationId')
      if (typeof params.text !== 'string')
        throw new AppError('INVALID_PARAMS', 'send.params.text must be a string')
      return {
        version: 1,
        requestId,
        operationId: boundedString(value.operationId, 'send.operationId', 256),
        command: 'send',
        params: {
          text: boundedString(params.text, 'send.params.text', 65_536),
          ...(params.conversationId === undefined
            ? {}
            : {
                conversationId: boundedString(params.conversationId, 'send.params.conversationId'),
              }),
          ...(params.branchId === undefined
            ? {}
            : { branchId: boundedString(params.branchId, 'send.params.branchId') }),
        },
      }
    case 'analysis':
      assertAllowedKeys(
        value,
        ['version', 'requestId', 'operationId', 'command', 'params'],
        'analysis',
      )
      assertAllowedKeys(params, ['text'], 'analysis.params')
      if (typeof value.operationId !== 'string' || value.operationId.length === 0)
        throw new AppError('OPERATION_ID_REQUIRED', 'analysis requires operationId')
      if (typeof params.text !== 'string' || !params.text.trim().startsWith('/'))
        throw new AppError('INVALID_PARAMS', 'analysis.params.text must be a slash command')
      return {
        version: 1,
        requestId,
        operationId: boundedString(value.operationId, 'analysis.operationId', 256),
        command: 'analysis',
        params: { text: boundedString(params.text, 'analysis.params.text', 65_536) },
      }
    case 'get_graph':
      assertAllowedKeys(value, ['version', 'requestId', 'command'], 'get_graph')
      return { version: 1, requestId, command: 'get_graph' }
    case 'cancel_run':
      assertAllowedKeys(
        value,
        ['version', 'requestId', 'operationId', 'command', 'params'],
        'cancel_run',
      )
      assertAllowedKeys(params, ['runId', 'reason'], 'cancel_run.params')
      return {
        version: 1,
        requestId,
        operationId: boundedString(value.operationId, 'cancel_run.operationId', 256),
        command: 'cancel_run',
        params: {
          runId: boundedString(params.runId, 'cancel_run.params.runId'),
          reason: boundedString(params.reason, 'cancel_run.params.reason', 1_024),
        },
      }
    case 'cancel_worker':
      assertAllowedKeys(
        value,
        ['version', 'requestId', 'operationId', 'command', 'params'],
        'cancel_worker',
      )
      assertAllowedKeys(
        params,
        ['supervisorId', 'runId', 'workerId', 'reason'],
        'cancel_worker.params',
      )
      return {
        version: 1,
        requestId,
        operationId: boundedString(value.operationId, 'cancel_worker.operationId', 256),
        command: 'cancel_worker',
        params: {
          supervisorId: boundedString(params.supervisorId, 'cancel_worker.params.supervisorId'),
          runId: boundedString(params.runId, 'cancel_worker.params.runId'),
          ...(params.workerId === undefined
            ? {}
            : { workerId: boundedString(params.workerId, 'cancel_worker.params.workerId') }),
          reason: boundedString(params.reason, 'cancel_worker.params.reason', 1_024),
        },
      }
    case 'get_supervisor':
      assertAllowedKeys(value, ['version', 'requestId', 'command', 'params'], 'get_supervisor')
      assertAllowedKeys(params, ['supervisorId'], 'get_supervisor.params')
      return {
        version: 1,
        requestId,
        command: 'get_supervisor',
        params: {
          supervisorId: boundedString(params.supervisorId, 'get_supervisor.params.supervisorId'),
        },
      }
    case 'compare':
      assertAllowedKeys(
        value,
        ['version', 'requestId', 'operationId', 'command', 'params'],
        'compare',
      )
      assertAllowedKeys(
        params,
        [
          'baselineSourceId',
          'treatmentSourceId',
          'baselineRuns',
          'treatmentRuns',
          'baselineBinding',
          'treatmentBinding',
        ],
        'compare.params',
      )
      return {
        version: 1,
        requestId,
        operationId: boundedString(value.operationId, 'compare.operationId', 256),
        command: 'compare',
        params: {
          baselineSourceId: boundedString(
            params.baselineSourceId,
            'compare.params.baselineSourceId',
          ),
          treatmentSourceId: boundedString(
            params.treatmentSourceId,
            'compare.params.treatmentSourceId',
          ),
          baselineRuns: boundedRunRows(params.baselineRuns, 'compare.params.baselineRuns'),
          treatmentRuns: boundedRunRows(params.treatmentRuns, 'compare.params.treatmentRuns'),
          baselineBinding: boundedBinding(
            params.baselineBinding,
            'compare.params.baselineBinding',
            'baseline',
          ),
          treatmentBinding: boundedBinding(
            params.treatmentBinding,
            'compare.params.treatmentBinding',
            'treatment',
          ),
        },
      }
    case 'shutdown':
      assertAllowedKeys(value, ['version', 'requestId', 'command', 'params'], 'shutdown')
      assertAllowedKeys(params, [], 'shutdown.params')
      return { version: 1, requestId, command: 'shutdown' }
    default:
      throw new AppError('UNKNOWN_COMMAND', `Unknown command: ${value.command}`)
  }
}
