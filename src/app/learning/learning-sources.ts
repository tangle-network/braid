import { stat } from 'node:fs/promises'
import type { FeedbackTrajectory } from '@tangle-network/agent-eval'
import type { SkillSessionRecord, SkillUsageReport } from '@tangle-network/agent-eval/analyst'
import type { BraidState } from '../../domain/state.js'
import type { LearningHarnessSource } from './learning-types.js'

/** What the learning loop read from other harnesses. Parsing stays in agent-eval. */
export interface HarnessSessions {
  readonly sources: readonly LearningHarnessSource[]
  readonly sessions: readonly SkillSessionRecord[]
  readonly usage: SkillUsageReport | null
}

/** Read Claude Code transcripts newer than `sinceMs`. A missing directory reads as no sessions. */
export async function readClaudeCodeSessions(
  directory: string | undefined,
  sinceMs: number,
): Promise<HarnessSessions> {
  if (directory === undefined || !(await isDirectory(directory)))
    return { sources: [], sessions: [], usage: null }
  const { buildSkillUsageReport, claudeCodeSkillSessions, readSkillFile } = await import(
    '@tangle-network/agent-eval/analyst'
  )
  const sessions: SkillSessionRecord[] = []
  let unreadable = 0
  for await (const read of claudeCodeSkillSessions(directory, { sinceMs })) {
    if (read.succeeded) sessions.push(read.value)
    else unreadable += 1
  }
  const usage = await buildSkillUsageReport(
    sessions.map((value) => ({ succeeded: true as const, source: value.sessionId, value })),
    { sinceMs, readSkillFile },
  )
  return {
    sources: [
      {
        harness: 'claude-code',
        sessions: sessions.length,
        skillInvocations: usage.invocations.total,
        unreadable,
      },
    ],
    sessions,
    usage,
  }
}

/** Ordered skill pairs, A then B, counted once per session that ran both in that order. */
export function orderedSkillPairs(
  sessions: readonly SkillSessionRecord[],
): Array<{ readonly first: string; readonly second: string; readonly sessions: number }> {
  const counts = new Map<string, { first: string; second: string; sessions: number }>()
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
      const entry = counts.get(key) ?? { first, second, sessions: 0 }
      entry.sessions += 1
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
