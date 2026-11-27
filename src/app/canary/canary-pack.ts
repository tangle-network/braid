/**
 * Learn a procedure pack per skill from the user's past sessions.
 *
 * A procedure contract states procedures as trace-contract rules over what an
 * agent ran and said, for example "a check's output is never piped into
 * `tail`". Braid reads every Claude Code and Codex session in the window,
 * checks each against the contract while reading it, and for each skill
 * counts the sessions that used the skill and broke each rule. A skill's pack
 * is the procedures its own sessions broke most, each with how often, in the
 * words the procedure catalog gives the rule. A skill whose sessions broke no
 * rule often enough gets no pack, so a brief naming it is not eligible.
 */

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TraceContractSpec } from '@tangle-network/agent-eval'
import { canonicalJson } from '../../domain/canonical.js'
import { AppError } from '../errors.js'
import { type HarnessSessionPaths, readHarnessSessions, sessionsInvoking } from '../learning/learning-sources.js'
import { canaryDigest } from './canary-ledger.js'
import type { PackManifest } from './canary-protocol.js'

export interface LearnPacksOptions {
  readonly contract: TraceContractSpec
  /** Each rule label of the contract, as the procedure to follow. */
  readonly procedures: Readonly<Record<string, string>>
  readonly out: string
  readonly sinceMs: number
  readonly untilMs: number
  readonly paths: HarnessSessionPaths
  /** Only these skills; default every skill the sessions invoked. */
  readonly skills?: readonly string[]
  /** A skill needs this many checked sessions to get a pack. Default 5. */
  readonly minSessions?: number
  /** A procedure enters a pack when this many of the skill's sessions broke it. Default 2. */
  readonly minRuleSessions?: number
  /** Procedures per pack. Default 6. */
  readonly maxProcedures?: number
}

export interface LearnedSkill {
  readonly sessions: number
  /** Sessions whose check could not evaluate a rule; they are left out of `sessions`. */
  readonly unchecked: number
  readonly rules: readonly { readonly rule: string; readonly sessions: number }[]
  readonly file: string | null
  readonly digest: string | null
}

export interface LearnedPacks extends PackManifest {
  readonly since: string
  readonly until: string
  readonly contract: string
  readonly contractDigest: string
  readonly sessionsRead: number
  readonly learned: Readonly<Record<string, LearnedSkill>>
}

function packText(
  skill: string,
  sessions: number,
  since: string,
  until: string,
  lines: readonly { readonly procedure: string; readonly sessions: number }[],
): string {
  return [
    `## Procedures learned from past ${skill} sessions`,
    '',
    `Braid read ${sessions} sessions from ${since.slice(0, 10)} to ${until.slice(0, 10)} that used ${skill}.`,
    'Agents in them broke these procedures. Follow each one in this task.',
    '',
    ...lines.map((line) => `- ${line.procedure} (broken in ${line.sessions} of ${sessions} sessions)`),
    '',
  ].join('\n')
}

export async function learnPacks(options: LearnPacksOptions): Promise<LearnedPacks> {
  const { compileTraceContractSpec } = await import('@tangle-network/agent-eval')
  const contract = compileTraceContractSpec(options.contract)
  const labels = (options.contract.rules ?? []).map((rule) => rule.label)
  if (labels.length === 0 || labels.some((label) => typeof label !== 'string'))
    throw new AppError('CANARY_CONTRACT_INVALID', 'Every procedure rule needs a label')
  for (const label of labels as string[])
    if (typeof options.procedures[label] !== 'string' || options.procedures[label] === '')
      throw new AppError('CANARY_PROCEDURE_MISSING', `The catalog gives no procedure for ${label}`)
  const minSessions = options.minSessions ?? 5
  const minRuleSessions = options.minRuleSessions ?? 2
  const maxProcedures = options.maxProcedures ?? 6
  const since = new Date(options.sinceMs).toISOString()
  const until = new Date(options.untilMs).toISOString()

  const read = await readHarnessSessions(options.paths, options.sinceMs, { contracts: [contract] })
  const window = read.sessions.filter(
    (session) => session.endedAt === null || Date.parse(session.endedAt) < options.untilMs,
  )
  const skills =
    options.skills ?? [...new Set((read.usage?.rows ?? []).map((row) => row.skill))].sort()
  mkdirSync(options.out, { recursive: true, mode: 0o700 })
  chmodSync(options.out, 0o700)
  const manifest: Record<string, { file: string; digest: string }> = {}
  const learned: Record<string, LearnedSkill> = {}
  for (const skill of skills) {
    const invoking = sessionsInvoking(window, skill, options.sinceMs)
    const checks = invoking.map((session) => session.contractChecks?.[0])
    const checked = checks.filter((check) => check !== undefined && check.status !== 'error')
    const counts = new Map<string, number>()
    for (const check of checked)
      for (const [rule, violations] of Object.entries(check?.violations ?? {}))
        if (violations > 0) counts.set(rule, (counts.get(rule) ?? 0) + 1)
    const rules = [...counts]
      .map(([rule, sessions]) => ({ rule, sessions }))
      .sort((a, b) => b.sessions - a.sessions || a.rule.localeCompare(b.rule))
    const chosen =
      checked.length < minSessions
        ? []
        : rules.filter((rule) => rule.sessions >= minRuleSessions).slice(0, maxProcedures)
    let file: string | null = null
    let digest: string | null = null
    if (chosen.length > 0) {
      const text = packText(
        skill,
        checked.length,
        since,
        until,
        chosen.map((rule) => ({
          procedure: options.procedures[rule.rule] as string,
          sessions: rule.sessions,
        })),
      )
      file = `${skill.replace(/[^A-Za-z0-9_.-]/gu, '_')}.md`
      digest = canaryDigest(text)
      writeFileSync(join(options.out, file), text, { mode: 0o600 })
      manifest[skill] = { file, digest }
    }
    learned[skill] = {
      sessions: checked.length,
      unchecked: invoking.length - checked.length,
      rules,
      file,
      digest,
    }
  }
  const result: LearnedPacks = {
    since,
    until,
    contract: options.contract.name,
    contractDigest: canaryDigest(canonicalJson(options.contract)),
    sessionsRead: window.length,
    skills: manifest,
    learned,
  }
  writeFileSync(join(options.out, 'manifest.json'), `${JSON.stringify(result, null, 2)}\n`, {
    mode: 0o600,
  })
  return result
}
