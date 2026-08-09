import type { BraidIntent, UiDispatchResult } from '../../views/shared/intents.js'
import type { UiDispatchContext } from './ui-dispatch-context.js'
import { dispatchHeadlessCommand } from './ui-headless-dispatch.js'

export async function dispatchAutomationCommand(
  intent: Extract<BraidIntent, { readonly type: 'run-command' }>,
  context: UiDispatchContext,
): Promise<UiDispatchResult> {
  const operationId = intent.operationId
  if (!operationId) return invalidAutomationCommand('automate requires operationId')
  const [subcommand = 'list', ...args] = intent.args
  if (
    subcommand !== 'list' &&
    subcommand !== 'create' &&
    subcommand !== 'update' &&
    subcommand !== 'dry-run' &&
    subcommand !== 'disable' &&
    subcommand !== 'delete'
  )
    return invalidAutomationCommand('Use list, create, update, dry-run, disable, or delete')
  if (subcommand === 'list') {
    if (args.length > 0) return invalidAutomationCommand('automate list takes no arguments')
    return dispatchHeadlessCommand(
      {
        type: 'headless-command',
        command: 'automation_list',
        operationId,
        params: {},
      },
      context,
    )
  }
  if (subcommand === 'disable' || subcommand === 'delete') {
    if (args.length !== 1 || !args[0])
      return invalidAutomationCommand(`automate ${subcommand} requires ruleId`)
    return dispatchHeadlessCommand(
      {
        type: 'headless-command',
        command: subcommand === 'disable' ? 'automation_disable' : 'automation_delete',
        operationId,
        params: { ruleId: args[0] },
      },
      context,
    )
  }
  if (subcommand === 'dry-run') {
    const target =
      args.length === 2 ? { runId: args[0], interactionId: args[1] } : parseObject(args)
    if (!target || typeof target.runId !== 'string' || typeof target.interactionId !== 'string')
      return invalidAutomationCommand(
        'automate dry-run requires runId and interactionId, or one JSON object',
      )
    return dispatchHeadlessCommand(
      {
        type: 'headless-command',
        command: 'automation_dry_run',
        operationId,
        params: target,
      },
      context,
    )
  }
  const value = parseObject(args)
  if (!value)
    return invalidAutomationCommand(
      `automate ${subcommand} requires one JSON object of command parameters`,
    )
  return dispatchHeadlessCommand(
    {
      type: 'headless-command',
      command: subcommand === 'create' ? 'automation_create' : 'automation_update',
      operationId,
      params: value,
    },
    context,
  )
}

function parseObject(args: readonly string[]): Record<string, unknown> | undefined {
  if (args.length === 0) return undefined
  try {
    const value: unknown = JSON.parse(args.join(' '))
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function invalidAutomationCommand(message: string): UiDispatchResult {
  return { kind: 'error', code: 'INVALID_PARAMS', message, retryable: false }
}
