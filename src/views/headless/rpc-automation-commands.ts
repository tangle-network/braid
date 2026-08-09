import type { HeadlessCommandName } from '../shared/headless-commands.js'

export type AutomationRpcCommand = Extract<
  HeadlessCommandName,
  | 'automation_create'
  | 'automation_update'
  | 'automation_dry_run'
  | 'automation_disable'
  | 'automation_delete'
  | 'automation_list'
>

export const AUTOMATION_PARAMETER_KEYS: Readonly<Record<AutomationRpcCommand, readonly string[]>> =
  {
    automation_create: [
      'ruleId',
      'runId',
      'interactionId',
      'request',
      'answer',
      'responseScope',
      'matcher',
      'context',
      'expiresAt',
      'maximumUses',
      'confirmPersistent',
      'creationSource',
    ],
    automation_update: [
      'ruleId',
      'runId',
      'interactionId',
      'request',
      'answer',
      'responseScope',
      'matcher',
      'context',
      'expiresAt',
      'maximumUses',
      'confirmPersistent',
      'creationSource',
    ],
    automation_dry_run: ['runId', 'interactionId', 'context'],
    automation_disable: ['ruleId'],
    automation_delete: ['ruleId'],
    automation_list: [],
  }

export type AutomationParameterType = 'string' | 'boolean' | 'number' | 'record'

export const AUTOMATION_PARAMETER_TYPES: Readonly<
  Record<AutomationRpcCommand, Readonly<Record<string, AutomationParameterType>>>
> = {
  automation_create: {
    ruleId: 'string',
    runId: 'string',
    interactionId: 'string',
    request: 'record',
    answer: 'record',
    responseScope: 'string',
    matcher: 'record',
    context: 'record',
    expiresAt: 'string',
    maximumUses: 'number',
    confirmPersistent: 'boolean',
    creationSource: 'string',
  },
  automation_update: {
    ruleId: 'string',
    runId: 'string',
    interactionId: 'string',
    request: 'record',
    answer: 'record',
    responseScope: 'string',
    matcher: 'record',
    context: 'record',
    expiresAt: 'string',
    maximumUses: 'number',
    confirmPersistent: 'boolean',
    creationSource: 'string',
  },
  automation_dry_run: { runId: 'string', interactionId: 'string', context: 'record' },
  automation_disable: { ruleId: 'string' },
  automation_delete: { ruleId: 'string' },
  automation_list: {},
}

export const AUTOMATION_REQUIRED_PARAMETERS: Readonly<
  Partial<Record<AutomationRpcCommand, readonly string[]>>
> = {
  automation_create: ['ruleId', 'answer', 'responseScope'],
  automation_update: ['ruleId'],
  automation_dry_run: ['runId', 'interactionId'],
  automation_disable: ['ruleId'],
  automation_delete: ['ruleId'],
}
