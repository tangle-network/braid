export const SHARED_COMMAND_TABLE = [
  {
    name: 'new',
    requiresOperationId: true,
    headlessCommands: ['new_conversation'],
    mutatingHeadlessCommands: ['new_conversation'],
  },
  {
    name: 'open',
    requiresOperationId: true,
    headlessCommands: ['list_conversations', 'open_conversation'],
    mutatingHeadlessCommands: ['open_conversation'],
  },
  {
    name: 'profile',
    requiresOperationId: true,
    headlessCommands: ['list_profiles', 'select_profile', 'validate_profile', 'save_profile'],
    mutatingHeadlessCommands: ['select_profile', 'save_profile'],
  },
  {
    name: 'connection',
    requiresOperationId: true,
    headlessCommands: [
      'list_connections',
      'upsert_connection',
      'test_connection',
      'select_connection',
      'remove_connection',
    ],
    mutatingHeadlessCommands: [
      'upsert_connection',
      'test_connection',
      'select_connection',
      'remove_connection',
    ],
  },
  {
    name: 'runner',
    requiresOperationId: true,
    headlessCommands: ['set_run_override'],
    mutatingHeadlessCommands: ['set_run_override'],
  },
  {
    name: 'model',
    requiresOperationId: true,
    headlessCommands: ['set_run_override'],
    mutatingHeadlessCommands: ['set_run_override'],
  },
  {
    name: 'effort',
    requiresOperationId: true,
    headlessCommands: ['set_run_override'],
    mutatingHeadlessCommands: ['set_run_override'],
  },
  {
    name: 'branch',
    requiresOperationId: true,
    headlessCommands: ['branch'],
    mutatingHeadlessCommands: ['branch'],
  },
  {
    name: 'clone',
    requiresOperationId: true,
    headlessCommands: ['clone'],
    mutatingHeadlessCommands: ['clone'],
  },
  {
    name: 'fork',
    requiresOperationId: true,
    headlessCommands: ['plan_fork', 'execute_fork'],
    mutatingHeadlessCommands: ['plan_fork', 'execute_fork'],
  },
  {
    name: 'graph',
    requiresOperationId: true,
    headlessCommands: ['get_graph'],
    mutatingHeadlessCommands: [],
  },
  {
    name: 'ask',
    requiresOperationId: true,
    headlessCommands: ['ask'],
    mutatingHeadlessCommands: ['ask'],
  },
  {
    name: 'analyze',
    requiresOperationId: true,
    headlessCommands: ['analyze'],
    mutatingHeadlessCommands: ['analyze'],
  },
  {
    name: 'compare',
    requiresOperationId: true,
    headlessCommands: ['compare'],
    mutatingHeadlessCommands: ['compare'],
  },
  {
    name: 'approve',
    requiresOperationId: true,
    headlessCommands: ['respond_interaction'],
    mutatingHeadlessCommands: ['respond_interaction'],
  },
  {
    name: 'reject',
    requiresOperationId: true,
    headlessCommands: ['respond_interaction'],
    mutatingHeadlessCommands: ['respond_interaction'],
  },
  {
    name: 'automate',
    requiresOperationId: true,
    headlessCommands: [
      'automation_list',
      'automation_create',
      'automation_update',
      'automation_dry_run',
      'automation_disable',
      'automation_delete',
    ],
    mutatingHeadlessCommands: [
      'automation_create',
      'automation_update',
      'automation_dry_run',
      'automation_disable',
      'automation_delete',
    ],
  },
  {
    name: 'queue',
    requiresOperationId: true,
    headlessCommands: ['queue'],
    mutatingHeadlessCommands: ['queue'],
  },
  {
    name: 'steer',
    requiresOperationId: true,
    headlessCommands: ['steer'],
    mutatingHeadlessCommands: ['steer'],
  },
  {
    name: 'cancel',
    requiresOperationId: true,
    headlessCommands: ['cancel_run'],
    mutatingHeadlessCommands: ['cancel_run'],
  },
  {
    name: 'detach',
    requiresOperationId: true,
    headlessCommands: ['detach'],
    mutatingHeadlessCommands: ['detach'],
  },
  {
    name: 'reconnect',
    requiresOperationId: true,
    headlessCommands: ['reconnect'],
    mutatingHeadlessCommands: ['reconnect'],
  },
  {
    name: 'reconcile',
    requiresOperationId: true,
    headlessCommands: ['reconcile'],
    mutatingHeadlessCommands: ['reconcile'],
  },
  {
    name: 'activity',
    requiresOperationId: false,
    headlessCommands: ['get_activity'],
    mutatingHeadlessCommands: [],
  },
  {
    name: 'export',
    requiresOperationId: true,
    headlessCommands: ['export'],
    mutatingHeadlessCommands: ['export'],
  },
  {
    name: 'import',
    requiresOperationId: true,
    headlessCommands: ['import_conversation'],
    mutatingHeadlessCommands: ['import_conversation'],
  },
  {
    name: 'settings',
    requiresOperationId: false,
    headlessCommands: [],
    mutatingHeadlessCommands: [],
  },
  {
    name: 'help',
    requiresOperationId: false,
    headlessCommands: [],
    mutatingHeadlessCommands: [],
  },
  {
    name: 'quit',
    requiresOperationId: true,
    headlessCommands: ['shutdown'],
    mutatingHeadlessCommands: ['shutdown'],
  },
] as const

export type SharedCommandName = (typeof SHARED_COMMAND_TABLE)[number]['name']
export type CommandName = SharedCommandName
export const SHARED_COMMAND_NAMES = SHARED_COMMAND_TABLE.map(
  (entry) => entry.name,
) as readonly SharedCommandName[]

export function sharedCommand(name: string): (typeof SHARED_COMMAND_TABLE)[number] | undefined {
  return SHARED_COMMAND_TABLE.find((entry) => entry.name === name)
}
