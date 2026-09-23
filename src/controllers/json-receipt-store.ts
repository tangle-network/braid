import { resolve } from 'node:path'
import { canonicalDigest, canonicalJson } from '../domain/canonical.js'
import { withFileLock } from '../persistence/file-lock.js'
import {
  type FileIdentity,
  readFileIdentity,
  replaceFileAtomically,
} from '../profile/profile-files.js'
import { parseBoundedProfileJson } from '../profile/profile-json.js'
import {
  MaterializationReceiptConflictError,
  type PostMaterializationReceipt,
  type PreAdmissionReceipt,
  type ReceiptStore,
} from './admission-contracts.js'
import {
  assertPostMatchesPre,
  normalizeStoredPostMaterialization,
  normalizeStoredPreAdmission,
} from './receipt-store-validation.js'

const MAX_RECEIPTS = 2_048
const MAX_BYTES = 1_048_576

interface ReceiptSnapshot {
  readonly pre: PreAdmissionReceipt[]
  readonly post: PostMaterializationReceipt[]
  readonly identity: FileIdentity | undefined
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Receipt store ${field} must be an object`)
  }
  return value as Record<string, unknown>
}

async function readSnapshot(path: string): Promise<ReceiptSnapshot> {
  const read = await readFileIdentity(path, { maxBytes: MAX_BYTES })
  if (read === undefined) return { pre: [], post: [], identity: undefined }
  let value: unknown
  try {
    value = parseBoundedProfileJson(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes))
  } catch (error) {
    throw new Error(
      `Receipt store is invalid: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const root = record(value, 'root')
  if (Object.keys(root).some((key) => key !== 'pre' && key !== 'post')) {
    throw new Error('Receipt store root contains an unsupported field')
  }
  if (!Array.isArray(root.pre) || !Array.isArray(root.post)) {
    throw new Error('Receipt store must contain pre and post arrays')
  }
  if (root.pre.length > MAX_RECEIPTS || root.post.length > MAX_RECEIPTS) {
    throw new Error(`Receipt store contains more than ${MAX_RECEIPTS} receipts`)
  }
  const pre = root.pre.map((entry) => {
    const candidate = record(entry, 'pre-admission')
    return normalizeStoredPreAdmission(candidate as unknown as PreAdmissionReceipt)
  })
  if (new Set(pre.map((entry) => entry.receiptDigest)).size !== pre.length) {
    throw new Error('Receipt store contains duplicate pre-admission receipts')
  }
  const post = root.post.map((entry) => {
    const candidate = record(entry, 'post-materialization')
    return normalizeStoredPostMaterialization(candidate as unknown as PostMaterializationReceipt)
  })
  if (new Set(post.map((entry) => entry.preAdmissionDigest)).size !== post.length) {
    throw new Error('Receipt store contains duplicate post-materialization receipts')
  }
  const preByDigest = new Map(pre.map((entry) => [entry.receiptDigest, entry]))
  for (const entry of post) {
    const linked = preByDigest.get(entry.preAdmissionDigest)
    if (linked === undefined) {
      throw new Error(
        'Receipt store contains a post-materialization receipt without its pre-admission receipt',
      )
    }
    assertPostMatchesPre(linked, entry)
  }
  return { pre, post, identity: read.identity }
}

/** Restart-safe, conflict-preserving receipt storage for admission outcomes. */
export class JsonReceiptStore implements ReceiptStore {
  readonly #path: string

  constructor(path: string) {
    this.#path = resolve(path)
  }

  async savePreAdmission(receipt: PreAdmissionReceipt): Promise<void> {
    const normalized = normalizeStoredPreAdmission(receipt)
    await withFileLock(this.#path, async () => {
      const snapshot = await readSnapshot(this.#path)
      const existing = snapshot.pre.find(
        (candidate) => candidate.receiptDigest === normalized.receiptDigest,
      )
      if (existing !== undefined && canonicalDigest(existing) !== canonicalDigest(normalized)) {
        throw new MaterializationReceiptConflictError(normalized.receiptDigest)
      }
      if (existing !== undefined) return
      await this.#persist(snapshot.identity, [...snapshot.pre, normalized], snapshot.post)
    })
  }

  async savePostMaterialization(receipt: PostMaterializationReceipt): Promise<void> {
    const normalized = normalizeStoredPostMaterialization(receipt)
    await withFileLock(this.#path, async () => {
      const snapshot = await readSnapshot(this.#path)
      const pre = snapshot.pre.find(
        (candidate) => candidate.receiptDigest === normalized.preAdmissionDigest,
      )
      if (pre === undefined) {
        throw new Error('Post-materialization receipt requires its pre-admission receipt')
      }
      assertPostMatchesPre(pre, normalized)
      const existing = snapshot.post.find(
        (candidate) => candidate.preAdmissionDigest === normalized.preAdmissionDigest,
      )
      if (existing !== undefined && canonicalDigest(existing) !== canonicalDigest(normalized)) {
        throw new MaterializationReceiptConflictError(normalized.preAdmissionDigest)
      }
      if (existing !== undefined) return
      await this.#persist(snapshot.identity, snapshot.pre, [...snapshot.post, normalized])
    })
  }

  async findPostMaterialization(
    preAdmissionDigest: string,
  ): Promise<PostMaterializationReceipt | undefined> {
    return (await readSnapshot(this.#path)).post.find(
      (candidate) => candidate.preAdmissionDigest === preAdmissionDigest,
    )
  }

  async #persist(
    expected: FileIdentity | undefined,
    pre: readonly PreAdmissionReceipt[],
    post: readonly PostMaterializationReceipt[],
  ): Promise<void> {
    const bytes = new TextEncoder().encode(`${canonicalJson({ pre, post })}\n`)
    await replaceFileAtomically({ path: this.#path, bytes, mode: 0o600, expected })
  }
}
