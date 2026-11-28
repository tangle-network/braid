import { execFile } from 'node:child_process'
import { readdir, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, posix, relative, sep } from 'node:path'
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
import {
  carriedInstructionBlocks,
  composable,
  instructionBlockId,
  loadedInstructionBlocks,
  onDisk,
  rankInstructionBlocks,
  withInstructionBlock,
  withoutInstructionBlock,
} from './instruction-blocks.js'
import { CANDIDATE_KINDS, DEFAULT_LEARNER_SETTINGS } from './learner-profile.js'
import {
  carriedSkillNames,
  inlineSkills,
  loadedTokens,
  type MountedSkill,
  profileDigest,
  sha256Hex,
  withoutSkill,
  withSkills,
  withSubagent,
} from './learning-profile.js'
import {
  countChanges,
  type HarnessSessions,
  harnessName,
  orderedSkillPairs,
  sessionIndex,
  sessionsInvoking,
  subagentStarts,
} from './learning-sources.js'
import type {
  BaseTaskResult,
  ChangeOutcomeCounts,
  LearnerSettings,
  LearningCandidate,
  LearningCandidateKind,
  LearningTask,
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
/** A file committed and unchanged in a GitHub checkout, read at that commit. */
type CommittedFile =
  | {
      readonly pinned: true
      readonly file: string
      readonly root: string
      readonly repository: string
      readonly commit: string
      readonly path: string
      readonly content: string
    }
  | { readonly pinned: false; readonly reason: string }

async function pinCommittedFile(source: string, what: string): Promise<CommittedFile> {
  let file: string
  try {
    file = await realpath(source)
  } catch {
    return { pinned: false, reason: `the ${what} no longer exists` }
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
      return { pinned: false, reason: `the ${what} has uncommitted changes` }
    const content = await git(root, ['show', `${commit}:${path}`])
    return { pinned: true, file, root, repository, commit, path, content }
  } catch {
    return { pinned: false, reason: `the ${what} is not in a git checkout` }
  }
}

export async function pinSkillFile(name: string, skillFile: string): Promise<PinResult> {
  const pinned = await pinCommittedFile(skillFile, 'skill file')
  if (!pinned.pinned) return pinned
  const { file, root, repository, commit, path, content } = pinned
  try {
    const directory = posix.dirname(path)
    if (
      directory !== '.' &&
      (
        await git(root, ['status', '--porcelain', '--untracked-files=no', '--', `${directory}/`])
      ).trim() !== ''
    )
      return { pinned: false, reason: 'a file beside the skill has uncommitted changes' }
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
    return { pinned: false, reason: 'the skill directory could not be read at its commit' }
  }
}

/** A subagent definition pinned to the commit it came from. */
export interface PinnedAgent {
  readonly name: string
  readonly repository: string
  readonly commit: string
  readonly path: string
  readonly content: string
}

export type AgentPinResult =
  | { readonly pinned: true; readonly agent: PinnedAgent }
  | { readonly pinned: false; readonly reason: string }

/** Pin a subagent definition file, committed and unchanged, to its commit. */
export async function pinAgentFile(name: string, agentFile: string): Promise<AgentPinResult> {
  const pinned = await pinCommittedFile(agentFile, 'definition file')
  if (!pinned.pinned) return pinned
  const { repository, commit, path, content } = pinned
  return { pinned: true, agent: { name, repository, commit, path, content } }
}

/**
 * Where siblings mount: the profile's harness's skill directory. A runner that
 * reads skills elsewhere gets them beside its own copy of the skill from the
 * materializer, which keeps a skill's files with it.
 */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/
/** The subagent names every runner's materializer accepts. */
const SUBAGENT_NAME = /^[a-z0-9][a-z0-9_-]*$/

/** A subagent definition as Claude Code writes one: flat frontmatter, then the prompt. */
export type AgentDefinition =
  | {
      readonly read: true
      readonly description: string
      readonly prompt: string
      /** Every frontmatter field, by key. */
      readonly fields: Readonly<Record<string, string>>
    }
  | { readonly read: false; readonly reason: string }

function scalar(raw: string): string | undefined {
  const value = raw.trim()
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value)
      return typeof parsed === 'string' ? parsed : undefined
    } catch {
      return undefined
    }
  }
  if (value.startsWith("'"))
    return value.length >= 2 && value.endsWith("'")
      ? value.slice(1, -1).replaceAll("''", "'")
      : undefined
  // A block scalar or a nested value is not flat.
  return value.startsWith('|') || value.startsWith('>') ? undefined : value
}

/**
 * Read a subagent definition. Only flat `key: value` frontmatter is read; a
 * definition with nested or block values is refused rather than half read.
 */
export function readAgentDefinition(content: string): AgentDefinition {
  const match = FRONTMATTER.exec(content)
  if (match === null) return { read: false, reason: 'it has no frontmatter block' }
  const fields: Record<string, string> = {}
  for (const line of (match[1] as string).split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const pair = /^([A-Za-z][\w-]*):(.*)$/.exec(line)
    const value = pair === null ? undefined : scalar(pair[2] as string)
    if (pair === null || value === undefined)
      return { read: false, reason: 'its frontmatter is not flat `key: value` lines' }
    fields[pair[1] as string] = value
  }
  const description = fields.description ?? ''
  const prompt = (match[2] as string).trim()
  if (description === '') return { read: false, reason: 'it has no description' }
  if (prompt === '') return { read: false, reason: 'it has no prompt' }
  return { read: true, description, prompt, fields }
}

/**
 * Definition files by the subagent name their frontmatter gives, from the
 * first directory that defines each name: the order Claude Code gives a
 * project's agents over the user's. A directory that cannot be read defines none.
 */
async function agentDefinitionFiles(directories: readonly string[]): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  for (const directory of directories) {
    let entries: string[]
    try {
      entries = (await readdir(directory)).filter((entry) => entry.endsWith('.md')).sort()
    } catch {
      continue
    }
    for (const entry of entries) {
      const file = join(directory, entry)
      let content: string
      try {
        content = await readFile(file, 'utf8')
      } catch {
        continue
      }
      const definition = readAgentDefinition(content)
      const name = definition.read ? definition.fields.name : undefined
      if (name !== undefined && !files.has(name)) files.set(name, file)
    }
  }
  return files
}

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
/** Sessions per harness: `2 Claude Code, 1 Codex`. */
function sessionsByHarness(records: readonly { readonly harness: string }[]): string {
  return [...new Set(records.map((session) => session.harness))]
    .map(
      (name) =>
        `${records.filter((session) => session.harness === name).length} ${harnessName(name)}`,
    )
    .join(', ')
}

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
  /** Where subagent definitions live, most specific first: the workspace's, then the user's. */
  readonly agentDirectories?: readonly string[]
  /** The held-out tasks instruction blocks are ranked against. */
  readonly tasks?: readonly LearningTask[]
  /**
   * The active profile's results on those tasks from its latest measurement,
   * or null when no measurement of this profile recorded them; blocks are then
   * ranked against every task.
   */
  readonly baseResults?: readonly BaseTaskResult[] | null
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
 * | `removal` | one skill or instruction block the profile carries | the profile itself |
 * | `subagent` | a child profile from the definition of a subagent type the sessions started, pinned by commit | Claude Code sessions |
 * | `instruction-block` | one rule block of an instruction file the sessions loaded, ranked against the tasks the profile fails | the instruction files Claude Code sessions loaded |
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
  for (const kind of CANDIDATE_KINDS)
    if (!proposes(kind)) skipped.push(`${kind}: the learner does not propose this kind`)
  // A skill the profile already carries, inline or by reference, is not proposed again.
  const present = carriedSkillNames(input.base)
  const usage = input.harness.usage?.rows ?? []
  for (const row of usage)
    if (present.has(row.skill)) skipped.push(`skill ${row.skill}: the profile carries it`)
  const rows = usage
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
    const components = [pair.first, pair.second].flatMap((name) => {
      const skill = pinned.get(name)
      return skill === undefined ? [] : [mounted(skill, skillsDirectory)]
    })
    candidates.push(
      await candidate('workflow', {
        name: `${pair.first}-then-${pair.second}`,
        summary: `Compose ${pair.first} then ${pair.second} into one workflow skill`,
        evidence: [
          `${pair.sessions} sessions ran ${pair.first} before ${pair.second}: ${sessionsByHarness(pair.records)}`,
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

  // Removals: each inline skill, then each learned instruction block, up to the limit.
  const removals = [
    ...inlineSkills(input.base).map((skill) => ({
      name: skill.name,
      summary: `Remove ${skill.name}`,
      text: skill.content,
      profile: () => withoutSkill(input.base, skill.name),
    })),
    ...carriedInstructionBlocks(input.base).map((block) => {
      const name =
        block.source === undefined
          ? `instruction block ${block.id}`
          : `${basename(block.source.path)}:${block.source.startLine}`
      return {
        name,
        summary: `Remove the instruction block ${name}`,
        text: block.text,
        profile: () => withoutInstructionBlock(input.base, block.id),
      }
    }),
  ]
  for (const removal of removals.slice(0, proposes('removal') ? settings.maxRemovals : 0)) {
    candidates.push(
      await candidate('removal', {
        name: removal.name,
        summary: removal.summary,
        evidence: ['the profile carries it; removal is kept only if success holds'],
        unitText: removal.text,
        unitDigest: `sha256:${sha256Hex(removal.text)}`,
        profile: removal.profile(),
        changes: null,
      }),
    )
  }
  candidates.push(...(await childProfileCandidates(input, settings, skipped)))
  candidates.push(...(await instructionBlockCandidates(input, settings, skipped)))
  return { candidates, skipped }
}

/**
 * What instruction blocks are ranked against: the tasks the active profile
 * failed in its latest measurement, with what their checks printed; or every
 * task when no measurement of this profile recorded its results; or the reason
 * there is nothing to rank against.
 */
function blockTargets(
  input: ProposeCandidatesInput,
): { readonly targets: readonly string[]; readonly against: string } | { readonly reason: string } {
  const tasks = input.tasks ?? []
  if (tasks.length === 0)
    return { reason: 'no held-out task to rank blocks against: /learn task -- <check command>' }
  const results = new Map((input.baseResults ?? []).map((result) => [result.taskId, result]))
  if (results.size === 0)
    return {
      targets: tasks.map((task) => task.prompt),
      against: `all ${tasks.length} held-out tasks: no measurement of the active profile records which it failed`,
    }
  const failed = tasks.flatMap((task) => {
    const result = results.get(task.id)
    return result?.pass === false ? [{ task, output: result.checkOutput }] : []
  })
  if (failed.length === 0)
    return {
      reason:
        'the active profile failed no held-out task in its latest measurement, so no block is proposed to fix one',
    }
  return {
    targets: failed.map(({ task, output }) =>
      output === '' ? task.prompt : `${task.prompt}\n${output}`,
    ),
    against: `the ${failed.length} held-out tasks the active profile failed and what their checks printed`,
  }
}

/**
 * Instruction-block candidates: the blocks of the instruction files the
 * sessions loaded that best match what the active profile fails, each added
 * to the profile's instructions with a record of its file and lines. A block
 * the profile already carries is not proposed again.
 */
async function instructionBlockCandidates(
  input: ProposeCandidatesInput,
  settings: LearnerSettings['candidates'],
  skipped: string[],
): Promise<LearningCandidate[]> {
  if (!settings.kinds.includes('instruction-block') || settings.maxInstructionBlocks === 0)
    return []
  const loaded = loadedInstructionBlocks(input.harness.sessions)
  if (loaded.withoutPath > 0)
    skipped.push(
      `instruction-block: ${loaded.withoutPath} sessions loaded instruction text that names no file (Codex joins the AGENTS.md files it finds), so none of it has a file and line to propose`,
    )
  if (loaded.blocks.length === 0) {
    skipped.push('instruction-block: the sessions loaded no instruction file that names its path')
    return []
  }
  const ranking = blockTargets(input)
  if ('reason' in ranking) {
    skipped.push(`instruction-block: ${ranking.reason}`)
    return []
  }
  const carried = new Set(carriedInstructionBlocks(input.base).map((block) => block.id))
  const eligible = loaded.blocks.filter(
    (block) => !carried.has(instructionBlockId(block.sha256)) && composable(block),
  )
  const ranked = rankInstructionBlocks(eligible, ranking.targets, settings.maxInstructionBlocks)
  if (ranked.length === 0) {
    skipped.push(
      `instruction-block: no block of the ${loaded.files} loaded files shares a term with ${ranking.against}`,
    )
    return []
  }
  const index = sessionIndex(input.harness.sessions)
  const candidates: LearningCandidate[] = []
  for (const { block, matched } of ranked) {
    const name = `${basename(block.path)}:${block.startLine}`
    const lines =
      block.startLine === block.endLine
        ? `line ${block.startLine}`
        : `lines ${block.startLine}-${block.endLine}`
    const changes = countChanges(block.sessions, index)
    const firstLine = block.text.split('\n')[0]?.trim() ?? ''
    candidates.push(
      await candidate('instruction-block', {
        name,
        summary: `Add ${basename(block.path)} ${lines}: ${firstLine.length > 72 ? `${firstLine.slice(0, 71)}…` : firstLine}`,
        evidence: [
          `loaded in ${block.sessions.length} sessions: ${sessionsByHarness(block.sessions)}`,
          `from ${block.path} ${lines}, in the newest text the sessions loaded (sha256 ${block.fileSha256.slice(0, 12)}${block.scope === null ? '' : `, ${block.scope} file`})`,
          await onDisk(block),
          ...(block.otherPaths === 0
            ? []
            : [`${block.otherPaths} other loaded files hold the same block`]),
          `ranked against ${ranking.against}; it matches on ${matched.join(', ')}`,
          changeEvidence(changes, 'loaded it'),
        ],
        unitText: block.text,
        unitDigest: `sha256:${block.sha256}`,
        profile: withInstructionBlock(input.base, block),
        changes,
      }),
    )
  }
  return candidates
}

/**
 * Child-profile candidates: each subagent type the sessions started that the
 * profile lacks, whose definition is committed in a GitHub checkout, becomes a
 * subagent of the profile. The child carries the definition's description and
 * prompt; its other settings are Claude Code's own names, so they are listed
 * as not carried and the child runs with the parent's tools, permissions and model.
 */
async function childProfileCandidates(
  input: ProposeCandidatesInput,
  settings: LearnerSettings['candidates'],
  skipped: string[],
): Promise<LearningCandidate[]> {
  if (!settings.kinds.includes('subagent')) return []
  const starts = subagentStarts(input.harness.sessions, input.harness.sinceMs)
    .filter((start) => input.base.subagents?.[start.type] === undefined)
    .slice(0, settings.rowsTried)
  if (starts.length === 0) {
    skipped.push('subagent: the sessions started no subagent type the profile lacks')
    return []
  }
  const directories = input.agentDirectories ?? []
  const definitions = await agentDefinitionFiles(directories)
  const index = sessionIndex(input.harness.sessions)
  const candidates: LearningCandidate[] = []
  for (const start of starts) {
    if (candidates.length >= settings.maxSubagents) break
    const where = `subagent ${start.type}`
    if (!SUBAGENT_NAME.test(start.type)) {
      skipped.push(`${where}: not a name a profile can carry, so no definition of it is mounted`)
      continue
    }
    const file = definitions.get(start.type)
    if (file === undefined) {
      skipped.push(
        `${where}: no definition names it in ${directories.length === 0 ? 'any agents directory' : directories.join(' or ')}; a built-in type has none`,
      )
      continue
    }
    const pinned = await pinAgentFile(start.type, file)
    if (!pinned.pinned) {
      skipped.push(`${where}: ${pinned.reason}`)
      continue
    }
    const { agent } = pinned
    const definition = readAgentDefinition(agent.content)
    if (!definition.read || definition.fields.name !== start.type) {
      skipped.push(
        `${where}: ${definition.read ? 'the committed definition names another subagent' : definition.reason}`,
      )
      continue
    }
    const sha256 = sha256Hex(agent.content)
    const pin = `${agent.repository}@${agent.commit.slice(0, 12)}`
    const notCarried = Object.entries(definition.fields).filter(
      ([key]) => key !== 'name' && key !== 'description',
    )
    const changes = countChanges(start.records, index)
    candidates.push(
      await candidate('subagent', {
        name: start.type,
        summary: `Add the ${start.type} child profile from ${pin}`,
        evidence: [
          `${start.calls} starts in ${start.records.length} sessions: ${sessionsByHarness(start.records)}`,
          changeEvidence(changes, `started ${start.type}`),
          `pinned to ${pin}:${agent.path}`,
          notCarried.length === 0
            ? "carries the definition's description and prompt"
            : `not carried: ${notCarried.map(([key, value]) => `${key} (${value})`).join(', ')}; the child runs with the parent's tools, permissions and model`,
        ],
        unitText: agent.content,
        unitDigest: `sha256:${sha256}`,
        profile: withSubagent(
          input.base,
          { description: definition.description, prompt: definition.prompt },
          {
            name: start.type,
            repository: agent.repository,
            ref: agent.commit,
            path: agent.path,
            sha256,
          },
        ),
        changes,
      }),
    )
  }
  return candidates
}
