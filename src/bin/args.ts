export interface CliOptions {
  readonly mode: 'tui' | 'rpc'
  readonly plain: boolean
  readonly fixture?: 'deterministic'
  readonly uiFixture?: 'interaction' | 'fork'
  readonly inline: boolean
  readonly noColor: boolean
  readonly highContrast: boolean
  readonly reducedMotion: boolean
  readonly workspace: string
  readonly conversation?: string
  readonly profile?: string
  readonly connection?: string
  readonly runner?: string
  readonly model?: string
  readonly effort?: string
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
  --inline                    Render in the main terminal buffer
  --plain                     Emit a readable non-interactive event stream
  --no-color                  Disable color
  --high-contrast              Use high-contrast semantic colors
  --reduced-motion             Replace motion with stable status text
  --conversation <id>         Open a conversation by id
  --profile <ref>              Select a profile for the run
  --connection <id>            Select a connection for the run
  --runner <name>              Set a run-level runner preference
  --model <name>               Set a run-level model preference
  --effort <level>             Set a run-level effort preference
  --fixture deterministic     Use the clearly labelled offline test provider
  --ui-fixture <name>         Render a real interaction or fork preview fixture
  --record-state <path>       Write final semantic state and events for verification
  -h, --help                  Show help
  -v, --version               Show version
`

function requiredValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`)
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
  let conversation: string | undefined
  let profile: string | undefined
  let connection: string | undefined
  let runner: string | undefined
  let model: string | undefined
  let effort: string | undefined
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
    } else if (argument === '--record-state') {
      recordState = requiredValue(argv, index, argument)
      index += 1
    } else if (argument === '--fixture') {
      const value = requiredValue(argv, index, argument)
      if (value !== 'deterministic') throw new Error(`Unknown fixture: ${value}`)
      fixture = value
      index += 1
    } else if (argument === '--ui-fixture') {
      const value = requiredValue(argv, index, argument)
      if (value !== 'interaction' && value !== 'fork')
        throw new Error(`Unknown UI fixture: ${value}`)
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
    } else if (argument === '-h' || argument === '--help') help = true
    else if (argument === '-v' || argument === '--version') version = true
    else throw new Error(`Unknown argument: ${argument}`)
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
    ...(conversation ? { conversation } : {}),
    ...(profile ? { profile } : {}),
    ...(connection ? { connection } : {}),
    ...(runner ? { runner } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(recordState ? { recordState } : {}),
    help,
    version,
  }
}
