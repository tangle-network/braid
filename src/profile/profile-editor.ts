import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentProfile, AgentProfileSecurityPolicy } from '@tangle-network/agent-interface'
import { snapshotAgentProfile } from '@tangle-network/agent-interface'
import {
  ConcurrentFileModificationError,
  type FileIdentity,
  readFileIdentity,
  replaceFileAtomically,
} from './profile-files.js'
import {
  cloneBoundedProfileValue,
  parseBoundedProfileJson,
  PROFILE_JSON_LIMITS,
  type ProfileJsonLimits,
} from './profile-json.js'
import {
  setAtProfilePointer,
  STRUCTURED_VIEW_LIMITS,
  type StructuredProfileEntry,
  type StructuredProfilePage,
  structuredProfilePage,
  type StructuredViewLimits,
} from './profile-pointer.js'
import { type ProfileSchemaIdentity, profileSchemaIdentity } from './profile-schema-identity.js'
import {
  parseCanonicalProfileJson,
  type ProfileDocument,
  profileDocumentFromJson,
  type ProfileSaveBlock,
} from './profile-sources.js'
import {
  boundedProfileSecurityPolicy,
  type ProfileValidationReport,
  validateCanonicalProfile,
} from './profile-validation.js'
import { withFileLock } from '../persistence/file-lock.js'

export type { StructuredProfileEntry, StructuredProfilePage }

export interface ProfileEditorDraft {
  readonly source: ProfileDocument['source']
  readonly baselineSourceDigest: string
  /** Device/inode/size/digest of the file this draft was opened from, if any. */
  readonly baselineIdentity?: FileIdentity
  readonly rawJson: string
  readonly profile: Readonly<AgentProfile> | undefined
  readonly saveBlock?: ProfileSaveBlock
  readonly unrecognizedFields: readonly string[]
  readonly securityPolicy?: AgentProfileSecurityPolicy
  readonly limits: ProfileJsonLimits
  readonly validation: ProfileValidationReport
}

export interface StructuredProfileView extends StructuredProfilePage {
  readonly profile: Readonly<AgentProfile>
}

export function openProfileEditor(
  document: ProfileDocument,
  options: {
    readonly securityPolicy?: AgentProfileSecurityPolicy
    readonly limits?: ProfileJsonLimits
    readonly baselineIdentity?: FileIdentity
  } = {},
): ProfileEditorDraft {
  const limits = options.limits ?? PROFILE_JSON_LIMITS
  const securityPolicy = boundedProfileSecurityPolicy(
    options.securityPolicy ?? document.securityPolicy,
    limits,
  )
  const validation = validateCanonicalProfile(
    document.profile,
    securityPolicy === undefined ? {} : { securityPolicy },
  )
  return Object.freeze({
    source: document.source,
    baselineSourceDigest: document.sourceDigest,
    ...(options.baselineIdentity === undefined && document.sourceIdentity === undefined
      ? {}
      : { baselineIdentity: options.baselineIdentity ?? document.sourceIdentity }),
    rawJson: document.rawJson,
    profile: document.profile,
    ...(document.saveBlock === undefined ? {} : { saveBlock: document.saveBlock }),
    unrecognizedFields: document.unrecognizedFields,
    ...(securityPolicy === undefined ? {} : { securityPolicy }),
    limits,
    validation,
  })
}

/**
 * Editing routes through the same bounded parser as import, so a paste of
 * duplicate-key or oversized JSON cannot enter a draft that later gets saved.
 */
export function editRawProfile(draft: ProfileEditorDraft, rawJson: string): ProfileEditorDraft {
  const validation = parseCanonicalProfileJson(rawJson, {
    ...(draft.securityPolicy === undefined ? {} : { securityPolicy: draft.securityPolicy }),
    limits: draft.limits,
  }).validation
  return Object.freeze({
    ...draft,
    rawJson,
    ...(validation.profile === undefined
      ? { profile: undefined }
      : { profile: validation.profile }),
    unrecognizedFields: validation.unrecognizedFields,
    validation,
  })
}

export function editStructuredProfile(
  draft: ProfileEditorDraft,
  path: string,
  value: unknown,
): ProfileEditorDraft {
  if (draft.profile === undefined) {
    throw new Error('Structured editing requires valid raw profile JSON')
  }
  const boundedValue = cloneBoundedProfileValue(value, draft.limits)
  const nextValue = setAtProfilePointer(draft.profile, path, boundedValue, structuredLimits(draft))
  return editRawProfile(draft, JSON.stringify(nextValue, null, 2))
}

function structuredLimits(draft: ProfileEditorDraft): StructuredViewLimits {
  return Object.freeze({
    ...STRUCTURED_VIEW_LIMITS,
    maxDepth: Math.min(STRUCTURED_VIEW_LIMITS.maxDepth, draft.limits.maxDepth),
    maxStringLength: Math.min(STRUCTURED_VIEW_LIMITS.maxStringLength, draft.limits.maxStringLength),
  })
}

export function buildStructuredProfileView(
  draft: ProfileEditorDraft,
  options: { readonly offset?: number; readonly limit?: number } = {},
): StructuredProfileView {
  if (draft.profile === undefined) {
    throw new Error('Cannot build a structured view for invalid profile JSON')
  }
  const page = structuredProfilePage(draft.profile, {
    ...(options.offset === undefined ? {} : { offset: options.offset }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    limits: structuredLimits(draft),
  })
  return Object.freeze({ profile: draft.profile, ...page })
}

export interface AtomicProfileSaveResult {
  readonly path: string
  readonly profile: Readonly<AgentProfile>
  readonly profileDigest: string
  readonly bytes: number
  readonly identity: FileIdentity
}

export { ConcurrentFileModificationError as ConcurrentProfileModificationError }

function draftBytes(rawJson: string): Uint8Array {
  return new TextEncoder().encode(rawJson.endsWith('\n') ? rawJson : `${rawJson}\n`)
}

/**
 * Save a draft with a compare-and-swap against the exact file it was opened from.
 *
 * The baseline is device/inode/size/digest, not the digest alone: another writer
 * that replaces the target with a different regular file of the same length would
 * otherwise be overwritten silently.
 */
export async function saveProfileAtomically(
  path: string,
  draft: ProfileEditorDraft,
  options: { readonly allowReadOnlySource?: boolean } = {},
): Promise<AtomicProfileSaveResult> {
  if (draft.profile === undefined || !draft.validation.ok) {
    throw new Error('Cannot save an invalid profile draft')
  }
  if (draft.saveBlock === 'unrecognized-fields') {
    throw new Error(
      `Cannot save a profile with fields this schema does not recognize: ${draft.unrecognizedFields.join(', ')}`,
    )
  }
  if (!draft.source.writable && !options.allowReadOnlySource) {
    throw new Error('This profile source is read-only; save it as a new local profile')
  }
  const draftValidation = parseCanonicalProfileJson(draft.rawJson, {
    ...(draft.securityPolicy === undefined ? {} : { securityPolicy: draft.securityPolicy }),
    limits: draft.limits,
  }).validation
  if (!draftValidation.ok || draftValidation.digest !== draft.validation.digest) {
    throw new Error('The profile draft JSON no longer matches its validated profile')
  }

  const target = resolve(path)
  if (draft.source.writable && draft.source.kind === 'local-file') {
    const sourcePath = localSourcePath(draft.source.value)
    if (sourcePath !== target) {
      throw new ConcurrentFileModificationError(
        target,
        `the draft belongs to ${sourcePath}; save it to that source or export explicitly`,
      )
    }
    if (draft.baselineIdentity === undefined) {
      throw new ConcurrentFileModificationError(
        target,
        'the local source identity was not captured; reopen it through the local source adapter',
      )
    }
  }
  return withFileLock(target, async () => {
    const current = await readFileIdentity(target, { maxBytes: draft.limits.maxBytes })
    if (!draft.source.writable && current !== undefined) {
      throw new ConcurrentFileModificationError(
        target,
        'a read-only profile can only be saved as a new local file',
      )
    }
    const expected = expectedIdentity(target, draft, current?.identity)
    const bytes = draftBytes(draft.rawJson)

    await replaceFileAtomically({ path: target, bytes, mode: 0o600, expected })

    const written = await readFileIdentity(target, { maxBytes: draft.limits.maxBytes })
    if (written === undefined)
      throw new ConcurrentFileModificationError(target, 'the save vanished')
    const writtenDocument = profileDocumentFromJson(
      new TextDecoder().decode(written.bytes),
      { kind: 'local-file', value: target, label: basename(target), writable: true },
      {
        ...(draft.securityPolicy === undefined ? {} : { securityPolicy: draft.securityPolicy }),
        limits: draft.limits,
      },
    )
    if (writtenDocument.profileDigest !== draft.validation.digest) {
      throw new Error('Written profile digest did not match the validated draft')
    }
    return Object.freeze({
      path: target,
      profile: snapshotAgentProfile(writtenDocument.profile),
      profileDigest: writtenDocument.profileDigest,
      bytes: bytes.byteLength,
      identity: written.identity,
    })
  })
}

function localSourcePath(value: string): string {
  try {
    return resolve(value.startsWith('file:') ? fileURLToPath(value) : value)
  } catch {
    throw new Error('The local profile source reference is not a valid file path')
  }
}

function expectedIdentity(
  target: string,
  draft: ProfileEditorDraft,
  current: FileIdentity | undefined,
): FileIdentity | undefined {
  if (current === undefined) {
    if (draft.source.writable) {
      throw new ConcurrentFileModificationError(target, 'the source file no longer exists')
    }
    return undefined
  }
  if (current.digest !== draft.baselineSourceDigest) {
    throw new ConcurrentFileModificationError(target, 'the source bytes changed')
  }
  const baseline = draft.baselineIdentity
  if (
    baseline !== undefined &&
    (baseline.device !== current.device || baseline.inode !== current.inode)
  ) {
    throw new ConcurrentFileModificationError(target, 'the source file was replaced')
  }
  return current
}

export interface ProfileExport {
  readonly json: string
  readonly digest: string
  readonly schema: ProfileSchemaIdentity
}

export async function exportProfileAtomically(
  path: string,
  profile: AgentProfile,
  options: { readonly pretty?: boolean; readonly overwrite?: boolean } = {},
): Promise<{ readonly path: string; readonly digest: string; readonly bytes: number }> {
  const exported = exportProfile(profile, options)
  const target = resolve(path)
  return withFileLock(target, async () => {
    const bytes = draftBytes(exported.json)
    const current = await readFileIdentity(target)
    if (current !== undefined && options.overwrite !== true) {
      throw new Error(`Refusing to overwrite an existing export target: ${target}`)
    }
    await replaceFileAtomically({
      path: target,
      bytes,
      mode: 0o600,
      expected: current?.identity,
    })
    const written = await readFileIdentity(target)
    if (written === undefined) throw new Error(`Export vanished after writing: ${target}`)
    let rewrittenValue: unknown
    try {
      rewrittenValue = parseBoundedProfileJson(new TextDecoder().decode(written.bytes))
    } catch (error) {
      throw new Error(
        `Written export was not bounded JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const rewrittenValidation = validateCanonicalProfile(rewrittenValue, {
      securityPolicy: { allowLocalMcp: true, allowHooks: true },
    })
    if (!rewrittenValidation.ok || rewrittenValidation.profile === undefined) {
      throw new Error('Written export did not contain a valid profile')
    }
    const rewritten = exportProfile(rewrittenValidation.profile, options)
    if (rewritten.digest !== exported.digest) {
      throw new Error('Written export digest did not match the validated profile')
    }
    return Object.freeze({ path: target, digest: exported.digest, bytes: bytes.byteLength })
  })
}

/**
 * Export a validated profile with the identity of the schema that produced its
 * digest. Without the resolved version an export consumer cannot tell which
 * installed schema a digest belongs to.
 */
export function exportProfile(
  profile: AgentProfile,
  options: { readonly pretty?: boolean } = {},
): ProfileExport {
  const validation = validateCanonicalProfile(profile, {
    securityPolicy: { allowLocalMcp: true, allowHooks: true },
  })
  if (!validation.ok || validation.profile === undefined || validation.digest === undefined) {
    throw new Error('Cannot export an invalid profile')
  }
  return Object.freeze({
    json:
      options.pretty === true
        ? JSON.stringify(validation.profile, null, 2)
        : (validation.canonicalJson ?? JSON.stringify(validation.profile)),
    digest: validation.digest,
    schema: profileSchemaIdentity(),
  })
}
