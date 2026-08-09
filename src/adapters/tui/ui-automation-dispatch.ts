import type { InteractionRequest } from '@tangle-network/agent-interface'
import type {
  AutomationRuleCreateCommand,
  AutomationRuleUpdateCommand,
} from '../../app/automation-actions.js'
import type { AutomationContext } from '../../app/automation-rules.js'
import { AppError } from '../../app/errors.js'
import type {
  AutomationRuleScope,
  NonSecretInteractionData,
} from '../../domain/entities-interactions.js'
import type { AutomationRuleMatcher } from '../../domain/entities-runtime.js'
import type { HeadlessCommandName } from '../../views/shared/headless-commands.js'
import type { BraidIntent, UiDispatchResult } from '../../views/shared/intents.js'
import type { UiDispatchContext } from './ui-dispatch-context.js'

const AUTOMATION_COMMANDS: readonly HeadlessCommandName[] = [
  'automation_create',
  'automation_update',
  'automation_dry_run',
  'automation_disable',
  'automation_delete',
  'automation_list',
]

type AutomationCommand = (typeof AUTOMATION_COMMANDS)[number]
type HeadlessCommandIntent = Extract<BraidIntent, { readonly type: 'headless-command' }>

export function isAutomationCommand(command: HeadlessCommandName): command is AutomationCommand {
  return AUTOMATION_COMMANDS.includes(command)
}

export async function dispatchAutomationHeadlessCommand(
  intent: HeadlessCommandIntent,
  context: UiDispatchContext,
): Promise<UiDispatchResult | undefined> {
  if (!isAutomationCommand(intent.command)) return undefined
  const revision = () => context.app.state().revision
  if (intent.command === 'automation_list') {
    const rules = context.app.automation.list()
    return {
      kind: 'accepted',
      revision: revision(),
      data: rules,
      notice: rules.length === 0 ? 'No automation rules' : `${rules.length} automation rule(s)`,
    }
  }
  const operationId = intent.operationId
  if (!operationId) return invalid(`${intent.command} requires operationId`)

  switch (intent.command) {
    case 'automation_create': {
      const common = commonParams(intent.command, intent.params)
      if (!common.ok) return common.result
      const answer = recordParam(intent.command, intent.params, 'answer')
      const responseScope = scopeParam(intent.command, intent.params)
      if (answer === undefined || responseScope === undefined)
        return invalid(`${intent.command} requires answer and responseScope`)
      const result = await context.app.automation.create({
        operationId,
        ruleId: common.ruleId,
        ...common.target,
        ...(requestParam(intent.params) === undefined
          ? {}
          : { request: requestParam(intent.params) as InteractionRequest }),
        answer: answer as NonSecretInteractionData,
        responseScope,
        ...optionalRuleParams(intent.command, intent.params),
      } satisfies AutomationRuleCreateCommand)
      return {
        kind: 'accepted',
        operationId: result.operationId,
        revision: result.revision,
        replayed: result.replayed,
        data: result.rule,
        notice: `Automation rule ${result.ruleId} ${result.replayed ? 'replayed' : 'created'}`,
      }
    }
    case 'automation_update': {
      const common = commonParams(intent.command, intent.params)
      if (!common.ok) return common.result
      const request = requestParam(intent.params)
      const answer = recordParam(intent.command, intent.params, 'answer')
      const responseScope = scopeParam(intent.command, intent.params)
      const result = await context.app.automation.update({
        operationId,
        ruleId: common.ruleId,
        ...common.target,
        ...(request === undefined ? {} : { request: request as InteractionRequest }),
        ...(answer === undefined ? {} : { answer: answer as NonSecretInteractionData }),
        ...(responseScope === undefined ? {} : { responseScope }),
        ...optionalRuleParams(intent.command, intent.params),
      } satisfies AutomationRuleUpdateCommand)
      return {
        kind: 'accepted',
        operationId: result.operationId,
        revision: result.revision,
        replayed: result.replayed,
        data: result.rule,
        notice: `Automation rule ${result.ruleId} ${result.replayed ? 'replayed' : 'updated'}`,
      }
    }
    case 'automation_dry_run': {
      const runId = requiredString(intent.command, intent.params, 'runId')
      const interactionId = requiredString(intent.command, intent.params, 'interactionId')
      if (runId === undefined || interactionId === undefined)
        return invalid(`${intent.command} requires runId and interactionId`)
      const contextValue = recordParam(intent.command, intent.params, 'context') as
        | AutomationContext
        | undefined
      const result = await context.app.automation.dryRun({
        operationId,
        runId,
        interactionId,
        ...(contextValue === undefined ? {} : { context: contextValue }),
      })
      return {
        kind: 'accepted',
        operationId: result.operationId,
        revision: result.revision,
        replayed: result.replayed,
        data: result.evaluation,
        notice: `Automation dry-run: ${result.evaluation.status}`,
      }
    }
    case 'automation_disable':
    case 'automation_delete': {
      const ruleId = requiredString(intent.command, intent.params, 'ruleId')
      if (ruleId === undefined) return invalid(`${intent.command} requires ruleId`)
      const result =
        intent.command === 'automation_disable'
          ? await context.app.automation.disable({ operationId, ruleId })
          : await context.app.automation.delete({ operationId, ruleId })
      return {
        kind: 'accepted',
        operationId: result.operationId,
        revision: result.revision,
        replayed: result.replayed,
        data: result.rule,
        notice: `Automation rule ${result.ruleId} ${intent.command === 'automation_disable' ? 'disabled' : 'deleted'}`,
      }
    }
    default: {
      return invalid(`${intent.command} is not an automation command`)
    }
  }
}

function commonParams(
  command: AutomationCommand,
  params: Readonly<Record<string, unknown>>,
):
  | {
      readonly ok: true
      readonly ruleId: string
      readonly target: { readonly runId?: string; readonly interactionId?: string }
    }
  | { readonly ok: false; readonly result: UiDispatchResult } {
  const ruleId = requiredString(command, params, 'ruleId')
  if (ruleId === undefined) return { ok: false, result: invalid(`${command} requires ruleId`) }
  const runId = optionalString(command, params, 'runId')
  const interactionId = optionalString(command, params, 'interactionId')
  if ((runId === undefined) !== (interactionId === undefined))
    return {
      ok: false,
      result: invalid(`${command} requires both runId and interactionId`),
    }
  return {
    ok: true,
    ruleId,
    target: {
      ...(runId === undefined ? {} : { runId }),
      ...(interactionId === undefined ? {} : { interactionId }),
    },
  }
}

function optionalRuleParams(
  command: AutomationCommand,
  params: Readonly<Record<string, unknown>>,
): Partial<AutomationRuleCreateCommand & AutomationRuleUpdateCommand> {
  const matcher = recordParam(command, params, 'matcher')
  const context = recordParam(command, params, 'context')
  const expiresAt = optionalString(command, params, 'expiresAt')
  const maximumUses = numberParam(command, params, 'maximumUses')
  const confirmPersistent = booleanParam(command, params, 'confirmPersistent')
  const creationSource = optionalString(command, params, 'creationSource')
  if (creationSource !== undefined && creationSource !== 'manual' && creationSource !== 'imported')
    throw new AppError('INVALID_PARAMS', 'creationSource must be manual or imported')
  return {
    ...(matcher === undefined ? {} : { matcher: matcher as AutomationRuleMatcher }),
    ...(context === undefined ? {} : { context: context as AutomationContext }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(maximumUses === undefined ? {} : { maximumUses }),
    ...(confirmPersistent === undefined ? {} : { confirmPersistent }),
    ...(creationSource === undefined ? {} : { creationSource }),
  }
}

function scopeParam(
  command: AutomationCommand,
  params: Readonly<Record<string, unknown>>,
): AutomationRuleScope | undefined {
  const scope = optionalString(command, params, 'responseScope')
  if (scope === undefined) return undefined
  if (scope === 'once' || scope === 'session' || scope === 'persistent') return scope
  throw new AppError('INVALID_PARAMS', 'responseScope must be once, session, or persistent')
}

function requestParam(params: Readonly<Record<string, unknown>>): unknown {
  return params.request
}

function recordParam(
  command: AutomationCommand,
  params: Readonly<Record<string, unknown>>,
  name: string,
): Record<string, unknown> | undefined {
  const value = params[name]
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new AppError('INVALID_PARAMS', `${command}.params.${name} must be an object`)
  return value as Record<string, unknown>
}

function requiredString(
  command: AutomationCommand,
  params: Readonly<Record<string, unknown>>,
  name: string,
): string | undefined {
  const value = params[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0)
    throw new AppError('INVALID_PARAMS', `${command}.params.${name} must be a non-empty string`)
  return value
}

function optionalString(
  command: AutomationCommand,
  params: Readonly<Record<string, unknown>>,
  name: string,
): string | undefined {
  const value = params[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string')
    throw new AppError('INVALID_PARAMS', `${command}.params.${name} must be a string`)
  return value
}

function numberParam(
  command: AutomationCommand,
  params: Readonly<Record<string, unknown>>,
  name: string,
): number | undefined {
  const value = params[name]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new AppError('INVALID_PARAMS', `${command}.params.${name} must be a finite number`)
  return value
}

function booleanParam(
  command: AutomationCommand,
  params: Readonly<Record<string, unknown>>,
  name: string,
): boolean | undefined {
  const value = params[name]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean')
    throw new AppError('INVALID_PARAMS', `${command}.params.${name} must be a boolean`)
  return value
}

function invalid(message: string): UiDispatchResult {
  return { kind: 'error', code: 'INVALID_PARAMS', message, retryable: false }
}
