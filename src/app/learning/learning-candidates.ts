import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { dirname, posix, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import type { FeedbackTrajectory } from '@tangle-network/agent-eval'
import type { SkillUsageRow } from '@tangle-network/agent-eval/analyst'
import {
  type AgentProfile,
  type AgentProfileSkillFile,
  mountSkill,
  mountSkillDirectory,
} from '@tangle-network/agent-interface'
import {
  isMaterializerHarness,
  skillDirForHarness,
} from '@tangle-network/agent-profile-materialize'
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
import {
  countChanges,
  type HarnessSessions,
  harnessName,
  orderedSkillPairs,
  sessionIndex,
  sessionsInvoking,
} from './learning-sources.js'
import type {
  ChangeOutcomeCounts,
  LearnerSettings,
  LearningCandidate,
  LearningCandidateKind,
} from './learning-types.js'

const run = promisify(execFile)

/** A skill pinned to the commit it came from: `SKILL.md` and the text files beside it. */
export interface PinnedSkill {
  readonly name: string
  readonly repository: string
  readonly commit: string
  readonly path: string
  readonly content: string
  /** Every other committed text file in the skill's directory, by path inside it. */
  readonly siblings: readonly AgentProfileSkillFile[]
  /** Files in the skill's directory that are not mounted, with the reason. */
  readonly omitted: readonly string[]
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

async function gitBytes(cwd: string, args: readonly string[]): Promise<Buffer> {
  const { stdout } = await run('git', ['-C', cwd, ...args], {
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'buffer',
  })
  return stdout
}

const MAX_SIBLINGS = 64
const MAX_SIBLING_BYTES = 1024 * 1024

/**
 * The committed files beside a skill's `SKILL.md` at one commit. Only text
 * files mount inline, so a binary file, a link or a submodule is omitted with
 * its reason, as is everything past the size limits.
 */
async function skillSiblings(
  root: string,
  commit: string,
  skillPath: string,
): Promise<{ readonly files: AgentProfileSkillFile[]; readonly omitted: string[] }> {
  const directory = posix.dirname(skillPath)
  if (directory === '.')
    return { files: [], omitted: ['the skill is the repository root, so no sibling is mounted'] }
  const listing = (await gitBytes(root, ['ls-tree', '-r', '-z', commit, '--', `${directory}/`]))
    .toString('utf8')
    .split('\0')
    .filter((entry) => entry !== '')
  const files: AgentProfileSkillFile[] = []
  const omitted: string[] = []
  let bytes = 0
  for (const entry of listing) {
    const tab = entry.indexOf('\t')
    const [mode, type] = entry.slice(0, tab).split(' ')
    const path = entry.slice(tab + 1)
    const inside = path.slice(directory.length + 1)
    if (inside === 'SKILL.md') continue
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) {
      omitted.push(`${inside}: a ${mode === '120000' ? 'symbolic link' : type} has no inline form`)
      continue
    }
    if (files.length >= MAX_SIBLINGS) {
      omitted.push(`${inside}: past the ${MAX_SIBLINGS}-file limit`)
      continue
    }
    const content = await gitBytes(root, ['show', `${commit}:${path}`])
    const text = content.toString('utf8')
    if (content.includes(0) || !Buffer.from(text, 'utf8').equals(content)) {
      omitted.push(`${inside}: binary, so it has no inline form`)
      continue
    }
    if (bytes + content.length > MAX_SIBLING_BYTES) {
      omitted.push(`${inside}: past the ${MAX_SIBLING_BYTES}-byte limit`)
      continue
    }
    bytes += content.length
    files.push({ path: inside, content: text, ...(mode === '100755' ? { executable: true } : {}) })
  }
  return { files, omitted }
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
 * Pin a skill to the commit it came from. Its directory's tracked files must
 * be committed and unchanged, so the mounted bytes are exactly the bytes at
 * that commit; files beside `SKILL.md` mount with it.
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
      .split(sep)
      .join('/')
    const commit = (await git(root, ['rev-parse', 'HEAD'])).trim()
    const repository = githubRepository(await git(root, ['remote', 'get-url', 'origin']))
    if (repository === undefined)
      return { pinned: false, reason: 'its checkout has no GitHub origin to pin to' }
    if ((await git(root, ['status', '--porcelain', '--', path])).trim() !== '')
      return { pinned: false, reason: 'the skill file has uncommitted changes' }
    const directory = posix.dirname(path)
    if (
      directory !== '.' &&
      (
        await git(root, ['status', '--porcelain', '--untracked-files=no', '--', `${directory}/`])
      ).trim() !== ''
    )
      return { pinned: false, reason: 'a file beside the skill has uncommitted changes' }
    const content = await git(root, ['show', `${commit}:${path}`])
    const { files: siblings, omitted } = await skillSiblings(root, commit, path)
    const { readSkillFile } = await import('@tangle-network/agent-eval/analyst')
    const read = readSkillFile(file)
    if (!read.succeeded)
      return { pinned: false, reason: `the skill file is unreadable: ${read.error}` }
    return {
      pinned: true,
      skill: {
        name,
        repository,
        commit,
        path,
        content,
        siblings,
        omitted,
        bodySha256: read.bodySha256,
      },
    }
  } catch {
    return { pinned: false, reason: 'the skill file is not in a git checkout' }
  }
}

/**
 * Where siblings mount: the profile's harness's skill directory. A runner that
 * reads skills elsewhere gets them beside its own copy of the skill from the
 * materializer, which keeps a skill's files with it.
 */
export function skillsDirectoryFor(profile: AgentProfile): string {
  const harness = profile.harness
  return (
    (harness !== undefined && isMaterializerHarness(harness)
      ? skillDirForHarness(harness)
      : null) ?? '.claude/skills'
  )
}

function mounted(skill: PinnedSkill, skillsDirectory: string): MountedSkill {
  if (skill.siblings.length === 0) {
    const { skill: resource, provenance } = mountSkill(
      { repository: skill.repository, ref: skill.commit, path: skill.path, name: skill.name },
      skill.content,
    )
    return { skill: resource, provenance: [{ ...provenance }] }
  }
  const directory = posix.dirname(skill.path)
  const mount = mountSkillDirectory(
    {
      repository: skill.repository,
      ref: skill.commit,
      directory: directory === '.' ? '' : directory,
      name: skill.name,
    },
    [{ path: 'SKILL.md', content: skill.content }, ...skill.siblings],
    { skillsDirectory },
  )
  return {
    skill: mount.skill,
    files: mount.files,
    provenance: mount.provenance.map((record) => ({ ...record })),
  }
}

/** The evidence line for a skill's directory: what mounted beside `SKILL.md`, and what did not. */
function siblingEvidence(skill: PinnedSkill): string[] {
  return [
    ...(skill.siblings.length === 0
      ? []
      : [
          `mounted with ${skill.siblings.length} files beside SKILL.md, each pinned to the same commit`,
        ]),
    ...skill.omitted.map((reason) => `not mounted: ${reason}`),
  ]
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
    readonly changes: ChangeOutcomeCounts | null
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

/** The evidence line for what a candidate's sessions came to; unknown is its own count, never folded into none. */
function changeEvidence(counts: ChangeOutcomeCounts, sessions: string): string {
  const total = counts.changed + counts.none + counts.unknown
  return `Changes of the ${total} sessions that ${sessions}: ${counts.changed} made a change, ${counts.none} made none, ${counts.unknown} unknown`
}

/** Invocations of one skill version per harness: `3 in 3 Claude Code sessions, 2 in 2 Codex sessions`. */
function invocationsByHarness(harness: HarnessSessions, row: SkillUsageRow): string {
  return harness.harnesses
    .flatMap((read) => {
      const own = read.usage.rows.find(
        (item) => item.skill === row.skill && item.version?.bodySha256 === row.version?.bodySha256,
      )
      return own === undefined
        ? []
        : [`${own.invocations.total} in ${own.sessions} ${harnessName(read.harness)} sessions`]
    })
    .join(', ')
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
 * | `skill` | one skill the sessions invoked most, pinned by commit | Claude Code and Codex sessions |
 * | `workflow` | a composed skill that runs two skills in the order sessions ran them | Claude Code and Codex sessions |
 * | `instructions` | lessons from task feedback reasons | Braid feedback |
 * | `removal` | one skill the profile carries | the profile itself |
 *
 * A skill or workflow candidate also records what its sessions came to (see
 * `changeState`). That is evidence for the reader; the measurement decides.
 */
export async function proposeCandidates(
  input: ProposeCandidatesInput,
): Promise<{ readonly candidates: LearningCandidate[]; readonly skipped: string[] }> {
  const pin = input.pin ?? pinSkillFile
  const settings = input.settings ?? DEFAULT_LEARNER_SETTINGS.candidates
  const skillsDirectory = skillsDirectoryFor(input.base)
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
  const index = sessionIndex(input.harness.sessions)
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
    const changes = countChanges(
      sessionsInvoking(input.harness.sessions, skill.name, input.harness.sinceMs),
      index,
    )
    candidates.push(
      await candidate('skill', {
        name: skill.name,
        summary: `Mount ${skill.name} from ${skill.repository}@${skill.commit.slice(0, 12)}`,
        evidence: [
          `${row.invocations.total} invocations in ${row.sessions} sessions: ${invocationsByHarness(input.harness, row)}`,
          changeEvidence(changes, `invoked ${skill.name}`),
          `pinned to ${skill.repository}@${skill.commit.slice(0, 12)}:${skill.path}`,
          ...siblingEvidence(skill),
        ],
        unitText: skill.content,
        unitDigest: `sha256:${skill.bodySha256}`,
        profile: withSkills(input.base, [mounted(skill, skillsDirectory)]),
        changes,
      }),
    )
  }

  const pair = orderedSkillPairs(input.harness.sessions).find(
    (entry) =>
      entry.sessions >= settings.workflowMinSessions &&
      (present.has(entry.first) || pinned.has(entry.first)) &&
      (present.has(entry.second) || pinned.has(entry.second)),
  )
  if (proposes('workflow') && pair === undefined) {
    skipped.push(
      `workflow: no two pinnable skills ran in the same order in ${settings.workflowMinSessions} or more sessions`,
    )
  } else if (proposes('workflow') && pair !== undefined) {
    const text = workflowSkill(pair.first, pair.second, pair.sessions)
    const changes = countChanges(pair.records, index)
    const byHarness = [...new Set(pair.records.map((session) => session.harness))]
      .map(
        (name) =>
          `${pair.records.filter((session) => session.harness === name).length} ${harnessName(name)}`,
      )
      .join(', ')
    const components = [pair.first, pair.second].flatMap((name) => {
      const skill = pinned.get(name)
      return skill === undefined ? [] : [mounted(skill, skillsDirectory)]
    })
    candidates.push(
      await candidate('workflow', {
        name: `${pair.first}-then-${pair.second}`,
        summary: `Compose ${pair.first} then ${pair.second} into one workflow skill`,
        evidence: [
          `${pair.sessions} sessions ran ${pair.first} before ${pair.second}: ${byHarness}`,
          changeEvidence(changes, `ran ${pair.first} before ${pair.second}`),
        ],
        unitText: text,
        unitDigest: `sha256:${sha256Hex(text)}`,
        profile: withSkills(input.base, [
          ...components,
          { skill: { kind: 'inline', name: `${pair.first}-then-${pair.second}`, content: text } },
        ]),
        changes,
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
        changes: null,
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
        changes: null,
      }),
    )
  }
  return { candidates, skipped }
}
