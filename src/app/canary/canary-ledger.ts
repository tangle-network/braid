/**
 * The canary's assignment ledger: an append-only JSONL file whose entries form
 * a hash chain. Each entry names the digest of the one before it and its own
 * digest over everything else it holds, so an edit, a removal or a reorder of
 * any earlier entry breaks every later one.
 *
 * The first entry is the sealed protocol. After it come assignments, one per
 * task, and dispositions: arrivals the eligibility rule turned away, kept so
 * the roster of arrivals is complete.
 *
 * When the ledger file sits in a git checkout with an `origin`, every append
 * is a commit pushed to `origin`'s main branch. The push is the ledger's
 * order across hosts: a rejected push means another host appended first, so
 * the append is redone on top of what it pushed. The remote's history is the
 * independent witness of when each entry existed.
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  acquirePrivateFileLock,
  releasePrivateFileLock,
} from '../../adapters/persistence/safe-file.js'
import { canonicalJson } from '../../domain/canonical.js'
import { AppError } from '../errors.js'
import { sha256Hex } from '../learning/learning-profile.js'

export type CanaryArm = 'control' | 'candidate'

interface EntryBase {
  readonly index: number
  readonly at: string
  /** The previous entry's digest; null for the protocol entry. */
  readonly prev: string | null
  /** sha256 of the entry's canonical text without this field. */
  readonly digest: string
}

export interface ProtocolEntry extends EntryBase {
  readonly kind: 'protocol'
  readonly experimentId: string
  /** The digest agent-eval's seal computed over the registered analysis rule. */
  readonly protocolDigest: string
  readonly protocol: Readonly<Record<string, unknown>>
}

export interface AssignmentEntry extends EntryBase {
  readonly kind: 'assignment'
  readonly experimentId: string
  readonly assignmentId: string
  readonly taskId: string
  readonly skill: string
  readonly repository: string
  readonly arm: CanaryArm
  /** The sealed pack the candidate arm is served for this skill, named in both arms. */
  readonly packDigest: string
}

export interface DispositionEntry extends EntryBase {
  readonly kind: 'disposition'
  readonly experimentId: string
  readonly taskId: string
  readonly skill: string
  readonly repository: string
  readonly reason: string
}

export type LedgerEntry = ProtocolEntry | AssignmentEntry | DispositionEntry

type Unchained<T> = T extends LedgerEntry ? Omit<T, 'index' | 'at' | 'prev' | 'digest'> : never
export type LedgerAppend = Unchained<LedgerEntry>

/** The `sha256:`-prefixed digest of a text, as the ledger, the seal and the packs name it. */
export function canaryDigest(text: string): string {
  return `sha256:${sha256Hex(text)}`
}

function entryDigest(entry: Omit<LedgerEntry, 'digest'>): string {
  return canaryDigest(canonicalJson(entry))
}

/** Read and verify the chain. A missing file is an empty ledger. */
export function readLedger(path: string): LedgerEntry[] {
  if (!existsSync(path)) return []
  const entries: LedgerEntry[] = []
  const lines = readFileSync(path, 'utf8').split('\n')
  for (const [number, line] of lines.entries()) {
    if (line === '') {
      if (number !== lines.length - 1)
        throw new AppError('CANARY_LEDGER_INVALID', `ledger line ${number + 1} is empty`)
      continue
    }
    let entry: LedgerEntry
    try {
      entry = JSON.parse(line) as LedgerEntry
    } catch {
      throw new AppError('CANARY_LEDGER_INVALID', `ledger line ${number + 1} is not JSON`)
    }
    const previous = entries.at(-1)
    const { digest, ...rest } = entry
    if (entry.index !== entries.length || entry.prev !== (previous?.digest ?? null))
      throw new AppError('CANARY_LEDGER_INVALID', `ledger entry ${number + 1} breaks the chain`)
    if (digest !== entryDigest(rest))
      throw new AppError('CANARY_LEDGER_INVALID', `ledger entry ${number + 1} was edited`)
    if ((entry.index === 0) !== (entry.kind === 'protocol'))
      throw new AppError(
        'CANARY_LEDGER_INVALID',
        'the protocol is the first entry and only the first',
      )
    entries.push(entry)
  }
  return entries
}

function git(directory: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function gitRemote(directory: string): boolean {
  try {
    return (
      git(directory, ['rev-parse', '--is-inside-work-tree']) === 'true' &&
      git(directory, ['remote']).split('\n').includes('origin')
    )
  } catch {
    return false
  }
}

/** Bring a git-backed ledger up to its remote. The local copy is never ahead of a completed append. */
export function syncLedger(path: string): void {
  const directory = dirname(path)
  if (!gitRemote(directory)) return
  // A new remote has no main until its first append.
  if (git(directory, ['ls-remote', '--heads', 'origin', 'main']) === '') return
  git(directory, ['fetch', '--quiet', 'origin', 'main'])
  git(directory, ['checkout', '--quiet', '--force', '-B', 'main', 'origin/main'])
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function withLock<T>(path: string, work: () => T): T {
  const lock = join(dirname(path), `.${basename(path)}.lock`)
  for (let attempt = 0; ; attempt++) {
    let handle: number
    try {
      handle = acquirePrivateFileLock(lock, 'The canary ledger')
    } catch (error) {
      if (attempt < 100 && error instanceof Error && error.message.includes('busy')) {
        sleep(50 + Math.floor(Math.random() * 100))
        continue
      }
      throw error
    }
    try {
      return work()
    } finally {
      releasePrivateFileLock(lock, handle)
    }
  }
}

/**
 * Decide and append one entry. `decide` sees the verified ledger as it stands
 * after the remote's latest appends and returns the entry to append, or null
 * when there is nothing to append (the task already holds an assignment).
 * A rejected push redoes the decision on top of the remote's new entries.
 */
export function appendLedger<T>(
  path: string,
  decide: (entries: readonly LedgerEntry[]) => {
    readonly append: LedgerAppend | null
    readonly result: T
  },
  now: () => Date = () => new Date(),
): T {
  const directory = dirname(path)
  const remote = gitRemote(directory)
  return withLock(path, () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      if (remote) syncLedger(path)
      const entries = readLedger(path)
      const { append, result } = decide(entries)
      if (append === null) return result
      const previous = entries.at(-1)
      const unsigned = {
        ...append,
        index: entries.length,
        at: now().toISOString(),
        prev: previous?.digest ?? null,
      } as Omit<LedgerEntry, 'digest'>
      const entry = { ...unsigned, digest: entryDigest(unsigned) }
      appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
      const handle = openSync(path, 'r')
      try {
        fsyncSync(handle)
      } finally {
        closeSync(handle)
      }
      if (!remote) return result
      git(directory, ['add', basename(path)])
      git(directory, ['commit', '--quiet', '-m', `${entry.kind} ${entry.index}`])
      try {
        git(directory, ['push', '--quiet', 'origin', 'HEAD:main'])
        return result
      } catch {
        sleep(100 + Math.floor(Math.random() * 400))
      }
    }
    throw new AppError(
      'CANARY_LEDGER_CONTENDED',
      'The ledger remote kept moving; nothing was assigned. Try again.',
    )
  })
}
