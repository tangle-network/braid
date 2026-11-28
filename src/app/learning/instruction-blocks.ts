import { readFile } from 'node:fs/promises'
import type { SkillSessionRecord } from '@tangle-network/agent-eval/analyst'
import type { AgentProfile } from '@tangle-network/agent-interface'
import { composeAgentProfileGuidance } from '@tangle-network/agent-interface/profile'
import { provenanceNamespace, sha256Hex } from './learning-profile.js'

/**
 * Rule blocks from the instruction files recorded sessions loaded: a CLAUDE.md,
 * an AGENTS.md, a private layer, a memory index. Eval's session readers name
 * each file a harness loaded with its text; this module splits that text into
 * blocks, ranks them against the held-out tasks the active profile fails, and
 * adds one to a profile or takes one out of it.
 *
 * A block is one list item with its continuation lines and without its
 * marker, one paragraph, one table row under its header, or a fenced code
 * block, joined to the paragraph before it when that paragraph ends with a
 * colon. Headings, imports (`@file`) and front matter are not blocks.
 */

/** The guidance source a learned block is composed under in the profile's instructions. */
export const INSTRUCTION_BLOCK_SOURCE = 'braid.instruction-file'

/** One block of one file's text, by its 1-based lines in that text. */
export interface TextBlock {
  readonly startLine: number
  readonly endLine: number
  readonly text: string
}

const LIST_ITEM = /^( {0,3})(?:[-*+]|\d{1,3}[.)])\s+\S/u
const LIST_MARKER = /^ {0,3}(?:[-*+]|\d{1,3}[.)])\s+/u
const FENCE = /^ {0,3}(?:```|~~~)/u
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/u
const TABLE_ROW = /^ {0,3}\|/u
const TABLE_RULE = /^ {0,3}\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/u
const IMPORT = /^@\S+$/u
const GUIDANCE_CLOSE = '</profile-guidance>'
const MIN_BLOCK_CHARS = 20
const MAX_BLOCK_CHARS = 4_000

interface OpenBlock {
  startLine: number
  endLine: number
  lines: string[]
  kind: 'list' | 'paragraph' | 'fence'
  indent: number
  fenced: boolean
}

const indentOf = (line: string) => line.length - line.trimStart().length

/** Split one instruction file's text into blocks, in file order. */
export function instructionBlocks(text: string): TextBlock[] {
  const lines = text.split(/\r?\n/u)
  const blocks: TextBlock[] = []
  let open: OpenBlock | null = null
  let header: readonly string[] | null = null
  const close = () => {
    if (open !== null) {
      // A list item's marker is its place in the list, not its rule: renumbering keeps the block.
      const lines =
        open.kind === 'list'
          ? [(open.lines[0] as string).replace(LIST_MARKER, ''), ...open.lines.slice(1)]
          : open.lines
      const body = lines.join('\n').replace(/\s+$/u, '')
      if (body.length >= MIN_BLOCK_CHARS)
        blocks.push({ startLine: open.startLine, endLine: open.endLine, text: body })
    }
    open = null
  }
  const start = (kind: OpenBlock['kind'], number: number, line: string): OpenBlock => ({
    startLine: number,
    endLine: number,
    lines: [line],
    kind,
    indent: indentOf(line),
    fenced: kind === 'fence',
  })
  let index = 0
  // Front matter is settings, not rules.
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, at) => at > 0 && line.trim() === '---')
    if (end > 0) index = end + 1
  }
  for (; index < lines.length; index++) {
    const line = lines[index] as string
    const number = index + 1
    const current = open as OpenBlock | null
    if (current?.fenced) {
      current.lines.push(line)
      current.endLine = number
      if (FENCE.test(line)) close()
      continue
    }
    if (FENCE.test(line)) {
      const last = current?.lines.at(-1)?.trimEnd() ?? ''
      if (current !== null && last.endsWith(':')) {
        current.lines.push(line)
        current.endLine = number
        current.fenced = true
      } else {
        close()
        open = start('fence', number, line)
      }
      continue
    }
    if (line.trim() === '') {
      if (current === null) continue
      const next = lines.slice(index + 1).find((item) => item.trim() !== '')
      const continues =
        next !== undefined &&
        ((current.kind === 'list' && indentOf(next) > current.indent) ||
          (FENCE.test(next) && (current.lines.at(-1)?.trimEnd() ?? '').endsWith(':')))
      if (continues) current.lines.push(line)
      else close()
      continue
    }
    if (HEADING.test(line) || IMPORT.test(line.trim())) {
      close()
      header = null
      continue
    }
    if (TABLE_ROW.test(line)) {
      close()
      if (TABLE_RULE.test(line)) continue
      const next = lines[index + 1]
      if (next !== undefined && TABLE_RULE.test(next)) {
        header = [line, next]
        continue
      }
      const row = [...(header ?? []), line].join('\n')
      if (row.length >= MIN_BLOCK_CHARS)
        blocks.push({ startLine: number, endLine: number, text: row })
      continue
    }
    header = null
    if (LIST_ITEM.test(line) && (current?.kind !== 'list' || indentOf(line) <= current.indent)) {
      close()
      open = start('list', number, line)
      continue
    }
    if (current === null) {
      open = start('paragraph', number, line)
      continue
    }
    current.lines.push(line)
    current.endLine = number
  }
  close()
  return blocks.filter(
    (block) => block.text.length <= MAX_BLOCK_CHARS && terms(block.text).length >= 3,
  )
}

const STOP = new Set(
  (
    'a an and are as at be been but by can do does each for from had has have how i if in into is it its ' +
    'may me must my no not of on one only or our should so than that the their them then there these they ' +
    'this those to us was we were what when where which who will with you your'
  ).split(' '),
)

/** A word's crude stem, so `gate`, `gates` and `gating` count as one term. */
function stem(word: string): string {
  let stemmed = word
  for (const suffix of ['ing', 'ed', 'es', 's'])
    if (stemmed.length > 4 && stemmed.endsWith(suffix)) {
      stemmed = stemmed.slice(0, -suffix.length)
      break
    }
  return stemmed.length > 3 && stemmed.endsWith('e') ? stemmed.slice(0, -1) : stemmed
}

/** The terms a block or task is ranked by: lowercased words without stop words or numbers, stemmed. */
export function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length > 1 && !STOP.has(word) && !/^\d+$/u.test(word))
    .map(stem)
}

/** A block the sessions loaded, from the newest text of the file it names. */
export interface LoadedBlock extends TextBlock {
  /** sha256 of the block's text, hex. */
  readonly sha256: string
  /** The file whose newest loaded text holds it, and where that file sits in the harness's words. */
  readonly path: string
  readonly scope: string | null
  /** sha256 of that file text, as the session loaded it, hex. */
  readonly fileSha256: string
  /** Other files whose newest loaded text holds the same block. */
  readonly otherPaths: number
  /** Sessions whose loaded text of any file, at any version, holds it. */
  readonly sessions: readonly SkillSessionRecord[]
}

export interface LoadedBlocks {
  readonly blocks: readonly LoadedBlock[]
  /** Files the sessions loaded, by path, at their newest text. */
  readonly files: number
  /** Sessions whose harness loaded instruction text that names no file (Codex's AGENTS.md). */
  readonly withoutPath: number
}

/**
 * Every block of every instruction file the sessions loaded, from each file's
 * newest loaded text, so a block the user has since removed is not proposed.
 * A block that several files hold counts once, under the file loaded last.
 */
export function loadedInstructionBlocks(sessions: readonly SkillSessionRecord[]): LoadedBlocks {
  const newest = new Map<string, NewestText>()
  const texts = new Map<string, string>()
  const loadedBy = new Map<string, Set<SkillSessionRecord>>()
  let withoutPath = 0
  for (const session of sessions) {
    const files = session.instructions ?? []
    if (files.some((file) => file.path === null)) withoutPath += 1
    for (const file of files) {
      if (file.path === null) continue
      texts.set(file.sha256, file.text)
      const readers = loadedBy.get(file.sha256) ?? new Set()
      readers.add(session)
      loadedBy.set(file.sha256, readers)
      const at = file.at ?? ''
      const known = newest.get(file.path)
      if (known === undefined || at > known.at)
        newest.set(file.path, { at, scope: file.scope, sha256: file.sha256, text: file.text })
    }
  }
  // Which sessions loaded each block, through any version of any file that holds it.
  const sessionsOf = new Map<string, Set<SkillSessionRecord>>()
  for (const [textSha, text] of texts)
    for (const block of distinctBlocks(text).keys()) {
      const readers = sessionsOf.get(block) ?? new Set()
      for (const session of loadedBy.get(textSha) ?? []) readers.add(session)
      sessionsOf.set(block, readers)
    }
  const chosen = new Map<
    string,
    { readonly block: TextBlock; readonly path: string; readonly file: NewestText; paths: number }
  >()
  for (const [path, file] of newest)
    for (const [sha256, block] of distinctBlocks(file.text)) {
      const known = chosen.get(sha256)
      if (known === undefined) chosen.set(sha256, { block, path, file, paths: 1 })
      else if (file.at > known.file.at)
        chosen.set(sha256, { block, path, file, paths: known.paths + 1 })
      else known.paths += 1
    }
  const blocks = [...chosen].map(([sha256, item]) => ({
    ...item.block,
    sha256,
    path: item.path,
    scope: item.file.scope,
    fileSha256: item.file.sha256,
    otherPaths: item.paths - 1,
    sessions: [...(sessionsOf.get(sha256) ?? [])],
  }))
  return { blocks, files: newest.size, withoutPath }
}

/** A file's newest loaded text. */
interface NewestText {
  readonly at: string
  readonly scope: string | null
  readonly sha256: string
  readonly text: string
}

/** A text's blocks by the sha256 of their text, the first of any repeated block kept. */
function distinctBlocks(text: string): Map<string, TextBlock> {
  const blocks = new Map<string, TextBlock>()
  for (const block of instructionBlocks(text)) {
    const sha256 = sha256Hex(block.text)
    if (!blocks.has(sha256)) blocks.set(sha256, block)
  }
  return blocks
}

export interface RankedBlock {
  readonly block: LoadedBlock
  readonly score: number
  /** The terms that scored most, best first. */
  readonly matched: readonly string[]
}

const K1 = 1.2
const B = 0.75
const SIMILAR = 0.5

/**
 * Rank blocks by Okapi BM25 against the target texts: each task's request and,
 * when measured, what its check printed. A term weighs the share of targets
 * that use it, and less the more blocks hold it. Blocks whose terms overlap a
 * better-ranked block's by half or more are left out, so the picks differ.
 *
 * Passed tasks are not subtracted: their words differ from the failed tasks'
 * mostly by the kind of task, not by what went wrong, so subtracting them
 * favours a block that names the failing kind of task over one that fixes it.
 */
export function rankInstructionBlocks(
  blocks: readonly LoadedBlock[],
  targets: readonly string[],
  limit: number,
): RankedBlock[] {
  if (targets.length === 0 || blocks.length === 0 || limit <= 0) return []
  const weights = new Map<string, number>()
  for (const text of targets)
    for (const term of new Set(terms(text)))
      weights.set(term, (weights.get(term) ?? 0) + 1 / targets.length)
  const bags = blocks.map((block) => terms(block.text))
  const documents = new Map<string, number>()
  for (const bag of bags)
    for (const term of new Set(bag)) documents.set(term, (documents.get(term) ?? 0) + 1)
  const average = bags.reduce((sum, bag) => sum + bag.length, 0) / bags.length
  const scored = blocks.map((block, at) => {
    const bag = bags[at] as string[]
    const frequency = new Map<string, number>()
    for (const term of bag) frequency.set(term, (frequency.get(term) ?? 0) + 1)
    const parts: Array<[string, number]> = []
    for (const [term, weight] of weights) {
      const count = frequency.get(term) ?? 0
      if (count === 0) continue
      const containing = documents.get(term) ?? 0
      const idf = Math.log(1 + (blocks.length - containing + 0.5) / (containing + 0.5))
      parts.push([
        term,
        (weight * idf * count * (K1 + 1)) / (count + K1 * (1 - B + (B * bag.length) / average)),
      ])
    }
    parts.sort((left, right) => right[1] - left[1])
    return {
      block,
      score: parts.reduce((sum, [, value]) => sum + value, 0),
      matched: parts.slice(0, 6).map(([term]) => term),
      set: new Set(bag),
    }
  })
  scored.sort(
    (left, right) =>
      right.score - left.score ||
      right.block.sessions.length - left.block.sessions.length ||
      left.block.sha256.localeCompare(right.block.sha256),
  )
  const picked: typeof scored = []
  for (const item of scored) {
    if (picked.length >= limit || item.score <= 0) break
    const similar = picked.some((chosen) => {
      let shared = 0
      for (const term of item.set) if (chosen.set.has(term)) shared += 1
      return shared / (item.set.size + chosen.set.size - shared) >= SIMILAR
    })
    if (!similar) picked.push(item)
  }
  return picked.map(({ block, score, matched }) => ({ block, score, matched }))
}

/** Where a learned block came from, recorded beside the profile's other provenance as `instructionSources`. */
export interface InstructionBlockSource {
  /** The guidance block's id in the profile's instructions. */
  readonly id: string
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  readonly scope: string | null
  /** sha256 of the file text the sessions loaded, and of the block. */
  readonly fileSha256: string
  readonly sha256: string
}

/** A block the profile carries, read from its instructions. */
export interface CarriedBlock {
  readonly id: string
  readonly text: string
  readonly source: InstructionBlockSource | undefined
}

const CARRIED = new RegExp(
  `^<profile-guidance source="${INSTRUCTION_BLOCK_SOURCE.replaceAll('.', '\\.')}" id="([^"]+)">\\n([\\s\\S]*)\\n</profile-guidance>$`,
  'u',
)

function sourcesOf(profile: AgentProfile): InstructionBlockSource[] {
  const recorded = profile.extensions?.[provenanceNamespace(profile)]?.instructionSources
  return Array.isArray(recorded) ? (recorded as InstructionBlockSource[]) : []
}

export function carriedInstructionBlocks(profile: AgentProfile): CarriedBlock[] {
  const sources = sourcesOf(profile)
  return (profile.prompt?.instructions ?? []).flatMap((line) => {
    const match = CARRIED.exec(line)
    if (match === null) return []
    const id = match[1] as string
    return [{ id, text: match[2] as string, source: sources.find((item) => item.id === id) }]
  })
}

/** A block's id in the profile: the first 16 hex digits of its text's sha256. */
export function instructionBlockId(sha256: string): string {
  return sha256.slice(0, 16)
}

/** True when the block can be composed: its text cannot close the guidance block early. */
export function composable(block: Pick<TextBlock, 'text'>): boolean {
  return !block.text.includes(GUIDANCE_CLOSE)
}

function withBlocks(
  profile: AgentProfile,
  blocks: readonly { readonly id: string; readonly text: string }[],
  sources: readonly InstructionBlockSource[],
): AgentProfile {
  const composed = composeAgentProfileGuidance(
    profile,
    blocks.map((block) => ({ source: INSTRUCTION_BLOCK_SOURCE, id: block.id, text: block.text })),
    'instructions',
    { replaceSources: [INSTRUCTION_BLOCK_SOURCE] },
  )
  const namespace = provenanceNamespace(profile)
  const extension = { ...profile.extensions?.[namespace] }
  delete extension.instructionSources
  const recorded =
    sources.length === 0 ? extension : { ...extension, instructionSources: [...sources] }
  const extensions = { ...profile.extensions }
  if (Object.keys(recorded).length === 0) delete extensions[namespace]
  else extensions[namespace] = recorded
  const next: AgentProfile = { ...composed }
  if (Object.keys(extensions).length === 0) delete next.extensions
  else next.extensions = extensions
  return next
}

/** A copy of the profile with one more block, after the blocks it carries, and its source record. */
export function withInstructionBlock(profile: AgentProfile, block: LoadedBlock): AgentProfile {
  const id = instructionBlockId(block.sha256)
  const carried = carriedInstructionBlocks(profile).filter((item) => item.id !== id)
  const sources = sourcesOf(profile).filter((item) => item.id !== id)
  return withBlocks(
    profile,
    [...carried, { id, text: block.text }],
    [
      ...sources,
      {
        id,
        path: block.path,
        startLine: block.startLine,
        endLine: block.endLine,
        scope: block.scope,
        fileSha256: block.fileSha256,
        sha256: block.sha256,
      },
    ],
  )
}

/** A copy of the profile without one carried block or its source record. */
export function withoutInstructionBlock(profile: AgentProfile, id: string): AgentProfile {
  return withBlocks(
    profile,
    carriedInstructionBlocks(profile).filter((item) => item.id !== id),
    sourcesOf(profile).filter((item) => item.id !== id),
  )
}

/** Where the file on disk holds the block now, as an evidence line. */
export async function onDisk(block: LoadedBlock): Promise<string> {
  let content: string
  try {
    content = await readFile(block.path, 'utf8')
  } catch {
    return 'the file cannot be read now'
  }
  const at = content.indexOf(block.text)
  if (at < 0) return 'the file on disk no longer holds it as loaded'
  const line = content.slice(0, at).split('\n').length
  return line === block.startLine
    ? 'the file on disk holds it at the same lines'
    : `the file on disk holds it from line ${line}`
}
