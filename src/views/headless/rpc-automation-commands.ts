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

export type AutomationParameterType = 'string' | 'boolean' | 'number' | 'record'

const RULE_PARAMETER_TYPES = {
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
} as const

export const AUTOMATION_PARAMETER_TYPES: Readonly<
  Record<AutomationRpcCommand, Readonly<Record<string, AutomationParameterType>>>
> = {
  automation_create: RULE_PARAMETER_TYPES,
  automation_update: RULE_PARAMETER_TYPES,
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
