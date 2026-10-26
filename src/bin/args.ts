const UI_FIXTURES = [
  'interaction',
  'fork',
  'analysis',
  'comparison',
  'product-demo',
  'supervision',
  'native-children',
  'cancellation-unavailable',
  'profile-handoff',
] as const

export interface CliOptions {
  readonly mode: 'tui' | 'rpc'
  readonly plain: boolean
  readonly reauthenticate?: true
  readonly fixture?: 'deterministic'
  readonly uiFixture?: (typeof UI_FIXTURES)[number]
  readonly inline: boolean
  readonly noColor: boolean
  readonly highContrast: boolean
  readonly reducedMotion: boolean
  readonly workspace: string
  readonly config?: string
  readonly conversation?: string
  readonly remoteEndpointEnv?: string
  readonly prompt?: string
  readonly profile?: string
  readonly connection?: string
  readonly runner?: string
  readonly model?: string
  readonly effort?: string
  readonly databaseKeyFile?: string
  readonly recordState?: string
  readonly help: boolean
  readonly version: boolean
}

export const HELP = `braid — a universal terminal interface for agent profiles

Usage:
  braid [options]
  braid rpc [options]

Options:
  --workspace <path>          Workspace to open (default: current directory)
  --config <path>             Production profile and connection configuration
  --reauthenticate            Replace credentials in the existing configuration
  --inline                    Render in the main terminal buffer
  --plain                     Emit a readable non-interactive event stream
  --no-color                  Disable color
  --high-contrast              Use high-contrast semantic colors
  --reduced-motion             Replace motion with stable status text
  --conversation <id>         Open a conversation by id
  --remote-env <NAME>         Open a Runtime graph using a protected environment reference
  --prompt <text>             Send one initial message after connection setup
  --profile <name|path>        Select a published profile or canonical profile file
  --connection <id>            Select a connection for the run
  --runner <name>              Set a run-level runner preference
  --model <name>               Set a run-level model preference
  --effort <level>             Set a run-level effort preference
  --database-key-file <path>   Use a protected 0600 headless SQLite key file
  --fixture deterministic     Use the clearly labelled offline test provider
  --ui-fixture <name>         Render a named visual verification fixture
  --record-state <path>       Write final semantic state and events for verification
  -h, --help                  Show help
  -v, --version               Show version
`

export class CliUsageError extends Error {
  override readonly name = 'CliUsageError'
}

function requiredValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('-')) throw new CliUsageError(`${flag} requires a value`)
  return value
}

const VALUE_FLAGS = {
  '--workspace': 'workspace',
  '--config': 'config',
  '--record-state': 'recordState',
  '--conversation': 'conversation',
  '--remote-env': 'remoteEndpointEnv',
  '--prompt': 'prompt',
  '--profile': 'profile',
  '--connection': 'connection',
  '--runner': 'runner',
  '--model': 'model',
  '--effort': 'effort',
  '--database-key-file': 'databaseKeyFile',
} as const

export function parseArgs(argv: readonly string[], cwd: string): CliOptions {
  const options: { -readonly [Key in keyof CliOptions]: CliOptions[Key] } = {
    mode: 'tui',
    plain: false,
    inline: false,
    noColor: false,
    highContrast: false,
    reducedMotion: false,
    workspace: cwd,
    help: false,
    version: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === 'rpc' && index === 0) options.mode = 'rpc'
    else if (argument === '--inline') options.inline = true
    else if (argument === '--plain') options.plain = true
    else if (argument === '--reauthenticate') options.reauthenticate = true
    else if (argument === '--no-color') options.noColor = true
    else if (argument === '--high-contrast') options.highContrast = true
    else if (argument === '--reduced-motion') options.reducedMotion = true
    else if (argument !== undefined && Object.hasOwn(VALUE_FLAGS, argument)) {
      options[VALUE_FLAGS[argument as keyof typeof VALUE_FLAGS]] = requiredValue(
        argv,
        index,
        argument,
      )
      index += 1
    } else if (argument === '--fixture') {
      const value = requiredValue(argv, index, argument)
      if (value !== 'deterministic')
        throw new CliUsageError('--fixture supports only "deterministic"')
      options.fixture = value
      index += 1
    } else if (argument === '--ui-fixture') {
      const value = requiredValue(argv, index, argument)
      if (!UI_FIXTURES.includes(value as NonNullable<CliOptions['uiFixture']>))
        throw new CliUsageError(
          '--ui-fixture supports "interaction", "fork", "analysis", "comparison", "product-demo", "supervision", "native-children", "cancellation-unavailable", or "profile-handoff"',
        )
      options.uiFixture = value as NonNullable<CliOptions['uiFixture']>
      index += 1
    } else if (argument === '-h' || argument === '--help') options.help = true
    else if (argument === '-v' || argument === '--version') options.version = true
    else if (argument?.startsWith('-'))
      throw new CliUsageError(
        /^--?[a-z][a-z0-9-]*$/iu.test(argument) ? `Unknown option: ${argument}` : 'Unknown option',
      )
    else throw new CliUsageError('Unknown command; expected "rpc" or an option')
  }

  if (options.uiFixture !== undefined && options.fixture !== 'deterministic') {
    throw new CliUsageError('--ui-fixture requires --fixture deterministic')
  }

  if (
    options.reauthenticate &&
    (options.mode === 'rpc' || options.plain || options.fixture !== undefined)
  ) {
    throw new CliUsageError('--reauthenticate requires the production interactive terminal')
  }

  if (
    options.mode === 'rpc' &&
    (options.remoteEndpointEnv !== undefined || options.prompt !== undefined)
  )
    throw new CliUsageError('Use the refresh_supervision and send JSONL commands in rpc mode')
  if (
    options.remoteEndpointEnv !== undefined &&
    !/^[A-Z_][A-Z0-9_]*$/u.test(options.remoteEndpointEnv)
  )
    throw new CliUsageError('--remote-env requires an environment variable name')

  if (
    options.remoteEndpointEnv !== undefined &&
    (options.prompt !== undefined || options.reauthenticate)
  )
    throw new CliUsageError('--remote-env cannot be combined with --prompt or --reauthenticate')

  return options
}
