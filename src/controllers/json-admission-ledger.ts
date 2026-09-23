import { resolve } from 'node:path'
import { canonicalJson } from '../domain/canonical.js'
import {
  type FileIdentity,
  readFileIdentity,
  replaceFileAtomically,
} from '../profile/profile-files.js'
import { parseBoundedProfileJson } from '../profile/profile-json.js'
import { withFileLock } from '../persistence/file-lock.js'
import {
  AdmissionConflictError,
  type AdmissionLedger,
  type AdmissionLedgerEntry,
  normalizeAdmissionEntry,
  transitionAdmissionEntry,
} from './admission-ledger.js'

async function readLedgerSnapshot(path: string): Promise<{
  readonly entries: Map<string, AdmissionLedgerEntry>
  readonly identity: FileIdentity | undefined
}> {
  const read = await readFileIdentity(path, { maxBytes: 1_048_576 })
  if (read === undefined) return { entries: new Map(), identity: undefined }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes)
  } catch {
    throw new Error('Admission ledger is not valid UTF-8')
  }
  const value = parseBoundedProfileJson(text)
  if (!Array.isArray(value)) throw new Error('Admission ledger must contain an array')
  if (value.length > 256) throw new Error('Admission ledger contains too many operations')
  const result = new Map<string, AdmissionLedgerEntry>()
  for (const entry of value.map(normalizeAdmissionEntry)) {
    if (result.has(entry.operationId))
      throw new Error('Admission ledger contains duplicate operations')
    result.set(entry.operationId, entry)
  }
  return { entries: result, identity: read.identity }
}

async function readLedgerEntries(path: string): Promise<Map<string, AdmissionLedgerEntry>> {
  return (await readLedgerSnapshot(path)).entries
}

/** Restart-safe persistence for non-secret admission outcomes. */
export class JsonAdmissionLedger implements AdmissionLedger {
  readonly #path: string
  #entries = new Map<string, AdmissionLedgerEntry>()
  #loaded = false
  #loading: Promise<void> | undefined

  constructor(path: string) {
    this.#path = resolve(path)
  }

  async #load(): Promise<void> {
    if (this.#loaded) return
    if (this.#loading !== undefined) return this.#loading
    this.#loading = (async () => {
      this.#entries = (await readLedgerSnapshot(this.#path)).entries
      this.#loaded = true
    })().finally(() => {
      this.#loading = undefined
    })
    return this.#loading
  }

  async read(operationId: string): Promise<AdmissionLedgerEntry | undefined> {
    await this.#load()
    return withFileLock(this.#path, async () => {
      const snapshot = await readLedgerSnapshot(this.#path)
      this.#entries = snapshot.entries
      return this.#entries.get(operationId)
    })
  }

  async reserve(entry: AdmissionLedgerEntry): Promise<AdmissionLedgerEntry | undefined> {
    await this.#load()
    return withFileLock(this.#path, async () => {
      const safe = normalizeAdmissionEntry(entry)
      const snapshot = await readLedgerSnapshot(this.#path)
      this.#entries = snapshot.entries
      const existing = this.#entries.get(safe.operationId)
      if (existing !== undefined) {
        if (existing.operationDigest !== safe.operationDigest) {
          throw new AdmissionConflictError(safe.operationId, 'the operation digest changed')
        }
        return existing
      }
      this.#entries.set(safe.operationId, safe)
      try {
        await this.#persist(snapshot.identity)
      } catch (error) {
        const fresh = await readLedgerEntries(this.#path).catch(() => undefined)
        if (fresh !== undefined) {
          this.#entries = fresh
          const winner = fresh.get(safe.operationId)
          if (winner !== undefined && winner.operationDigest === safe.operationDigest) return winner
          if (winner !== undefined) {
            throw new AdmissionConflictError(safe.operationId, 'another operation used this id')
          }
        }
        throw error
      }
      return undefined
    })
  }

  async write(entry: AdmissionLedgerEntry): Promise<void> {
    await this.#load()
    await withFileLock(this.#path, async () => {
      const safe = normalizeAdmissionEntry(entry)
      const snapshot = await readLedgerSnapshot(this.#path)
      this.#entries = snapshot.entries
      const existing = this.#entries.get(safe.operationId)
      this.#entries.set(safe.operationId, transitionAdmissionEntry(existing, safe))
      try {
        await this.#persist(snapshot.identity)
      } catch (error) {
        this.#entries = await readLedgerEntries(this.#path).catch(() => this.#entries)
        throw error
      }
    })
  }

  entries(): readonly AdmissionLedgerEntry[] {
    return Object.freeze([...this.#entries.values()])
  }

  async #persist(expected: FileIdentity | undefined): Promise<void> {
    const bytes = new TextEncoder().encode(`${canonicalJson([...this.#entries.values()])}\n`)
    await replaceFileAtomically({ path: this.#path, bytes, mode: 0o600, expected })
  }
}
