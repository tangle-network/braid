/**
 * `braid assign` and `braid canary`: the randomized canary of learned
 * procedure packs, outside the terminal interface.
 *
 *   braid assign <task-id> --skill <name> --repository <owner/name>
 *   braid canary pack --contract <file> --procedures <file> --out <dir> [--days <n>]
 *   braid canary seal --protocol <file>
 *   braid canary status
 *
 * Every command reads the canary configuration from `--config`, else
 * `BRAID_CANARY_CONFIG`, else `canary/config.json` in Braid's data directory.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assignTask,
  type CanaryProtocolInput,
  canaryStatus,
  readCanaryConfig,
  sealCanary,
} from '../app/canary/canary-protocol.js'
import { learnPacks } from '../app/canary/canary-pack.js'
import { defaultBraidDataDirectory, defaultLearningConfiguration } from './state-path.js'

export const CANARY_HELP = `braid assign — put one delegated task brief in a canary arm

Usage:
  braid assign <task-id> --skill <name> --repository <owner/name> [--format text|json]
  braid canary pack --contract <file> --procedures <file> --out <dir> [--days <n>] [--skills <a,b>]
  braid canary seal --protocol <file>
  braid canary status [--format text|json]

Options:
  --config <path>   Canary configuration (default: BRAID_CANARY_CONFIG, else canary/config.json in Braid's data directory)

assign prints the arm and what to append to the brief: the skill's sealed pack in the
candidate arm, and in both arms the line every pull request of the task repeats.
A task that already holds an assignment gets the same one back. Exit 3 means the
task is not eligible; send the brief as written.
`

class UsageError extends Error {}

function parse(argv: readonly string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = []
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] as string
    if (argument === '-h' || argument === '--help') {
      flags.set('help', 'true')
      continue
    }
    if (argument.startsWith('--')) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--'))
        throw new UsageError(`${argument} requires a value`)
      flags.set(argument.slice(2), value)
      index++
      continue
    }
    positional.push(argument)
  }
  return { positional, flags }
}

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name)
  if (value === undefined) throw new UsageError(`--${name} is required`)
  return value
}

function configPath(flags: Map<string, string>): string {
  return (
    flags.get('config') ??
    (process.env.BRAID_CANARY_CONFIG?.trim() ||
      join(defaultBraidDataDirectory(), 'canary', 'config.json'))
  )
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  const { positional, flags } = parse(command === 'canary' ? rest.slice(1) : rest)
  if (flags.has('help')) {
    process.stdout.write(CANARY_HELP)
    return 0
  }
  const format = flags.get('format') ?? 'text'
  if (format !== 'text' && format !== 'json') throw new UsageError('--format is text or json')
  const json = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)

  if (command === 'assign') {
    const [taskId, extra] = positional
    if (taskId === undefined || extra !== undefined)
      throw new UsageError('braid assign takes one task id')
    const result = assignTask(readCanaryConfig(configPath(flags)), {
      taskId,
      skill: required(flags, 'skill'),
      repository: required(flags, 'repository'),
    })
    if (format === 'json') json(result)
    else if (result.status === 'ineligible')
      process.stdout.write(`not eligible: ${result.reason}\nSend the brief as written.\n`)
    else
      process.stdout.write(
        `arm: ${result.arm}\nassignment: ${result.assignmentId} (${result.status})\n\nAppend to the brief:\n\n${result.append}\n`,
      )
    return result.status === 'ineligible' ? 3 : 0
  }

  const action = rest[0]
  if (action === 'pack') {
    const days = Number(flags.get('days') ?? '30')
    if (!Number.isFinite(days) || days <= 0) throw new UsageError('--days is a positive number')
    const untilMs = Date.now()
    const learning = defaultLearningConfiguration()
    const result = await learnPacks({
      contract: readJson(required(flags, 'contract')) as never,
      procedures: readJson(required(flags, 'procedures')) as Record<string, string>,
      out: required(flags, 'out'),
      sinceMs: untilMs - days * 86_400_000,
      untilMs,
      paths: {
        claudeCodeProjects: learning.claudeCodeProjects,
        codexSessions: learning.codexSessions,
      },
      ...(flags.has('skills') ? { skills: (flags.get('skills') as string).split(',') } : {}),
    })
    if (format === 'json') json(result)
    else {
      process.stdout.write(
        `read ${result.sessionsRead} sessions from ${result.since} to ${result.until}\n`,
      )
      for (const [skill, learned] of Object.entries(result.learned))
        process.stdout.write(
          `${skill}: ${learned.sessions} sessions, ${learned.file === null ? 'no pack' : `pack ${learned.digest}`}\n`,
        )
    }
    return 0
  }
  if (action === 'seal') {
    const result = await sealCanary(
      readCanaryConfig(configPath(flags)),
      readJson(required(flags, 'protocol')) as CanaryProtocolInput,
    )
    if (format === 'json') json(result)
    else
      process.stdout.write(
        `sealed ${result.experimentId}\nprotocol digest: ${result.protocolDigest}\nledger entry: ${result.entryDigest}\nskills: ${result.skills.join(', ')}\n`,
      )
    return 0
  }
  if (action === 'status') {
    const status = canaryStatus(readCanaryConfig(configPath(flags)))
    if (format === 'json') json(status)
    else
      process.stdout.write(
        `${status.experimentId} sealed ${status.sealedAt} (${status.protocolDigest})\n` +
          `assignments: ${status.assignments.control} control, ${status.assignments.candidate} candidate, ` +
          `${status.repositories} repositories, ${status.dispositions} turned away\n` +
          `accepts until ${status.acceptsUntil}; readout ${status.readoutAt}\n` +
          `ledger tip ${status.tipDigest} after ${status.entries} entries\n`,
      )
    return 0
  }
  throw new UsageError('braid canary takes pack, seal or status')
}

export async function runCanaryCommand(argv: readonly string[]): Promise<number> {
  try {
    return await run(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`error: ${error.message}\n\n${CANARY_HELP}`)
      return 2
    }
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
