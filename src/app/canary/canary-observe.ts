/**
 * The canary's secondary measures, read from this host's own sessions.
 *
 * Every brief in either arm carries its assignment line, so the sessions that
 * did a task are those whose human turns hold `Braid-Assignment: <id>`. For
 * each assignment Braid reads those sessions with the sealed procedure
 * contract, and reports the procedure mistakes they made per rule, the tokens
 * their model calls used, and the span from their first to their last event.
 * Missing evidence stays null: no session found, a check that could not run,
 * or a model call with no recorded usage is never a zero.
 *
 * Sessions live on the host that ran them, so each host reports its own rows;
 * a readout joins them by assignment and session.
 */

import type { SkillSessionRecord, TraceContractSpec } from '@tangle-network/agent-eval'
import { canonicalJson } from '../../domain/canonical.js'
import { AppError } from '../errors.js'
import { type HarnessSessionPaths, readHarnessSessions } from '../learning/learning-sources.js'
import { type AssignmentEntry, canaryDigest, readLedger, syncLedger } from './canary-ledger.js'
import { ASSIGNMENT_LINE_PREFIX, type CanaryConfig } from './canary-protocol.js'

export interface ObservedSession {
  readonly harness: string
  readonly sessionId: string
  readonly firstAt: string | null
  readonly lastAt: string | null
  /** Violations per contract rule; null when the check could not run. */
  readonly mistakes: Readonly<Record<string, number>> | null
  readonly modelCalls: number
  /** Null when a model call recorded no usage. */
  readonly inputTokens: number | null
  readonly outputTokens: number | null
}

export interface ObservedAssignment {
  readonly assignmentId: string
  readonly taskId: string
  readonly skill: string
  readonly repository: string
  readonly arm: string
  readonly assignedAt: string
  readonly sessions: readonly ObservedSession[]
  readonly procedureMistakes: number | null
  readonly mistakesByRule: Readonly<Record<string, number>> | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly firstAt: string | null
  readonly lastAt: string | null
  readonly wallMs: number | null
}

export interface CanaryObservations {
  readonly experimentId: string
  readonly protocolDigest: string
  readonly contractDigest: string
  readonly observedAt: string
  readonly sessionsRead: number
  readonly rows: readonly ObservedAssignment[]
}

function lineOf(text: string): Set<string> {
  const found = new Set<string>()
  const pattern = new RegExp(`^[ \\t>*-]*${ASSIGNMENT_LINE_PREFIX}[ \\t]*(ba-[0-9a-f]{16})[ \\t]*$`, 'gmu')
  for (const match of text.matchAll(pattern)) found.add(match[1] as string)
  return found
}

function sum(values: readonly (number | null)[]): number | null {
  return values.some((value) => value === null)
    ? null
    : values.reduce<number>((total, value) => total + (value as number), 0)
}

function observeSession(session: SkillSessionRecord): ObservedSession {
  const times = session.events
    .map((event) => event.at)
    .filter((at): at is string => at !== null)
    .sort()
  const check = session.contractChecks?.[0]
  const usages = session.events.flatMap((event) => (event.kind === 'model' ? [event.usage] : []))
  return {
    harness: session.harness,
    sessionId: session.sessionId,
    firstAt: times[0] ?? null,
    lastAt: times.at(-1) ?? null,
    mistakes: check === undefined || check.status === 'error' ? null : { ...check.violations },
    modelCalls: usages.length,
    inputTokens: sum(usages.map((usage) => usage?.inputTokens ?? null)),
    outputTokens: sum(usages.map((usage) => usage?.outputTokens ?? null)),
  }
}

export async function observeCanary(
  config: CanaryConfig,
  options: { readonly contract: TraceContractSpec; readonly paths: HarnessSessionPaths },
): Promise<CanaryObservations> {
  syncLedger(config.ledger)
  const entries = readLedger(config.ledger)
  const sealed = entries[0]
  if (sealed === undefined || sealed.kind !== 'protocol')
    throw new AppError('CANARY_NOT_SEALED', 'The ledger holds no sealed protocol')
  const contractDigest = canaryDigest(canonicalJson(options.contract))
  const secondary = sealed.protocol.secondary as { contractDigest?: unknown } | undefined
  if (secondary?.contractDigest !== contractDigest)
    throw new AppError(
      'CANARY_CONTRACT_NOT_SEALED',
      `The protocol sealed procedure contract ${String(secondary?.contractDigest ?? 'none')}; this one is ${contractDigest}`,
    )
  const { compileTraceContractSpec } = await import('@tangle-network/agent-eval')
  const read = await readHarnessSessions(options.paths, Date.parse(sealed.at), {
    contracts: [compileTraceContractSpec(options.contract)],
  })
  const byAssignment = new Map<string, SkillSessionRecord[]>()
  for (const session of read.sessions)
    for (const id of lineOf((session.turns ?? []).map((turn) => turn.text).join('\n')))
      byAssignment.set(id, [...(byAssignment.get(id) ?? []), session])
  const rows = entries
    .filter((entry): entry is AssignmentEntry => entry.kind === 'assignment')
    .map((entry): ObservedAssignment => {
      const sessions = (byAssignment.get(entry.assignmentId) ?? []).map(observeSession)
      const found = sessions.length > 0
      const byRule: Record<string, number> = {}
      const checked = found && sessions.every((session) => session.mistakes !== null)
      if (checked)
        for (const session of sessions)
          for (const [rule, count] of Object.entries(session.mistakes ?? {}))
            byRule[rule] = (byRule[rule] ?? 0) + count
      const firsts = sessions.map((session) => session.firstAt).filter((at) => at !== null).sort()
      const lasts = sessions.map((session) => session.lastAt).filter((at) => at !== null).sort()
      const firstAt = firsts[0] ?? null
      const lastAt = lasts.at(-1) ?? null
      return {
        assignmentId: entry.assignmentId,
        taskId: entry.taskId,
        skill: entry.skill,
        repository: entry.repository,
        arm: entry.arm,
        assignedAt: entry.at,
        sessions,
        procedureMistakes: checked ? Object.values(byRule).reduce((a, b) => a + b, 0) : null,
        mistakesByRule: checked ? byRule : null,
        inputTokens: found ? sum(sessions.map((session) => session.inputTokens)) : null,
        outputTokens: found ? sum(sessions.map((session) => session.outputTokens)) : null,
        firstAt,
        lastAt,
        wallMs: firstAt !== null && lastAt !== null ? Date.parse(lastAt) - Date.parse(firstAt) : null,
      }
    })
  return {
    experimentId: sealed.experimentId,
    protocolDigest: sealed.protocolDigest,
    contractDigest,
    observedAt: new Date().toISOString(),
    sessionsRead: read.sessions.length,
    rows,
  }
}
