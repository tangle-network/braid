import { createHash } from 'node:crypto'
import { canonicalJson } from '../domain/canonical.js'
import { containsControlCharacters, redactProviderText } from './redaction.js'
import { cloneBoundedProfileValue, type ProfileJsonLimits } from '../profile/profile-json.js'
import {
  containedWorkspacePath,
  closeWorkspaceRoot,
  openWorkspaceRoot,
  readWorkspaceFile,
} from './workspace-paths.js'

export interface WorkspaceIdentity {
  readonly root: string
  readonly repositoryIdentity?: string
}

export interface WorkspaceConfigEntry {
  readonly path: string
  readonly present: boolean
  readonly digest?: string
  readonly capabilities: readonly (
    | 'project-config'
    | 'profile-source'
    | 'hook'
    | 'local-mcp'
    | 'resource-write'
    | 'environment-reference'
  )[]
}

export interface WorkspaceTrustPreview {
  readonly identity: WorkspaceIdentity
  readonly configurationDigest: string
  readonly entries: readonly WorkspaceConfigEntry[]
  readonly capabilities: readonly WorkspaceConfigEntry['capabilities'][number][]
}

export interface WorkspaceTrustRecord {
  readonly identity: WorkspaceIdentity
  readonly configurationDigest: string
  readonly approvedAt: string
  readonly capabilities: readonly WorkspaceConfigEntry['capabilities'][number][]
}

export interface WorkspaceInspectionFile {
  readonly path: string
  readonly capabilities: WorkspaceConfigEntry['capabilities']
}

/** Largest workspace configuration file Braid will hash for a trust preview. */
export const MAX_WORKSPACE_CONFIG_BYTES = 1_048_576
const MAX_INSPECTION_FILES = 256
const WORKSPACE_INPUT_LIMITS: ProfileJsonLimits = Object.freeze({
  maxBytes: 1_048_576,
  maxDepth: 16,
  maxNodes: 4_096,
  maxStringLength: 4_096,
  maxEntries: 4_096,
})
const WORKSPACE_CAPABILITIES = new Set<WorkspaceConfigEntry['capabilities'][number]>([
  'project-config',
  'profile-source',
  'hook',
  'local-mcp',
  'resource-write',
  'environment-reference',
])

export class WorkspaceNotTrustedError extends Error {
  readonly identity: WorkspaceIdentity

  constructor(identity: WorkspaceIdentity, detail: string) {
    const root = redactProviderText(identity.root, 1_024) ?? '<unknown workspace>'
    const safeDetail = redactProviderText(detail, 512) ?? 'trust verification failed'
    super(`Workspace ${root} is not trusted for project-controlled capabilities: ${safeDetail}`)
    this.name = 'WorkspaceNotTrustedError'
    this.identity = identity
  }
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function digestPreview(
  identity: WorkspaceIdentity,
  entries: readonly WorkspaceConfigEntry[],
): string {
  return digestBytes(new TextEncoder().encode(canonicalJson({ identity, entries })))
}

const INSPECTED_PREVIEWS = new WeakSet<object>()

function derivedCapabilities(
  entries: readonly WorkspaceConfigEntry[],
): readonly WorkspaceConfigEntry['capabilities'][number][] {
  return Object.freeze([...new Set(entries.flatMap((entry) => entry.capabilities))])
}

function sameCapabilities(
  left: readonly WorkspaceConfigEntry['capabilities'][number][],
  right: readonly WorkspaceConfigEntry['capabilities'][number][],
): boolean {
  return left.length === right.length && left.every((capability) => right.includes(capability))
}

export async function inspectWorkspaceTrust(
  identity: WorkspaceIdentity,
  files: readonly WorkspaceInspectionFile[],
): Promise<WorkspaceTrustPreview> {
  let boundedIdentity: WorkspaceIdentity
  let boundedFiles: readonly WorkspaceInspectionFile[]
  try {
    boundedIdentity = cloneBoundedProfileValue(
      identity,
      WORKSPACE_INPUT_LIMITS,
    ) as WorkspaceIdentity
    boundedFiles = cloneBoundedProfileValue(
      files,
      WORKSPACE_INPUT_LIMITS,
    ) as readonly WorkspaceInspectionFile[]
  } catch {
    throw new Error('Workspace inspection input is oversized or not JSON data')
  }
  if (
    boundedIdentity === null ||
    typeof boundedIdentity !== 'object' ||
    Array.isArray(boundedIdentity) ||
    Object.keys(boundedIdentity).some((key) => key !== 'root' && key !== 'repositoryIdentity') ||
    typeof boundedIdentity.root !== 'string' ||
    boundedIdentity.root.length === 0 ||
    boundedIdentity.root.length > 4_096 ||
    containsControlCharacters(boundedIdentity.root) ||
    (boundedIdentity.repositoryIdentity !== undefined &&
      (typeof boundedIdentity.repositoryIdentity !== 'string' ||
        boundedIdentity.repositoryIdentity.length === 0 ||
        boundedIdentity.repositoryIdentity.length > 512 ||
        containsControlCharacters(boundedIdentity.repositoryIdentity)))
  ) {
    throw new Error('Workspace identity is invalid or oversized')
  }
  if (!Array.isArray(boundedFiles) || boundedFiles.length > MAX_INSPECTION_FILES) {
    throw new Error(`Workspace inspection has more than ${MAX_INSPECTION_FILES} files`)
  }
  const root = await openWorkspaceRoot(boundedIdentity.root)
  try {
    const entries: WorkspaceConfigEntry[] = []
    for (const file of boundedFiles) {
      const declaredCapabilities =
        file !== null && typeof file === 'object' && !Array.isArray(file)
          ? file.capabilities
          : undefined
      const fileKeys =
        file !== null && typeof file === 'object' && !Array.isArray(file) ? Object.keys(file) : []
      if (fileKeys.some((key) => key !== 'path' && key !== 'capabilities')) {
        throw new Error('Workspace inspection file has an unsupported field')
      }
      const capabilities = declaredCapabilities as WorkspaceConfigEntry['capabilities'] | undefined
      if (
        file === null ||
        typeof file !== 'object' ||
        Array.isArray(file) ||
        typeof file.path !== 'string' ||
        file.path.length === 0 ||
        file.path.length > 4_096 ||
        !Array.isArray(capabilities) ||
        capabilities.length > WORKSPACE_CAPABILITIES.size ||
        capabilities.some((capability) => !WORKSPACE_CAPABILITIES.has(capability)) ||
        new Set(capabilities).size !== capabilities.length
      ) {
        throw new Error('Workspace inspection file has an invalid bounded shape')
      }
      const contained = await containedWorkspacePath(root.root, file.path)
      const inspected = await readWorkspaceFile(root, file.path, MAX_WORKSPACE_CONFIG_BYTES)
      entries.push(
        Object.freeze({
          path: contained.relativePath,
          ...inspected,
          capabilities: Object.freeze([...capabilities]),
        }),
      )
    }
    const frozenEntries = Object.freeze(entries)
    const resolvedIdentity = Object.freeze({ ...boundedIdentity, root: root.root })
    const preview = Object.freeze({
      identity: resolvedIdentity,
      configurationDigest: digestPreview(resolvedIdentity, frozenEntries),
      entries: frozenEntries,
      capabilities: derivedCapabilities(frozenEntries),
    })
    INSPECTED_PREVIEWS.add(preview)
    return preview
  } finally {
    await closeWorkspaceRoot(root)
  }
}

/**
 * Approved workspace trust records.
 *
 * Trust is a record bound to an identity, a configuration digest, and the exact
 * capability set that was shown at approval time. Anything project-controlled
 * requires that record: a caller boolean or a missing store must fail closed,
 * because "no trust information available" is exactly the state an attacker
 * arranges.
 */
export class WorkspaceTrustStore {
  readonly #records = new Map<string, WorkspaceTrustRecord>()

  #key(identity: WorkspaceIdentity): string {
    return canonicalJson({
      root: identity.root,
      ...(identity.repositoryIdentity === undefined
        ? {}
        : { repositoryIdentity: identity.repositoryIdentity }),
    })
  }

  record(identity: WorkspaceIdentity): WorkspaceTrustRecord | undefined {
    return this.#records.get(this.#key(identity))
  }

  isTrusted(preview: WorkspaceTrustPreview): boolean {
    if (!this.#validPreview(preview)) return false
    const record = this.record(preview.identity)
    if (record === undefined) return false
    if (record.configurationDigest !== preview.configurationDigest) return false
    return preview.capabilities.every((capability) => record.capabilities.includes(capability))
  }

  approve(preview: WorkspaceTrustPreview, now: string): WorkspaceTrustRecord {
    this.#assertPreview(preview)
    if (typeof now !== 'string' || Number.isNaN(Date.parse(now))) {
      throw new Error('Workspace approval time must be an ISO timestamp')
    }
    const record = Object.freeze({
      identity: Object.freeze({ ...preview.identity }),
      configurationDigest: preview.configurationDigest,
      approvedAt: now,
      capabilities: Object.freeze([...preview.capabilities]),
    })
    this.#records.set(this.#key(preview.identity), record)
    return record
  }

  /** Reinspect authoritative files immediately before recording approval. */
  async approveAuthoritative(
    identity: WorkspaceIdentity,
    files: readonly WorkspaceInspectionFile[],
    now: string,
  ): Promise<WorkspaceTrustRecord> {
    return this.approve(await inspectWorkspaceTrust(identity, files), now)
  }

  revoke(identity: WorkspaceIdentity): void {
    this.#records.delete(this.#key(identity))
  }

  /** Return the verified record, or throw; never returns a caller assertion. */
  requireTrusted(
    preview: WorkspaceTrustPreview,
    requiredCapabilities: readonly WorkspaceConfigEntry['capabilities'][number][] = preview.capabilities,
  ): WorkspaceTrustRecord {
    this.#assertPreview(preview)
    const record = this.record(preview.identity)
    if (record === undefined) {
      throw new WorkspaceNotTrustedError(preview.identity, 'no approval record exists')
    }
    if (record.configurationDigest !== preview.configurationDigest) {
      throw new WorkspaceNotTrustedError(
        preview.identity,
        'the workspace configuration changed since it was approved',
      )
    }
    const missing = requiredCapabilities.filter(
      (capability) => !record.capabilities.includes(capability),
    )
    if (missing.length > 0) {
      throw new WorkspaceNotTrustedError(
        preview.identity,
        `these capabilities were never approved: ${missing.join(', ')}`,
      )
    }
    return record
  }

  #validPreview(preview: WorkspaceTrustPreview): boolean {
    try {
      this.#assertPreview(preview)
      return true
    } catch {
      return false
    }
  }

  #assertPreview(preview: WorkspaceTrustPreview): void {
    if (preview === null || typeof preview !== 'object' || !INSPECTED_PREVIEWS.has(preview)) {
      throw new WorkspaceNotTrustedError(
        preview?.identity ?? { root: '<unknown workspace>' },
        'the trust preview was not produced by authoritative inspection',
      )
    }
    if (preview.configurationDigest !== digestPreview(preview.identity, preview.entries)) {
      throw new WorkspaceNotTrustedError(preview.identity, 'the preview digest is invalid')
    }
    const derived = derivedCapabilities(preview.entries)
    if (!sameCapabilities(derived, preview.capabilities)) {
      throw new WorkspaceNotTrustedError(
        preview.identity,
        'the preview capability list does not match its files',
      )
    }
  }
}

/**
 * A verified trust decision, produced only by {@link verifyWorkspaceTrust}.
 * Discovery and admission accept this instead of a boolean, so there is no way to
 * assert trust without having presented a preview to a store.
 */
const VERIFIED_TRUST = Symbol('braid.verified-workspace-trust')
const VERIFIED_TRUST_OBJECTS = new WeakSet<object>()

export interface VerifiedWorkspaceTrust {
  readonly [VERIFIED_TRUST]: true
  readonly record: WorkspaceTrustRecord
  readonly preview: WorkspaceTrustPreview
}

export function isVerifiedWorkspaceTrust(value: unknown): value is VerifiedWorkspaceTrust {
  return value !== null && typeof value === 'object' && VERIFIED_TRUST_OBJECTS.has(value)
}

export function verifyWorkspaceTrust(
  store: WorkspaceTrustStore | undefined,
  preview: WorkspaceTrustPreview | undefined,
  requiredCapabilities: readonly WorkspaceConfigEntry['capabilities'][number][] = preview?.capabilities ??
    [],
): VerifiedWorkspaceTrust | undefined {
  if (preview === undefined) return undefined
  if (store === undefined) {
    throw new WorkspaceNotTrustedError(preview.identity, 'no trust store is configured')
  }
  const verified = Object.freeze({
    [VERIFIED_TRUST]: true as const,
    record: store.requireTrusted(preview, requiredCapabilities),
    preview,
  })
  VERIFIED_TRUST_OBJECTS.add(verified)
  return verified
}
