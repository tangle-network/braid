import { basename, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentProfile, AgentProfileSecurityPolicy } from '@tangle-network/agent-interface'
import { canonicalAgentProfileDigest } from '@tangle-network/agent-interface'
import {
  containsControlCharacters,
  redactErrorMessage,
  redactProviderText,
} from '../connection/redaction.js'
import { canonicalJson } from '../domain/canonical.js'
import { digestBytes, readFileIdentity } from './profile-files.js'
import {
  DuplicateProfileJsonKeyError,
  cloneBoundedProfileValue,
  freezeBoundedProfileValue,
  parseBoundedProfileJson,
  PROFILE_JSON_LIMITS,
  type ProfileJsonLimits,
} from './profile-json.js'
import {
  boundedProfileSecurityPolicy,
  type ProfileValidationReport,
  validateCanonicalProfile,
} from './profile-validation.js'

export type ProfileSourceKind =
  | 'inline'
  | 'local-file'
  | 'stdin'
  | 'configured'
  | 'provider-catalog'
  | 'github'

export interface ProfileSourceReference {
  readonly kind: ProfileSourceKind
  readonly value: string
  readonly label: string
  readonly revision?: string
  readonly writable: boolean
}

export interface ProfileResolveOptions {
  readonly securityPolicy?: AgentProfileSecurityPolicy
  readonly limits?: ProfileJsonLimits
}

/**
 * Why a document may be viewed but not saved.
 *
 * `unrecognized-fields` is the version-skew case: a profile written by a newer
 * schema must stay readable and exportable byte-for-byte, but Braid refuses to
 * re-serialize it, because doing so would silently drop the fields it does not
 * understand.
 */
export type ProfileSaveBlock = 'read-only-source' | 'unrecognized-fields'

export interface ProfileDocument {
  readonly source: ProfileSourceReference
  /** The complete bounded document, including fields this version cannot save. */
  readonly fullValue: unknown
  readonly profile: Readonly<AgentProfile>
  readonly rawJson: string
  readonly sourceDigest: string
  /** Identity captured with a local source read, for compare-and-swap saves. */
  readonly sourceIdentity?: import('./profile-files.js').FileIdentity
  readonly profileDigest: string
  readonly writable: boolean
  readonly saveBlock?: ProfileSaveBlock
  /** Canonical field names present in the raw bytes but unknown to this schema. */
  readonly unrecognizedFields: readonly string[]
  readonly securityPolicy?: AgentProfileSecurityPolicy
}

export interface ProfileSourceAdapter {
  readonly kind: ProfileSourceKind
  canResolve(reference: string): boolean
  resolve(reference: string, options?: ProfileResolveOptions): Promise<ProfileDocument>
}

export interface ResolvedProfileSource {
  readonly value: unknown
  readonly rawJson?: string
  readonly revision?: string
}

export interface ProfileReferenceLoader {
  readonly kind: Exclude<ProfileSourceKind, 'inline' | 'local-file' | 'stdin'>
  canResolve(reference: string): boolean
  resolve(reference: string): Promise<ResolvedProfileSource>
}

export interface ProfileParseResult {
  readonly rawJson: string
  readonly value?: unknown
  readonly unrecognizedFields: readonly string[]
  readonly validation: ProfileValidationReport
}

const PROFILE_SOURCE_KINDS: readonly ProfileSourceKind[] = Object.freeze([
  'inline',
  'local-file',
  'stdin',
  'configured',
  'provider-catalog',
  'github',
])

function normalizeProfileSource(
  source: ProfileSourceReference,
  limits: ProfileJsonLimits,
): ProfileSourceReference {
  let bounded: Record<string, unknown>
  try {
    const value = cloneBoundedProfileValue(source, limits)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('source must be an object')
    }
    bounded = value as Record<string, unknown>
  } catch {
    throw new Error('Profile source metadata is oversized or not JSON data')
  }
  const allowed = new Set(['kind', 'value', 'label', 'revision', 'writable'])
  if (Object.keys(bounded).some((key) => !allowed.has(key))) {
    throw new Error('Profile source metadata contains an unsupported field')
  }
  if (
    typeof bounded.kind !== 'string' ||
    !PROFILE_SOURCE_KINDS.includes(bounded.kind as ProfileSourceKind) ||
    typeof bounded.value !== 'string' ||
    typeof bounded.label !== 'string' ||
    typeof bounded.writable !== 'boolean' ||
    bounded.value.length === 0 ||
    bounded.value.length > 4_096 ||
    bounded.label.length === 0 ||
    bounded.label.length > 512 ||
    containsControlCharacters(bounded.value) ||
    containsControlCharacters(bounded.label) ||
    (bounded.revision !== undefined &&
      (typeof bounded.revision !== 'string' ||
        bounded.revision.length === 0 ||
        bounded.revision.length > 512 ||
        containsControlCharacters(bounded.revision)))
  ) {
    throw new Error('Profile source metadata is invalid or oversized')
  }
  return Object.freeze({
    kind: bounded.kind as ProfileSourceKind,
    value: bounded.value,
    label: bounded.label,
    ...(bounded.revision === undefined ? {} : { revision: bounded.revision }),
    writable: bounded.writable,
  })
}

function freezeSecurityPolicy(
  policy: AgentProfileSecurityPolicy | undefined,
  limits: ProfileJsonLimits,
): AgentProfileSecurityPolicy | undefined {
  if (policy === undefined) return undefined
  const bounded = boundedProfileSecurityPolicy(policy, limits)
  if (bounded === undefined) return undefined
  return Object.freeze({
    ...bounded,
    ...(bounded.allowedMcpHosts === undefined
      ? {}
      : {
          allowedMcpHosts: Object.freeze([...bounded.allowedMcpHosts]) as unknown as string[],
        }),
  })
}

/**
 * Top-level keys the installed schema does not know. Only root-level skew is
 * recoverable: a nested unknown key means the caller and the schema disagree
 * about a field Braid already owns, which is an invalid profile rather than a
 * newer one.
 */
function recoverableUnrecognizedFields(
  value: unknown,
  validation: ProfileValidationReport,
): readonly string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return Object.freeze([])
  if (validation.unrecognizedFields.length === 0) return Object.freeze([])
  if (validation.unrecognizedFields.length !== validation.issues.length) return Object.freeze([])
  const rootOnly = validation.unrecognizedFields.filter(
    (field) => !field.includes('.') && Object.hasOwn(value, field),
  )
  return rootOnly.length === validation.unrecognizedFields.length
    ? Object.freeze(rootOnly)
    : Object.freeze([])
}

export function parseCanonicalProfileJson(
  rawJson: string,
  options: ProfileResolveOptions = {},
): ProfileParseResult {
  let value: unknown
  try {
    value = parseBoundedProfileJson(rawJson, options.limits ?? PROFILE_JSON_LIMITS)
  } catch (error) {
    return Object.freeze({
      rawJson,
      unrecognizedFields: Object.freeze([]),
      validation: Object.freeze({
        ok: false,
        unrecognizedFields: Object.freeze([]),
        issues: Object.freeze([
          {
            level: 'error' as const,
            code:
              error instanceof DuplicateProfileJsonKeyError ? 'DUPLICATE_JSON_KEY' : 'INVALID_JSON',
            message: error instanceof Error ? error.message : String(error),
          },
        ]),
      }),
    })
  }
  const validation = validateCanonicalProfile(
    value,
    options.securityPolicy === undefined ? {} : { securityPolicy: options.securityPolicy },
  )
  return Object.freeze({
    rawJson,
    value,
    unrecognizedFields: recoverableUnrecognizedFields(value, validation),
    validation,
  })
}

/**
 * Import one profile document.
 *
 * A document whose only failure is an unrecognized top-level field is opened as
 * a read-only view of the known fields, preserving the original bytes and their
 * digest. Any other failure is an import error.
 */
export function profileDocumentFromJson(
  rawJson: string,
  source: ProfileSourceReference,
  options: ProfileResolveOptions = {},
): ProfileDocument {
  const limits = options.limits ?? PROFILE_JSON_LIMITS
  const normalizedSource = normalizeProfileSource(source, limits)
  const parsed = parseCanonicalProfileJson(rawJson, options)
  const securityPolicy = freezeSecurityPolicy(
    options.securityPolicy,
    options.limits ?? PROFILE_JSON_LIMITS,
  )
  const fullValue =
    parsed.value === undefined ? undefined : freezeBoundedProfileValue(parsed.value, limits)
  if (parsed.validation.ok && parsed.validation.profile !== undefined) {
    return Object.freeze({
      source: normalizedSource,
      fullValue,
      profile: parsed.validation.profile,
      rawJson,
      sourceDigest: digestBytes(new TextEncoder().encode(rawJson)),
      profileDigest: canonicalAgentProfileDigest(parsed.validation.profile),
      writable: normalizedSource.writable,
      ...(normalizedSource.writable ? {} : { saveBlock: 'read-only-source' as const }),
      unrecognizedFields: Object.freeze([]),
      ...(securityPolicy === undefined ? {} : { securityPolicy }),
    })
  }
  if (
    parsed.unrecognizedFields.length > 0 &&
    parsed.value !== null &&
    typeof parsed.value === 'object'
  ) {
    const known = Object.fromEntries(
      Object.entries(parsed.value as Record<string, unknown>).filter(
        ([key]) => !parsed.unrecognizedFields.includes(key),
      ),
    )
    const retained = validateCanonicalProfile(
      known,
      options.securityPolicy === undefined ? {} : { securityPolicy: options.securityPolicy },
    )
    if (retained.ok && retained.profile !== undefined) {
      return Object.freeze({
        source: normalizedSource,
        fullValue,
        profile: retained.profile,
        rawJson,
        sourceDigest: digestBytes(new TextEncoder().encode(rawJson)),
        profileDigest: canonicalAgentProfileDigest(retained.profile),
        writable: false,
        saveBlock: 'unrecognized-fields' as const,
        unrecognizedFields: parsed.unrecognizedFields,
        ...(securityPolicy === undefined ? {} : { securityPolicy }),
      })
    }
  }
  const detail = parsed.validation.issues
    .map((issue) => redactErrorMessage(`${issue.code}: ${issue.message}`))
    .join('; ')
  const label = redactProviderText(normalizedSource.label, 256) ?? 'profile source'
  throw new Error(`Cannot import profile ${label}${detail ? `: ${detail}` : ''}`)
}

async function readProfileFile(
  path: string,
  limits: ProfileJsonLimits,
): Promise<{
  readonly rawJson: string
  readonly sourceDigest: string
  readonly sourceIdentity: import('./profile-files.js').FileIdentity
}> {
  const read = await readFileIdentity(path, { maxBytes: limits.maxBytes })
  if (read === undefined) throw new Error(`Profile source does not exist: ${path}`)
  return Object.freeze({
    rawJson: decodeProfileBytes(read.bytes),
    sourceDigest: read.identity.digest,
    sourceIdentity: read.identity,
  })
}

function decodeProfileBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('Profile source is not valid UTF-8')
  }
}

export class LocalProfileSourceAdapter implements ProfileSourceAdapter {
  readonly kind = 'local-file' as const

  canResolve(reference: string): boolean {
    return (
      typeof reference === 'string' &&
      (reference.startsWith('file:') || reference.endsWith('.json') || isAbsolute(reference))
    )
  }

  async resolve(reference: string, options: ProfileResolveOptions = {}): Promise<ProfileDocument> {
    const path = reference.startsWith('file:') ? fileURLToPath(reference) : reference
    const absolutePath = resolve(path)
    const limits = options.limits ?? PROFILE_JSON_LIMITS
    const { rawJson, sourceDigest, sourceIdentity } = await readProfileFile(absolutePath, limits)
    const document = profileDocumentFromJson(
      rawJson,
      {
        kind: 'local-file',
        value: absolutePath,
        label: basename(absolutePath),
        writable: true,
      },
      options,
    )
    return Object.freeze({ ...document, sourceDigest, sourceIdentity })
  }
}

export class LoadedProfileSourceAdapter implements ProfileSourceAdapter {
  readonly kind: Exclude<ProfileSourceKind, 'inline' | 'local-file' | 'stdin'>
  readonly #loader: ProfileReferenceLoader

  constructor(loader: ProfileReferenceLoader) {
    this.kind = loader.kind
    this.#loader = loader
  }

  canResolve(reference: string): boolean {
    return typeof reference === 'string' && this.#loader.canResolve(reference)
  }

  async resolve(reference: string, options: ProfileResolveOptions = {}): Promise<ProfileDocument> {
    const loaded = await this.#loader.resolve(reference)
    // A loader that returns a parsed value gets canonical bytes, not
    // `JSON.stringify` ordering, so its digest matches the same profile read from
    // a file.
    const limits = options.limits ?? PROFILE_JSON_LIMITS
    const rawJson = loaded.rawJson ?? canonicalJson(cloneBoundedProfileValue(loaded.value, limits))
    return profileDocumentFromJson(
      rawJson,
      {
        kind: this.kind,
        value: reference,
        label: reference,
        ...(loaded.revision === undefined ? {} : { revision: loaded.revision }),
        writable: false,
      },
      options,
    )
  }
}

export class InlineProfileSourceAdapter implements ProfileSourceAdapter {
  readonly kind = 'inline' as const

  canResolve(reference: string): boolean {
    return typeof reference === 'string' && reference.startsWith('inline:')
  }

  async resolve(reference: string, options: ProfileResolveOptions = {}): Promise<ProfileDocument> {
    return profileDocumentFromJson(
      reference.slice('inline:'.length),
      {
        kind: 'inline',
        value: 'inline',
        label: 'inline profile',
        writable: false,
      },
      options,
    )
  }
}

export class ProfileSourceRegistry {
  readonly #adapters: readonly ProfileSourceAdapter[]

  constructor(
    adapters: readonly ProfileSourceAdapter[] = [
      new InlineProfileSourceAdapter(),
      new LocalProfileSourceAdapter(),
    ],
    loaders: readonly ProfileReferenceLoader[] = [],
  ) {
    this.#adapters = Object.freeze([
      ...adapters,
      ...loaders.map((loader) => new LoadedProfileSourceAdapter(loader)),
    ])
  }

  async resolve(reference: string, options: ProfileResolveOptions = {}): Promise<ProfileDocument> {
    if (typeof reference !== 'string' || reference.length === 0 || reference.length > 4_096) {
      throw new Error('Profile reference is empty or too long')
    }
    const adapter = this.#adapters.find((candidate) => candidate.canResolve(reference))
    if (!adapter) {
      throw new Error(
        `No safe profile source adapter accepts ${redactProviderText(reference, 256) ?? 'the reference'}`,
      )
    }
    return adapter.resolve(reference, options)
  }
}

export {
  discoverProfiles,
  type DiscoveredProfile,
  type ProfileDiscoveryInput,
} from './profile-discovery.js'

export async function importProfileText(
  rawJson: string,
  label = 'imported profile',
  options: ProfileResolveOptions = {},
): Promise<ProfileDocument> {
  return profileDocumentFromJson(
    rawJson,
    {
      kind: 'stdin',
      value: 'stdin',
      label,
      writable: false,
    },
    options,
  )
}
