export interface CliOptions {
  readonly mode: 'tui' | 'rpc' | 'eval'
  readonly fixture?: 'deterministic'
  readonly inline: boolean
  readonly noColor: boolean
  readonly workspace: string
  readonly recordState?: string
  readonly help: boolean
  readonly version: boolean
  readonly traceFile?: string
  readonly sourceMetadata?: string
  readonly repository?: string
  readonly model?: string
  readonly baseUrl?: string
  readonly operationId?: string
  readonly evaluationInputs?: string
}

export const HELP = `braid — a universal terminal interface for agent profiles

Usage:
  braid [options]
  braid rpc [options]
  braid eval --trace-file <path> --source-metadata <path> --model <id> --evaluation-inputs <path>

Options:
  --workspace <path>          Workspace to open (default: current directory)
  --inline                    Render in the main terminal buffer
  --no-color                  Disable color
  --fixture deterministic     Use the clearly labelled offline test provider
  --record-state <path>       Write final semantic state and events for verification
  eval options: --trace-file <path>, --source-metadata <path>, --model <id>,
                --evaluation-inputs <path>, --repository <path>, --base-url <url>,
                --operation-id <id>
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
  let fixture: CliOptions['fixture']
  let inline = false
  let noColor = false
  let workspace = cwd
  let recordState: string | undefined
  let help = false
  let version = false
  type EvalOption =
    | 'traceFile'
    | 'sourceMetadata'
    | 'repository'
    | 'model'
    | 'baseUrl'
    | 'operationId'
    | 'evaluationInputs'
  const evalValues: Partial<Record<EvalOption, string>> = {}

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument) continue
    if (argument === 'rpc' && index === 0) mode = 'rpc'
    else if (argument === 'eval' && index === 0) mode = 'eval'
    else if (argument === '--inline') inline = true
    else if (argument === '--no-color') noColor = true
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
    } else if (
      mode === 'eval' &&
      [
        '--trace-file',
        '--source-metadata',
        '--repository',
        '--model',
        '--base-url',
        '--operation-id',
        '--evaluation-inputs',
      ].includes(argument)
    ) {
      const value = requiredValue(argv, index, argument)
      const key = {
        '--trace-file': 'traceFile',
        '--source-metadata': 'sourceMetadata',
        '--repository': 'repository',
        '--model': 'model',
        '--base-url': 'baseUrl',
        '--operation-id': 'operationId',
        '--evaluation-inputs': 'evaluationInputs',
      }[argument] as EvalOption
      evalValues[key] = value
      index += 1
    } else if (argument === '-h' || argument === '--help') help = true
    else if (argument === '-v' || argument === '--version') version = true
    else throw new Error(`Unknown argument: ${argument}`)
  }

  return {
    mode,
    ...(fixture ? { fixture } : {}),
    inline,
    noColor,
    workspace,
    ...(recordState ? { recordState } : {}),
    help,
    version,
    ...evalValues,
  }
}
