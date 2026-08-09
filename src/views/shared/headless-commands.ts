import { SHARED_COMMAND_TABLE } from './command-table.js'

export const HEADLESS_COMMAND_NAMES = [
  'initialize',
  'get_state',
  'subscribe',
  'unsubscribe',
  'list_profiles',
  'select_profile',
  'validate_profile',
  'save_profile',
  'list_connections',
  'upsert_connection',
  'test_connection',
  'select_connection',
  'remove_connection',
  'set_run_override',
  'new_conversation',
  'list_conversations',
  'open_conversation',
  'rename_conversation',
  'archive_conversation',
  'delete_conversation',
  'set_draft',
  'import_conversation',
  'send',
  'queue',
  'remove_queued',
  'steer',
  'cancel',
  'detach',
  'reconnect',
  'reconcile',
  'respond_interaction',
  'cancel_run',
  'branch',
  'clone',
  'plan_fork',
  'execute_fork',
  'ask',
  'analyze',
  'compare',
  'promote_analysis',
  'get_graph',
  'get_activity',
  'get_details',
  'steer_worker',
  'cancel_worker',
  'export',
  'shutdown',
] as const

export type HeadlessCommandName = (typeof HEADLESS_COMMAND_NAMES)[number]

const HEADLESS_ONLY_MUTATIONS: readonly HeadlessCommandName[] = [
  'set_draft',
  'remove_queued',
  'promote_analysis',
  'steer_worker',
  'cancel_worker',
  'cancel',
  'detach',
  'reconnect',
  'reconcile',
  'rename_conversation',
  'archive_conversation',
  'delete_conversation',
]

export const MUTATING_HEADLESS_COMMANDS: readonly HeadlessCommandName[] = Object.freeze(
  [
    ...SHARED_COMMAND_TABLE.flatMap((entry) => entry.mutatingHeadlessCommands),
    ...HEADLESS_ONLY_MUTATIONS,
  ].filter((command, index, all) => all.indexOf(command) === index) as HeadlessCommandName[],
)

export function isMutatingHeadlessCommand(command: HeadlessCommandName): boolean {
  return MUTATING_HEADLESS_COMMANDS.includes(command)
}

const HEADLESS_CAPABILITIES: Readonly<Partial<Record<HeadlessCommandName, string>>> = Object.freeze(
  {
    list_profiles: 'profile.select',
    select_profile: 'profile.select',
    validate_profile: 'profile.select',
    save_profile: 'profile.select',
    list_connections: 'connection.select',
    upsert_connection: 'connection.select',
    test_connection: 'connection.select',
    select_connection: 'connection.select',
    remove_connection: 'connection.select',
    set_run_override: 'run.runner',
    new_conversation: 'conversation.create',
    list_conversations: 'conversation.open',
    open_conversation: 'conversation.open',
    rename_conversation: 'conversation.open',
    archive_conversation: 'conversation.open',
    delete_conversation: 'conversation.open',
    set_draft: 'draft.write',
    import_conversation: 'conversation.create',
    queue: 'run.queue',
    remove_queued: 'run.queue',
    steer: 'run.steer',
    cancel: 'run.cancel',
    detach: 'run.detach',
    reconnect: 'run.reconnect',
    reconcile: 'run.reconcile',
    respond_interaction: 'interaction.respond',
    branch: 'conversation.branch',
    clone: 'conversation.clone',
    plan_fork: 'conversation.fork',
    execute_fork: 'conversation.fork',
    ask: 'analysis.ask',
    analyze: 'analysis.recipe',
    compare: 'analysis.compare',
    promote_analysis: 'analysis.ask',
    steer_worker: 'run.steer',
    cancel_worker: 'run.cancel',
    export: 'export.create',
  },
)

export function capabilityForHeadlessCommand(command: HeadlessCommandName): string | undefined {
  return HEADLESS_CAPABILITIES[command]
}
