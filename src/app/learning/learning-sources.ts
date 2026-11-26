import { stat } from 'node:fs/promises'
import type { FeedbackTrajectory } from '@tangle-network/agent-eval'
import type {
  ChangeLedger,
  SkillSessionRead,
  SkillSessionRecord,
  SkillSessionSource,
  SkillUsageReport,
} from '@tangle-network/agent-eval/analyst'
import type { BraidState } from '../../domain/state.js'
import { AppError } from '../errors.js'
import type {
  ChangeOutcomeCounts,
  LearningChangeLedgerSource,
  LearningHarnessSource,
} from './learning-types.js'

/** The harnesses Braid reads sessions from; Eval owns the reader for each. */
export type SessionHarness = 'claude-code' | 'codex'

const HARNESS_NAMES: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

/** A harness as a person reads it: `Claude Code`, `Codex`. */
export function harnessName(harness: string): string {
  return HARNESS_NAMES[harness] ?? harness
}

/** One harness's sessions in the window, with the change ledger joined. */
export interface HarnessRead {
  readonly harness: SessionHarness
  readonly sessions: readonly SkillSessionRecord[]
  /** Files or folders the reader could not read. */
  readonly unreadable: number
  readonly usage: SkillUsageReport
}

/** What the learning loop read from other harnesses. Parsing and the ledger join stay in agent-eval. */
export interface HarnessSessions {
  /** Invocations before this instant (epoch ms) are outside the window. */
  readonly sinceMs: number
  readonly sources: readonly LearningHarnessSource[]
  /** Every harness's sessions. */
  readonly sessions: readonly SkillSessionRecord[]
  /** One report over every harness's sessions; null when no harness was read. */
  readonly usage: SkillUsageReport | null
  readonly harnesses: readonly HarnessRead[]
  readonly changeLedger: LearningChangeLedgerSource | null
}

export interface HarnessSessionPaths {
  readonly claudeCodeProjects?: string | undefined
  readonly codexSessions?: string | undefined
  readonly changeLedger?: string | undefined
}

const sessionKey = (harness: string, sessionId: string) => `${harness}\u0000${sessionId}`

function reads(sessions: readonly SkillSessionRecord[]): SkillSessionRead[] {
  return sessions.map((value) => ({ succeeded: true as const, source: value.sessionId, value }))
}

/**
 * Read Claude Code transcripts and Codex rollouts newer than `sinceMs`, each
 * joined to the change ledger. A missing directory or ledger file reads as no
 * source; one that exists and cannot be read is an error.
 */
export async function readHarnessSessions(
  paths: HarnessSessionPaths,
  sinceMs: number,
): Promise<HarnessSessions> {
  const directories: Array<readonly [SessionHarness, string]> = []
  for (const [harness, directory] of [
    ['claude-code', paths.claudeCodeProjects],
    ['codex', paths.codexSessions],
  ] as const) {
    if (directory !== undefined && (await isDirectory(directory)))
      directories.push([harness, directory])
  }
  const ledgerFile =
    paths.changeLedger !== undefined && (await isFile(paths.changeLedger))
      ? paths.changeLedger
      : undefined
  if (directories.length === 0 && ledgerFile === undefined)
    return { sinceMs, sources: [], sessions: [], usage: null, harnesses: [], changeLedger: null }

  const analyst = await import('@tangle-network/agent-eval/analyst')
  let ledger: ChangeLedger
  try {
    // No ledger file joins as an empty ledger: a transcript's own pull requests
    // still count, and a session that shows none stays unknown, never none.
    ledger =
      ledgerFile === undefined
        ? analyst.parseChangeLedger('')
        : await analyst.readChangeLedger([ledgerFile])
  } catch (error) {
    throw new AppError(
      'LEARNING_SOURCE_UNREADABLE',
      error instanceof Error ? error.message : String(error),
    )
  }
  const options = { sinceMs, readSkillFile: analyst.readSkillFile }
  const harnesses: HarnessRead[] = []
  for (const [harness, directory] of directories) {
    const source: SkillSessionSource =
      harness === 'claude-code'
        ? analyst.claudeCodeSkillSessions(directory, { sinceMs })
        : analyst.codexSkillSessions(directory, { sinceMs })
    const sessions: SkillSessionRecord[] = []
    let unreadable = 0
    for await (const read of analyst.withChangeLedger(source, ledger)) {
      if (read.succeeded) sessions.push(read.value)
      else unreadable += 1
    }
    harnesses.push({
      harness,
      sessions,
      unreadable,
      usage: await analyst.buildSkillUsageReport(reads(sessions), options),
    })
  }
  const sessions = harnesses.flatMap((read) => read.sessions)
  const index = sessionIndex(sessions)
  return {
    sinceMs,
    sources: harnesses.map((read) => ({
      harness: read.harness,
      sessions: read.sessions.length,
      skillInvocations: read.usage.invocations.total,
      unreadable: read.unreadable,
      changes: countChanges(read.sessions, index),
    })),
    sessions,
    usage:
      harnesses.length === 0 ? null : await analyst.buildSkillUsageReport(reads(sessions), options),
    harnesses,
    changeLedger:
      ledgerFile === undefined
        ? null
        : {
            rows: ledger.rows,
            malformed: ledger.malformed,
            joinedSessions: sessions.filter((session) =>
              ledger.sessions.has(sessionKey(session.harness, session.sessionId)),
            ).length,
          },
  }
}

/** Sessions by harness and id, so a subagent finds the session that spawned it. */
export type SessionIndex = ReadonlyMap<string, SkillSessionRecord>

export function sessionIndex(sessions: readonly SkillSessionRecord[]): SessionIndex {
  return new Map(
    sessions.map((session) => [sessionKey(session.harness, session.sessionId), session]),
  )
}

/**
 * What a session came to, as Eval's procedure registry joins an invocation to
 * changes: the changes of the session and of every session that spawned it,
 * since a subagent's work ships in its parent's change. `changes` is undefined
 * when the reader could not tell, so a chain where no session could tell is
 * unknown, never none.
 */
export function changeState(
  session: SkillSessionRecord,
  index: SessionIndex,
): 'changed' | 'none' | 'unknown' {
  let recorded = false
  const visited = new Set<string>()
  for (
    let current: SkillSessionRecord | undefined = session;
    current !== undefined && !visited.has(sessionKey(current.harness, current.sessionId));
    current =
      current.parentSessionId === null
        ? undefined
        : index.get(sessionKey(current.harness, current.parentSessionId))
  ) {
    visited.add(sessionKey(current.harness, current.sessionId))
    if (current.changes === undefined) continue
    if (current.changes.length > 0) return 'changed'
    recorded = true
  }
  return recorded ? 'none' : 'unknown'
}

export function countChanges(
  sessions: Iterable<SkillSessionRecord>,
  index: SessionIndex,
): ChangeOutcomeCounts {
  const counts = { changed: 0, none: 0, unknown: 0 }
  for (const session of sessions) counts[changeState(session, index)] += 1
  return counts
}

/** Sessions that ran `skill` inside the window: an invocation the harness did not refuse, dated at or after `sinceMs`. */
export function sessionsInvoking(
  sessions: readonly SkillSessionRecord[],
  skill: string,
  sinceMs: number,
): SkillSessionRecord[] {
  return sessions.filter((session) =>
    session.events.some(
      (event) =>
        event.kind === 'skill' &&
        event.skill === skill &&
        event.failed !== true &&
        event.at !== null &&
        Date.parse(event.at) >= sinceMs,
    ),
  )
}

/** A subagent type the sessions started inside the window, with the calls that started it. */
export interface SubagentStarts {
  readonly type: string
  readonly calls: number
  readonly records: readonly SkillSessionRecord[]
}

/**
 * Subagent types started inside the window, most sessions first. A start is a
 * tool call Eval's reader names a subagent type on, which the harness did not
 * refuse, dated at or after `sinceMs`.
 */
export function subagentStarts(
  sessions: readonly SkillSessionRecord[],
  sinceMs: number,
): SubagentStarts[] {
  const starts = new Map<string, { type: string; calls: number; records: SkillSessionRecord[] }>()
  for (const session of sessions) {
    for (const event of session.events) {
      if (event.kind !== 'tool' || event.subagent === undefined || event.failed === true) continue
      if (event.at === null || Date.parse(event.at) < sinceMs) continue
      const entry = starts.get(event.subagent) ?? { type: event.subagent, calls: 0, records: [] }
      entry.calls += 1
      if (entry.records.at(-1) !== session) entry.records.push(session)
      starts.set(event.subagent, entry)
    }
  }
  return [...starts.values()].sort(
    (left, right) =>
      right.records.length - left.records.length ||
      right.calls - left.calls ||
      left.type.localeCompare(right.type),
  )
}

/** Ordered skill pairs, A then B, counted once per session that ran both in that order. */
export function orderedSkillPairs(sessions: readonly SkillSessionRecord[]): Array<{
  readonly first: string
  readonly second: string
  readonly sessions: number
  readonly records: readonly SkillSessionRecord[]
}> {
  const counts = new Map<
    string,
    { first: string; second: string; sessions: number; records: SkillSessionRecord[] }
  >()
  for (const session of sessions) {
    const order: string[] = []
    for (const event of session.events) {
      if (event.kind !== 'skill' || event.failed === true) continue
      if (order.at(-1) !== event.skill) order.push(event.skill)
    }
    const seen = new Set<string>()
    for (let index = 0; index + 1 < order.length; index++) {
      const first = order[index] as string
      const second = order[index + 1] as string
      if (first === second) continue
      const key = `${first}\u0000${second}`
      if (seen.has(key)) continue
      seen.add(key)
      const entry = counts.get(key) ?? { first, second, sessions: 0, records: [] }
      entry.sessions += 1
      entry.records.push(session)
      counts.set(key, entry)
    }
  }
  return [...counts.values()].sort(
    (left, right) =>
      right.sessions - left.sessions ||
      left.first.localeCompare(right.first) ||
      left.second.localeCompare(right.second),
  )
}

/** Braid's own history in this workspace: runs and explicit task feedback. */
export function braidHistory(
  state: BraidState,
  feedback: readonly FeedbackTrajectory[],
  sinceMs: number,
): { readonly runs: number; readonly feedback: number; readonly reasons: number } {
  const recent = feedback.filter((item) => Date.parse(item.createdAt) >= sinceMs)
  return {
    runs: state.runs.filter((run) => Date.parse(run.startedAt) >= sinceMs).length,
    feedback: recent.length,
    reasons: recent.filter((item) => item.labels.some((label) => (label.reason ?? '') !== ''))
      .length,
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
