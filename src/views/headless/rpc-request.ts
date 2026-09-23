import type { InteractionData, InteractionRequest } from '@tangle-network/agent-interface'
import type { AutomationRuleMatcher } from '../../domain/interaction-state.js'
import { AppError } from '../../app/application.js'
import {
  assertBoundedString,
  assertBoundedStructure,
  MAX_ID_BYTES,
  MAX_TEXT_BYTES,
  utf8Bytes,
} from '../../domain/bounds.js'
import { BRAID_PROTOCOL_VERSION, type BraidRequest } from './protocol.js'
import { parseInteractionCommand } from './rpc-request-interaction.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function interactionData(value: unknown, label: string): InteractionData {
  if (!isRecord(value)) throw new AppError('INVALID_PARAMS', `${label} must be an object`)
  for (const [name, item] of Object.entries(value)) {
    if (
      !(
        typeof item === 'string' ||
        typeof item === 'boolean' ||
        (typeof item === 'number' && Number.isFinite(item)) ||
        (Array.isArray(item) && item.every((entry) => typeof entry === 'string'))
      )
    ) {
      throw new AppError('INVALID_PARAMS', `${label}.${name} has an unsupported value`)
    }
  }
  return value as InteractionData
}

function automationMatcher(value: unknown): AutomationRuleMatcher | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new AppError('INVALID_PARAMS', 'params.matcher must be an object')
  const keys = [
    'interactionKind',
    'subjectType',
    'subjectValue',
    'profileDigest',
    'connectionId',
    'runner',
    'workspaceId',
    'providerSessionId',
  ] as const
  assertAllowedKeys(value, keys, 'automation.params.matcher')
  for (const key of keys) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length === 0)) {
      throw new AppError('INVALID_PARAMS', `params.matcher.${key} must be a non-empty string`)
    }
    if (typeof value[key] === 'string') boundedId(value[key], `params.matcher.${key}`)
  }
  return value as AutomationRuleMatcher
}

function operationId(value: unknown, command: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('OPERATION_ID_REQUIRED', `${command} requires operationId`)
  }
  boundedId(value, `${command}.operationId`)
  return value
}

export function requestIdOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  return typeof value.requestId === 'string' && utf8Bytes(value.requestId) <= MAX_ID_BYTES
    ? value.requestId
    : undefined
}

function boundedId(value: string, label: string): void {
  boundedString(value, label, MAX_ID_BYTES)
}

function boundedString(value: string, label: string, maxBytes: number): void {
  try {
    assertBoundedString(value, label, maxBytes)
  } catch (error) {
    throw new AppError(
      'INPUT_TOO_LARGE',
      error instanceof Error ? error.message : `${label} exceeds the UTF-8 byte limit`,
    )
  }
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
  try {
    assertBoundedStructure(value, {
      maxBytes: MAX_TEXT_BYTES,
      maxDepth: 32,
      maxArrayLength: 1_000,
      maxObjectKeys: 1_000,
      maxFields: 4_000,
    })
  } catch (error) {
    throw new AppError(
      'INPUT_TOO_LARGE',
      error instanceof Error ? error.message : 'Request is too large',
    )
  }
  if (!isRecord(value)) throw new AppError('INVALID_REQUEST', 'Request must be an object')
  if (value.version !== BRAID_PROTOCOL_VERSION) {
    throw new AppError('UNSUPPORTED_VERSION', 'Only protocol version 1 is supported')
  }
  if (typeof value.requestId !== 'string' || value.requestId.length === 0) {
    throw new AppError('INVALID_REQUEST_ID', 'requestId must be a non-empty string')
  }
  boundedId(value.requestId, 'requestId')
  if (typeof value.command !== 'string')
    throw new AppError('INVALID_COMMAND', 'command must be a string')
  boundedId(value.command, 'command')
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
      boundedString(params.workspace, 'initialize.params.workspace', MAX_TEXT_BYTES)
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
      boundedId(value.operationId, 'send.operationId')
      if (typeof params.text !== 'string')
        throw new AppError('INVALID_PARAMS', 'send.params.text must be a string')
      if (params.conversationId !== undefined && typeof params.conversationId !== 'string') {
        throw new AppError('INVALID_PARAMS', 'send.params.conversationId must be a string')
      }
      if (params.branchId !== undefined && typeof params.branchId !== 'string') {
        throw new AppError('INVALID_PARAMS', 'send.params.branchId must be a string')
      }
      if (typeof params.conversationId === 'string')
        boundedId(params.conversationId, 'send.params.conversationId')
      if (typeof params.branchId === 'string') boundedId(params.branchId, 'send.params.branchId')
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
    case 'cancel_interaction':
      return parseInteractionCommand(value, params, value.command)
    case 'automation_create':
    case 'automation.create':
    case 'create_automation':
      assertAllowedKeys(
        value,
        ['version', 'requestId', 'operationId', 'command', 'params'],
        'automation_create',
      )
      assertAllowedKeys(
        params,
        [
          'interactionKey',
          'request',
          'matcher',
          'answer',
          'responseScope',
          'expiresAt',
          'maximumUses',
          'priority',
        ],
        'automation_create.params',
      )
      if (params.answer === undefined) {
        throw new AppError('INVALID_PARAMS', 'automation_create.params.answer is required')
      }
      if (
        params.responseScope !== 'once' &&
        params.responseScope !== 'session' &&
        params.responseScope !== 'persistent'
      ) {
        throw new AppError('INVALID_PARAMS', 'automation_create.params.responseScope is invalid')
      }
      if (params.interactionKey !== undefined && typeof params.interactionKey !== 'string') {
        throw new AppError(
          'INVALID_PARAMS',
          'automation_create.params.interactionKey must be a string',
        )
      }
      if (typeof params.interactionKey === 'string')
        boundedId(params.interactionKey, 'interactionKey')
      if (params.request !== undefined && !isRecord(params.request)) {
        throw new AppError('INVALID_PARAMS', 'automation_create.params.request must be an object')
      }
      if (params.expiresAt !== undefined && typeof params.expiresAt !== 'string') {
        throw new AppError('INVALID_PARAMS', 'automation_create.params.expiresAt must be a string')
      }
      if (typeof params.expiresAt === 'string')
        boundedId(params.expiresAt, 'automation_create.params.expiresAt')
      for (const field of ['maximumUses', 'priority'] as const) {
        if (params[field] !== undefined && typeof params[field] !== 'number') {
          throw new AppError('INVALID_PARAMS', `automation_create.params.${field} must be a number`)
        }
      }
      return {
        version: 1,
        requestId: value.requestId,
        operationId: operationId(value.operationId, 'automation_create'),
        command: 'automation_create',
        params: {
          ...(typeof params.interactionKey === 'string'
            ? { interactionKey: params.interactionKey }
            : {}),
          ...(params.request === undefined
            ? {}
            : { request: params.request as InteractionRequest }),
          ...(params.matcher === undefined
            ? {}
            : { matcher: automationMatcher(params.matcher) as AutomationRuleMatcher }),
          answer: interactionData(params.answer, 'automation_create.params.answer'),
          responseScope: params.responseScope,
          ...(typeof params.expiresAt === 'string' ? { expiresAt: params.expiresAt } : {}),
          ...(typeof params.maximumUses === 'number' ? { maximumUses: params.maximumUses } : {}),
          ...(typeof params.priority === 'number' ? { priority: params.priority } : {}),
        },
      }
    case 'automation_dry_run':
    case 'automation.dry_run':
    case 'automation.dry-run':
    case 'automation_dry-run':
      assertAllowedKeys(
        value,
        ['version', 'requestId', 'operationId', 'command', 'params'],
        'automation_dry_run',
      )
      assertAllowedKeys(params, ['key'], 'automation_dry_run.params')
      if (typeof params.key !== 'string' || params.key.length === 0) {
        throw new AppError(
          'INVALID_PARAMS',
          'automation_dry_run.params.key must be a non-empty string',
        )
      }
      boundedId(params.key, 'automation_dry_run.params.key')
      return {
        version: 1,
        requestId: value.requestId,
        operationId: operationId(value.operationId, 'automation_dry_run'),
        command: 'automation_dry_run',
        params: { key: params.key },
      }
    case 'automation_update':
    case 'automation.update':
      assertAllowedKeys(
        value,
        ['version', 'requestId', 'operationId', 'command', 'params'],
        'automation_update',
      )
      assertAllowedKeys(
        params,
        [
          'ruleId',
          'interactionKey',
          'request',
          'matcher',
          'answer',
          'responseScope',
          'expiresAt',
          'maximumUses',
          'priority',
        ],
        'automation_update.params',
      )
      if (typeof params.ruleId !== 'string' || params.ruleId.length === 0) {
        throw new AppError(
          'INVALID_PARAMS',
          'automation_update.params.ruleId must be a non-empty string',
        )
      }
      boundedId(params.ruleId, 'automation_update.params.ruleId')
      if (params.interactionKey !== undefined && typeof params.interactionKey !== 'string') {
        throw new AppError(
          'INVALID_PARAMS',
          'automation_update.params.interactionKey must be a string',
        )
      }
      if (typeof params.interactionKey === 'string')
        boundedId(params.interactionKey, 'automation_update.params.interactionKey')
      if (params.request !== undefined && !isRecord(params.request)) {
        throw new AppError('INVALID_PARAMS', 'automation_update.params.request must be an object')
      }
      if (
        params.responseScope !== undefined &&
        params.responseScope !== 'once' &&
        params.responseScope !== 'session' &&
        params.responseScope !== 'persistent'
      ) {
        throw new AppError('INVALID_PARAMS', 'automation_update.params.responseScope is invalid')
      }
      if (params.answer !== undefined)
        interactionData(params.answer, 'automation_update.params.answer')
      if (params.expiresAt !== undefined && typeof params.expiresAt !== 'string') {
        throw new AppError('INVALID_PARAMS', 'automation_update.params.expiresAt must be a string')
      }
      if (typeof params.expiresAt === 'string')
        boundedId(params.expiresAt, 'automation_update.params.expiresAt')
      for (const field of ['maximumUses', 'priority'] as const) {
        if (params[field] !== undefined && typeof params[field] !== 'number') {
          throw new AppError(`INVALID_PARAMS`, `automation_update.params.${field} must be a number`)
        }
      }
      return {
        version: 1,
        requestId: value.requestId,
        operationId: operationId(value.operationId, 'automation_update'),
        command: 'automation_update',
        params: {
          ruleId: params.ruleId,
          ...(typeof params.interactionKey === 'string'
            ? { interactionKey: params.interactionKey }
            : {}),
          ...(params.request === undefined
            ? {}
            : { request: params.request as InteractionRequest }),
          ...(params.matcher === undefined
            ? {}
            : { matcher: automationMatcher(params.matcher) as AutomationRuleMatcher }),
          ...(params.answer === undefined
            ? {}
            : { answer: interactionData(params.answer, 'automation_update.params.answer') }),
          ...(params.responseScope === undefined ? {} : { responseScope: params.responseScope }),
          ...(typeof params.expiresAt === 'string' ? { expiresAt: params.expiresAt } : {}),
          ...(typeof params.maximumUses === 'number' ? { maximumUses: params.maximumUses } : {}),
          ...(typeof params.priority === 'number' ? { priority: params.priority } : {}),
        },
      }
    case 'automation_disable':
    case 'automation.disable':
      return automationRuleRequest(value, params, 'automation_disable')
    case 'automation_delete':
    case 'automation.delete':
      return automationRuleRequest(value, params, 'automation_delete')
    case 'automation_list':
    case 'automation.list':
      assertAllowedKeys(value, ['version', 'requestId', 'command', 'params'], 'automation_list')
      assertAllowedKeys(params, [], 'automation_list.params')
      return { version: 1, requestId: value.requestId, command: 'automation_list' }
    case 'shutdown':
      assertAllowedKeys(value, ['version', 'requestId', 'command', 'params'], 'shutdown')
      assertAllowedKeys(params, [], 'shutdown.params')
      return { version: 1, requestId: value.requestId, command: 'shutdown' }
    default:
      throw new AppError('UNKNOWN_COMMAND', `Unknown command: ${value.command}`)
  }
}

function automationRuleRequest(
  value: Record<string, unknown>,
  params: Record<string, unknown>,
  command: 'automation_disable' | 'automation_delete',
): BraidRequest {
  assertAllowedKeys(value, ['version', 'requestId', 'operationId', 'command', 'params'], command)
  assertAllowedKeys(params, ['ruleId'], `${command}.params`)
  if (typeof params.ruleId !== 'string' || params.ruleId.length === 0) {
    throw new AppError('INVALID_PARAMS', `${command}.params.ruleId must be a non-empty string`)
  }
  boundedId(params.ruleId, `${command}.params.ruleId`)
  return {
    version: 1,
    requestId: value.requestId as string,
    operationId: operationId(value.operationId, command),
    command,
    params: { ruleId: params.ruleId },
  }
}
