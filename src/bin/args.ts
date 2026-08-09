export interface CliOptions {
  readonly mode: 'tui' | 'rpc'
  readonly plain: boolean
  readonly fixture?: 'deterministic'
  readonly uiFixture?: 'interaction' | 'fork' | 'analysis' | 'comparison'
  readonly inline: boolean
  readonly noColor: boolean
  readonly highContrast: boolean
  readonly reducedMotion: boolean
  readonly workspace: string
  readonly config?: string
  readonly conversation?: string
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
  --inline                    Render in the main terminal buffer
  --plain                     Emit a readable non-interactive event stream
  --no-color                  Disable color
  --high-contrast              Use high-contrast semantic colors
  --reduced-motion             Replace motion with stable status text
  --conversation <id>         Open a conversation by id
  --profile <path>             Select a canonical profile file for the run
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

export function parseArgs(argv: readonly string[], cwd: string): CliOptions {
  let mode: CliOptions['mode'] = 'tui'
  let plain = false
  let fixture: CliOptions['fixture']
  let uiFixture: CliOptions['uiFixture']
  let inline = false
  let noColor = false
  let highContrast = false
  let reducedMotion = false
  let workspace = cwd
  let config: string | undefined
  let conversation: string | undefined
  let profile: string | undefined
  let connection: string | undefined
  let runner: string | undefined
  let model: string | undefined
  let effort: string | undefined
  let databaseKeyFile: string | undefined
  let recordState: string | undefined
  let help = false
  let version = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === 'rpc' && index === 0) mode = 'rpc'
    else if (argument === '--inline') inline = true
    else if (argument === '--plain') plain = true
    else if (argument === '--no-color') noColor = true
    else if (argument === '--high-contrast') highContrast = true
    else if (argument === '--reduced-motion') reducedMotion = true
    else if (argument === '--workspace') {
      workspace = requiredValue(argv, index, argument)
      index += 1
    } else if (argument === '--config') {
      config = requiredValue(argv, index, argument)
      index += 1
    } else if (argument === '--record-state') {
      recordState = requiredValue(argv, index, argument)
      index += 1
    } else if (argument === '--fixture') {
      const value = requiredValue(argv, index, argument)
      if (value !== 'deterministic')
        throw new CliUsageError('--fixture supports only "deterministic"')
      fixture = value
      index += 1
    } else if (argument === '--ui-fixture') {
      const value = requiredValue(argv, index, argument)
      if (
        value !== 'interaction' &&
        value !== 'fork' &&
        value !== 'analysis' &&
        value !== 'comparison'
      )
        throw new CliUsageError(
          '--ui-fixture supports "interaction", "fork", "analysis", or "comparison"',
        )
      uiFixture = value
      index += 1
    } else if (argument === '--conversation') {
      conversation = requiredValue(argv, index, argument)
      index += 1
    } else if (argument === '--profile') {
      profile = requiredValue(argv, index, argument)
      index += 1
    } else if (argument === '--connection') {
      connection = requiredValue(argv, index, argument)
      index += 1
    } else if (argument === '--runner') {
      runner = requiredValue(argv, index, argument)
      index += 1
    } else if (argument === '--model') {
      model = requiredValue(argv, index, argument)
      index += 1
    } else if (argument === '--effort') {
      effort = requiredValue(argv, index, argument)
      index += 1
    } else if (argument === '--database-key-file') {
      databaseKeyFile = requiredValue(argv, index, argument)
      index += 1
    } else if (argument === '-h' || argument === '--help') help = true
    else if (argument === '-v' || argument === '--version') version = true
    else if (argument?.startsWith('-'))
      throw new CliUsageError(
        /^--?[a-z][a-z0-9-]*$/iu.test(argument) ? `Unknown option: ${argument}` : 'Unknown option',
      )
    else throw new CliUsageError('Unknown command; expected "rpc" or an option')
  }

  return {
    mode,
    plain,
    ...(fixture ? { fixture } : {}),
    ...(uiFixture ? { uiFixture } : {}),
    inline,
    noColor,
    highContrast,
    reducedMotion,
    workspace,
    ...(config ? { config } : {}),
    ...(conversation ? { conversation } : {}),
    ...(profile ? { profile } : {}),
    ...(connection ? { connection } : {}),
    ...(runner ? { runner } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(databaseKeyFile ? { databaseKeyFile } : {}),
    ...(recordState ? { recordState } : {}),
    help,
    version,
  }
}
