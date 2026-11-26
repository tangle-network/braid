import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { dirname, relative } from 'node:path'
import { promisify } from 'node:util'
import type { FeedbackTrajectory } from '@tangle-network/agent-eval'
import type { SkillUsageRow } from '@tangle-network/agent-eval/analyst'
import { type AgentProfile, mountSkill } from '@tangle-network/agent-interface'
import { draftProfileFromFeedback } from '../profile-learning.js'
import { DEFAULT_LEARNER_SETTINGS } from './learner-profile.js'
import {
  inlineSkills,
  loadedTokens,
  type MountedSkill,
  profileDigest,
  sha256Hex,
  withoutSkill,
  withSkills,
} from './learning-profile.js'
import { type HarnessSessions, orderedSkillPairs } from './learning-sources.js'
import type {
  LearnerSettings,
  LearningCandidate,
  LearningCandidateKind,
} from './learning-types.js'

const run = promisify(execFile)

/** A skill file pinned to the commit it came from, ready for `mountSkill`. */
export interface PinnedSkill {
  readonly name: string
  readonly repository: string
  readonly commit: string
  readonly path: string
  readonly content: string
  /** agent-eval's body digest: the version the procedure registry keys a skill by. */
  readonly bodySha256: string
}

export type PinResult =
  | { readonly pinned: true; readonly skill: PinnedSkill }
  | { readonly pinned: false; readonly reason: string }

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], {
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  return stdout
}

/** `owner/repo` from a GitHub remote URL, or undefined for any other remote. */
export function githubRepository(remote: string): string | undefined {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(
      remote.trim(),
    )
  return match === null ? undefined : `${match[1]}/${match[2]}`
}

/**
 * Pin a skill file to the commit it came from. The file must be committed and
 * unchanged, so the mounted bytes are exactly the bytes at that commit.
 */
export async function pinSkillFile(name: string, skillFile: string): Promise<PinResult> {
  let file: string
  try {
    file = await realpath(skillFile)
  } catch {
    return { pinned: false, reason: 'the skill file no longer exists' }
  }
  try {
    const root = (await git(dirname(file), ['rev-parse', '--show-toplevel'])).trim()
    const path = relative(await realpath(root), file)
    const commit = (await git(root, ['rev-parse', 'HEAD'])).trim()
    const repository = githubRepository(await git(root, ['remote', 'get-url', 'origin']))
    if (repository === undefined)
      return { pinned: false, reason: 'its checkout has no GitHub origin to pin to' }
    if ((await git(root, ['status', '--porcelain', '--', path])).trim() !== '')
      return { pinned: false, reason: 'the skill file has uncommitted changes' }
    const content = await git(root, ['show', `${commit}:${path}`])
    const { readSkillFile } = await import('@tangle-network/agent-eval/analyst')
    const read = readSkillFile(file)
    if (!read.succeeded)
      return { pinned: false, reason: `the skill file is unreadable: ${read.error}` }
    return {
      pinned: true,
      skill: { name, repository, commit, path, content, bodySha256: read.bodySha256 },
    }
  } catch {
    return { pinned: false, reason: 'the skill file is not in a git checkout' }
  }
}

function mounted(skill: PinnedSkill): MountedSkill {
  const { skill: resource, provenance } = mountSkill(
    { repository: skill.repository, ref: skill.commit, path: skill.path, name: skill.name },
    skill.content,
  )
  return { skill: resource, provenance: { ...provenance } }
}

async function candidate(
  kind: LearningCandidateKind,
  input: {
    readonly name: string
    readonly summary: string
    readonly evidence: readonly string[]
    readonly unitText: string
    readonly unitDigest: string
    readonly profile: AgentProfile
  },
): Promise<LearningCandidate> {
  const digest = profileDigest(input.profile)
  return {
    id: `${kind}-${digest.slice('sha256:'.length, 'sha256:'.length + 10)}`,
    kind,
    ...input,
    profileDigest: digest,
    loadedTokens: await loadedTokens(input.profile),
  }
}

function workflowSkill(first: string, second: string, sessions: number): string {
  const name = `${first}-then-${second}`
  return [
    '---',
    `name: ${name}`,
    `description: Run the ${first} skill, then the ${second} skill on its result.`,
    '---',
    '',
    `# ${first}, then ${second}`,
    '',
    `Learned from ${sessions} recorded sessions that ran \`${first}\` before \`${second}\`.`,
    '',
    `1. Run the \`${first}\` skill for the task.`,
    `2. When it finishes, run the \`${second}\` skill on what it produced.`,
    '3. Report the result of both steps together.',
    '',
  ].join('\n')
}

export interface ProposeCandidatesInput {
  readonly base: AgentProfile
  readonly harness: HarnessSessions
  readonly feedback: readonly FeedbackTrajectory[]
  /** Pins a skill file; the default reads git. */
  readonly pin?: (name: string, skillFile: string) => Promise<PinResult>
  /** What the active learner proposes. */
  readonly settings?: LearnerSettings['candidates']
}

/**
 * Propose profile changes from recorded sessions and feedback. Every candidate
 * is the base profile plus or minus one unit:
 *
 * | Kind | Unit | From |
 * |---|---|---|
 * | `skill` | one skill the sessions invoked most, pinned by commit | another harness's sessions |
 * | `workflow` | a composed skill that runs two skills in the order sessions ran them | another harness's sessions |
 * | `instructions` | lessons from task feedback reasons | Braid feedback |
 * | `removal` | one skill the profile carries | the profile itself |
 */
export async function proposeCandidates(
  input: ProposeCandidatesInput,
): Promise<{ readonly candidates: LearningCandidate[]; readonly skipped: string[] }> {
  const pin = input.pin ?? pinSkillFile
  const settings = input.settings ?? DEFAULT_LEARNER_SETTINGS.candidates
  const proposes = (kind: LearningCandidateKind) => settings.kinds.includes(kind)
  const candidates: LearningCandidate[] = []
  const skipped: string[] = []
  for (const kind of ['skill', 'workflow', 'instructions', 'removal'] as const)
    if (!proposes(kind)) skipped.push(`${kind}: the learner does not propose this kind`)
  const present = new Set(inlineSkills(input.base).map((skill) => skill.name))
  const rows = (input.harness.usage?.rows ?? [])
    .filter((row) => !present.has(row.skill))
    .sort((left, right) => right.invocations.total - left.invocations.total)
    .slice(0, proposes('skill') || proposes('workflow') ? settings.rowsTried : 0)
  const pinned = new Map<string, PinnedSkill>()
  const rowOf = new Map<string, SkillUsageRow>()
  for (const row of rows) {
    rowOf.set(row.skill, row)
    if (row.skillFile === null) {
      skipped.push(`skill ${row.skill}: the sessions name no skill file`)
      continue
    }
    const result = await pin(row.skill, row.skillFile.path)
    if (result.pinned) pinned.set(row.skill, result.skill)
    else skipped.push(`skill ${row.skill}: ${result.reason}`)
  }

  for (const skill of [...pinned.values()].slice(0, proposes('skill') ? settings.maxSkills : 0)) {
    const row = rowOf.get(skill.name) as SkillUsageRow
    candidates.push(
      await candidate('skill', {
        name: skill.name,
        summary: `Mount ${skill.name} from ${skill.repository}@${skill.commit.slice(0, 12)}`,
        evidence: [
          `${row.invocations.total} invocations in ${row.sessions} Claude Code sessions`,
          `pinned to ${skill.repository}@${skill.commit.slice(0, 12)}:${skill.path}`,
        ],
        unitText: skill.content,
        unitDigest: `sha256:${skill.bodySha256}`,
        profile: withSkills(input.base, [mounted(skill)]),
      }),
    )
  }

  const pair = orderedSkillPairs(input.harness.sessions).find(
    (entry) =>
      entry.sessions >= settings.workflowMinSessions &&
      (present.has(entry.first) || pinned.has(entry.first)) &&
      (present.has(entry.second) || pinned.has(entry.second)),
  )
  if (!proposes('workflow')) {
    // The learner skips this kind; the reason is already recorded.
  } else if (pair === undefined) {
    skipped.push(
      `workflow: no two pinnable skills ran in the same order in ${settings.workflowMinSessions} or more sessions`,
    )
  } else {
    const text = workflowSkill(pair.first, pair.second, pair.sessions)
    const components = [pair.first, pair.second].flatMap((name) => {
      const skill = pinned.get(name)
      return skill === undefined ? [] : [mounted(skill)]
    })
    candidates.push(
      await candidate('workflow', {
        name: `${pair.first}-then-${pair.second}`,
        summary: `Compose ${pair.first} then ${pair.second} into one workflow skill`,
        evidence: [`${pair.sessions} Claude Code sessions ran ${pair.first} before ${pair.second}`],
        unitText: text,
        unitDigest: `sha256:${sha256Hex(text)}`,
        profile: withSkills(input.base, [
          ...components,
          { skill: { kind: 'inline', name: `${pair.first}-then-${pair.second}`, content: text } },
        ]),
      }),
    )
  }

  const reasoned = input.feedback.some((item) =>
    item.labels.some((label) => (label.reason ?? '') !== ''),
  )
  if (proposes('instructions') && reasoned) {
    const draft = await draftProfileFromFeedback(input.base, input.feedback)
    const text = draft.lessons.map((lesson) => lesson.instruction).join('\n')
    candidates.push(
      await candidate('instructions', {
        name: 'feedback-lessons',
        summary: `Add ${draft.lessons.length} lessons from task feedback`,
        evidence: [`${draft.feedbackIds.length} feedback decisions with a reason`],
        unitText: text,
        unitDigest: `sha256:${sha256Hex(text)}`,
        profile: draft.profile as AgentProfile,
      }),
    )
  } else if (proposes('instructions')) {
    skipped.push('instructions: no task feedback with a reason')
  }

  for (const skill of inlineSkills(input.base).slice(
    0,
    proposes('removal') ? settings.maxRemovals : 0,
  )) {
    candidates.push(
      await candidate('removal', {
        name: skill.name,
        summary: `Remove ${skill.name}`,
        evidence: ['the profile carries it; removal is kept only if success holds'],
        unitText: skill.content,
        unitDigest: `sha256:${sha256Hex(skill.content)}`,
        profile: withoutSkill(input.base, skill.name),
      }),
    )
  }
  return { candidates, skipped }
}
