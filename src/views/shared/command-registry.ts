import type { SelectItem } from '@earendil-works/pi-tui'
import {
  SHARED_COMMAND_NAMES,
  SHARED_COMMAND_TABLE,
  type SharedCommandName,
  sharedCommand,
} from './command-table.js'
import type { HeadlessCommandName } from './headless-commands.js'
import type { BraidIntent } from './intents.js'
import type { CapabilityMap } from './models.js'

export const COMMAND_NAMES = SHARED_COMMAND_NAMES

export type CommandName = SharedCommandName

export type RegisteredCommandIntent = Extract<
  BraidIntent,
  { readonly type: 'run-command' | 'open-surface' | 'shutdown' }
>

export type CommandIntentFactory = (
  args: readonly string[],
  operationId?: string,
) => RegisteredCommandIntent

export interface CommandDefinition {
  readonly name: CommandName
  readonly aliases: readonly string[]
  readonly description: string
  readonly usage: string
  readonly capability: string
  readonly confirmation: 'none' | 'explicit'
  readonly requiresOperationId: boolean
  readonly headlessIdentity: string
  readonly headlessCommands: readonly HeadlessCommandName[]
  readonly mutatingHeadlessCommands: readonly HeadlessCommandName[]
  readonly intent: CommandIntentFactory
}

const HEADLESS_COMMANDS_FOR = Object.freeze(
  Object.fromEntries(
    SHARED_COMMAND_TABLE.map((entry) => [entry.name, entry.headlessCommands]),
  ) as unknown as Record<CommandName, readonly HeadlessCommandName[]>,
)

const runCommandIntent =
  (command: CommandName): CommandIntentFactory =>
  (args, operationId) => ({
    type: 'run-command',
    command,
    args,
    ...(operationId ? { operationId } : {}),
  })

const INTENTS_FOR: Readonly<Record<CommandName, CommandIntentFactory>> = {
  new: runCommandIntent('new'),
  open: runCommandIntent('open'),
  profile: runCommandIntent('profile'),
  connection: runCommandIntent('connection'),
  runner: runCommandIntent('runner'),
  model: runCommandIntent('model'),
  effort: runCommandIntent('effort'),
  branch: runCommandIntent('branch'),
  clone: runCommandIntent('clone'),
  fork: runCommandIntent('fork'),
  graph: (args) => ({
    type: 'open-surface',
    surface: 'graph',
    ...(args.length === 0 ? {} : { query: args.join(' ') }),
  }),
  ask: runCommandIntent('ask'),
  analyze: runCommandIntent('analyze'),
  compare: runCommandIntent('compare'),
  approve: runCommandIntent('approve'),
  reject: runCommandIntent('reject'),
  automate: runCommandIntent('automate'),
  queue: runCommandIntent('queue'),
  steer: runCommandIntent('steer'),
  cancel: runCommandIntent('cancel'),
  detach: runCommandIntent('detach'),
  reconnect: runCommandIntent('reconnect'),
  reconcile: runCommandIntent('reconcile'),
  activity: () => ({ type: 'open-surface', surface: 'activity' }),
  export: runCommandIntent('export'),
  import: runCommandIntent('import'),
  settings: () => ({ type: 'open-surface', surface: 'settings' }),
  help: (args) => ({
    type: 'open-surface',
    surface: 'help',
    ...(args.length > 0 ? { query: args.join(' ') } : {}),
  }),
  quit: (_args, operationId) => ({
    type: 'shutdown',
    operationId: operationId ?? '',
  }),
}

const DEFINITIONS: readonly CommandDefinition[] = [
  ['new', [], 'Create an empty conversation', '/new', 'conversation.create', 'explicit'],
  ['open', [], 'Search and open conversations', '/open [query]', 'conversation.open', 'explicit'],
  [
    'profile',
    [],
    'Inspect, select, import, or edit a profile',
    '/profile [ref]',
    'profile.select',
    'explicit',
  ],
  [
    'connection',
    [],
    'Inspect, create, test, select, or remove a connection',
    '/connection [list|create|test|select|remove] [id]',
    'connection.select',
    'explicit',
  ],
  ['runner', [], 'Set the runner for this branch', '/runner [name]', 'run.runner', 'explicit'],
  ['model', [], 'Set the model for this branch', '/model [name]', 'run.model', 'explicit'],
  [
    'effort',
    [],
    'Set reasoning effort for this branch',
    '/effort [level]',
    'run.effort',
    'explicit',
  ],
  [
    'branch',
    [],
    'Create a branch at a message boundary',
    '/branch [message]',
    'conversation.branch',
    'explicit',
  ],
  [
    'clone',
    [],
    'Clone the active branch into a conversation',
    '/clone',
    'conversation.clone',
    'explicit',
  ],
  [
    'fork',
    [],
    'Preview or create a conversation or workspace fork',
    '/fork [--workspace]',
    'conversation.fork',
    'explicit',
  ],
  ['graph', [], 'Open the conversation and run graph', '/graph [query]', 'graph.read', 'none'],
  ['ask', [], 'Analyze a frozen run with citations', '/ask <question>', 'analysis.ask', 'explicit'],
  [
    'analyze',
    [],
    'Run a named trace-analysis recipe',
    '/analyze <failure|cost|tools|improvement>',
    'analysis.recipe',
    'explicit',
  ],
  [
    'compare',
    [],
    'Compare two frozen sources',
    '/compare <left> <right>',
    'analysis.compare',
    'explicit',
  ],
  [
    'approve',
    [],
    'Accept the focused interaction',
    '/approve [scope]',
    'interaction.respond',
    'explicit',
  ],
  [
    'reject',
    [],
    'Decline the focused interaction',
    '/reject [feedback]',
    'interaction.respond',
    'explicit',
  ],
  [
    'automate',
    [],
    'Inspect or change interaction rules',
    '/automate [list|create|update|dry-run|disable|delete]',
    'interaction.automation',
    'explicit',
  ],
  ['queue', [], 'Queue input for the next turn', '/queue <text>', 'run.queue', 'explicit'],
  ['steer', [], 'Steer the active run when supported', '/steer <text>', 'run.steer', 'explicit'],
  ['cancel', [], 'Request explicit run cancellation', '/cancel', 'run.cancel', 'explicit'],
  [
    'detach',
    [],
    'Leave a retained run active in the background',
    '/detach [run-id]',
    'run.detach',
    'explicit',
  ],
  [
    'reconnect',
    [],
    'Resume a detached retained run',
    '/reconnect [run-id]',
    'run.reconnect',
    'explicit',
  ],
  [
    'reconcile',
    [],
    'Refresh a detached run from provider state',
    '/reconcile [run-id]',
    'run.reconcile',
    'explicit',
  ],
  [
    'activity',
    [],
    'Open run, tool, worker, and usage activity',
    '/activity',
    'activity.read',
    'none',
  ],
  ['export', [], 'Export selected redacted data', '/export', 'export.create', 'explicit'],
  [
    'import',
    [],
    'Import a redacted Braid conversation file',
    '/import <path>',
    'conversation.create',
    'explicit',
  ],
  [
    'settings',
    [],
    'Open appearance and application settings',
    '/settings',
    'settings.open',
    'none',
  ],
  [
    'help',
    ['?'],
    'Search commands, keys, and capability explanations',
    '/help [query]',
    'help.read',
    'none',
  ],
  ['quit', ['exit'], 'Persist state and leave Braid', '/quit', 'application.quit', 'none'],
].map(([name, aliases, description, usage, capability, confirmation]) => {
  const table = sharedCommand(name as string)
  return {
    name: name as CommandName,
    aliases: aliases as readonly string[],
    description: description as string,
    usage: usage as string,
    capability: capability as string,
    confirmation: confirmation as 'none' | 'explicit',
    requiresOperationId: table?.requiresOperationId ?? confirmation === 'explicit',
    headlessIdentity: `braid.command.${name as string}`,
    headlessCommands: HEADLESS_COMMANDS_FOR[name as CommandName],
    mutatingHeadlessCommands: table?.mutatingHeadlessCommands ?? [],
    intent: INTENTS_FOR[name as CommandName],
  }
})

const BY_NAME = new Map<string, CommandDefinition>()
for (const definition of DEFINITIONS) {
  BY_NAME.set(definition.name, definition)
  for (const alias of definition.aliases) BY_NAME.set(alias, definition)
}

export const COMMAND_DEFINITIONS: readonly CommandDefinition[] = Object.freeze(DEFINITIONS)

export interface CommandAvailability {
  readonly definition: CommandDefinition
  readonly available: boolean
  readonly reason?: string
}

export function commandDefinition(name: string): CommandDefinition | undefined {
  return BY_NAME.get(name)
}

export function commandIntent(
  name: CommandName,
  args: readonly string[],
  operationId?: string,
): RegisteredCommandIntent {
  const definition = commandDefinition(name)
  if (!definition) throw new Error(`Unknown command ${name}`)
  return definition.intent(args, operationId)
}

export function commandAvailability(
  name: CommandName,
  capabilities: CapabilityMap,
): CommandAvailability {
  const definition = BY_NAME.get(name)
  if (!definition) throw new Error(`Unknown command ${name}`)
  const capability = capabilities[definition.capability]
  if (!capability) {
    return {
      definition,
      available: false,
      reason: 'The provider did not report this capability',
    }
  }
  if (capability.available) return { definition, available: true }
  return {
    definition,
    available: false,
    reason: capability.reason ?? 'The current connection does not report this capability',
  }
}

export function commandItems(capabilities: CapabilityMap): SelectItem[] {
  return COMMAND_DEFINITIONS.map((definition) => {
    const availability = commandAvailability(definition.name, capabilities)
    return {
      value: definition.name,
      label: `/${definition.name}`,
      description: availability.available
        ? definition.description
        : `unavailable — ${availability.reason ?? 'capability not reported'}`,
    }
  })
}

export type ParsedCommand =
  | { readonly kind: 'prompt'; readonly text: string }
  | {
      readonly kind: 'command'
      readonly name: CommandName
      readonly args: readonly string[]
      readonly raw: string
    }
  | {
      readonly kind: 'unknown'
      readonly raw: string
      readonly name: string
      readonly suggestions: readonly CommandName[]
    }
  | { readonly kind: 'invalid'; readonly raw: string; readonly message: string }

function tokenize(input: string): { readonly tokens: readonly string[]; readonly error?: string } {
  const tokens: string[] = []
  let token = ''
  let quote: 'single' | 'double' | undefined
  let escaped = false
  for (const character of input) {
    if (escaped) {
      token += character
      escaped = false
    } else if (character === '\\') {
      escaped = true
    } else if (quote === 'single' && character === "'") {
      quote = undefined
    } else if (quote === 'double' && character === '"') {
      quote = undefined
    } else if (!quote && (character === "'" || character === '"')) {
      quote = character === "'" ? 'single' : 'double'
    } else if (!quote && /\s/u.test(character)) {
      if (token) tokens.push(token)
      token = ''
    } else {
      token += character
    }
  }
  if (escaped) token += '\\'
  if (quote) return { tokens, error: 'Unclosed quote in command' }
  if (token) tokens.push(token)
  return { tokens }
}

function editDistance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = row[0] ?? 0
    row[0] = leftIndex
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = row[rightIndex] ?? 0
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1
      row[rightIndex] = Math.min((row[rightIndex - 1] ?? 0) + 1, above + 1, diagonal + cost)
      diagonal = above
    }
  }
  return row[right.length] ?? left.length
}

function suggestionsFor(name: string): readonly CommandName[] {
  return COMMAND_DEFINITIONS.map((definition) => ({
    name: definition.name,
    score: Math.min(editDistance(name, definition.name), name.length + 2),
  }))
    .filter((candidate) => candidate.score <= Math.max(3, Math.ceil(name.length / 2)))
    .sort((left, right) => left.score - right.score || left.name.localeCompare(right.name))
    .slice(0, 5)
    .map((candidate) => candidate.name)
}

export function parseCommandInput(input: string): ParsedCommand {
  if (!input.startsWith('/')) return { kind: 'prompt', text: input }
  if (input.startsWith('//')) return { kind: 'prompt', text: input.slice(1) }
  const tokenized = tokenize(input.slice(1))
  if (tokenized.error) return { kind: 'invalid', raw: input, message: tokenized.error }
  const [name, ...args] = tokenized.tokens
  if (!name) return { kind: 'invalid', raw: input, message: 'Enter a command after /' }
  const definition = commandDefinition(name)
  if (!definition) {
    return { kind: 'unknown', raw: input, name, suggestions: suggestionsFor(name) }
  }
  return { kind: 'command', name: definition.name, args, raw: input }
}

export function completeCommands(
  input: string,
  capabilities: CapabilityMap,
): readonly CommandAvailability[] {
  const query = input.replace(/^\//u, '').toLowerCase()
  return COMMAND_DEFINITIONS.filter((definition) =>
    [definition.name, ...definition.aliases, definition.description].some((value) =>
      value.toLowerCase().includes(query),
    ),
  ).map((definition) => commandAvailability(definition.name, capabilities))
}

export function isMutatingCommand(name: CommandName): boolean {
  return sharedCommand(name)?.requiresOperationId ?? false
}
