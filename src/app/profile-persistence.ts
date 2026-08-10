import { extname, resolve } from 'node:path'
import type { AgentProfile } from '@tangle-network/agent-interface'
import {
  canonicalAgentProfileDigest,
  canonicalCandidateDigest,
  canonicalCandidateJson,
  sha256Bytes,
  snapshotAgentProfile,
} from '../adapters/agent-interface/profile-runtime.js'
import {
  readNoFollow,
  replacePrivateFile,
  SafeFileError,
} from '../adapters/persistence/safe-file.js'
import { redactStructuredValue } from '../domain/bounded-structured.js'
import { redactSensitiveText } from '../domain/secret-sanitizer.js'
import {
  type ExportProfileFileOptions,
  type ImportedProfileDocument,
  PROFILE_EXPORT_FORMAT,
  PROFILE_EXPORT_SCHEMA_VERSION,
  type ProfileExportDocument,
  type ProfileExportOptions,
  type ProfileFileState,
  type ProfileImportOptions,
  type SaveProfileFileOptions,
} from './profile-types.js'
import {
  AGENT_INTERFACE_PACKAGE_NAME,
  AGENT_INTERFACE_PACKAGE_VERSION,
  ProfileValidationError,
  validateProfileShape,
} from './profile-validation.js'

export const MAX_PROFILE_FILE_BYTES = 16 * 1024 * 1024

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertProfilePath(path: string): string {
  const target = resolve(path)
  const extension = extname(target).toLowerCase()
  if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(extension)) {
    throw new ProfilePersistenceError(
      'PROFILE_CODE_UNSUPPORTED',
      'Executable profile modules are not loaded by Braid',
    )
  }
  return target
}

function jsonError(error: unknown): ProfilePersistenceError {
  return new ProfilePersistenceError(
    'PROFILE_JSON_INVALID',
    error instanceof Error ? error.message : String(error),
  )
}

function digestText(value: string): string {
  return sha256Bytes(Buffer.from(value, 'utf8'))
}

function digestMatches(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value)
}

function redactExportValue(value: unknown, key?: string): unknown {
  if (key === 'attestationNonce') return '[redacted challenge]'
  if (key === 'metadata' || key === 'extensions') {
    return redactStructuredValue(value, undefined, { maxBytes: MAX_PROFILE_FILE_BYTES })
  }
  if (typeof value === 'string') return redactSensitiveText(value, MAX_PROFILE_FILE_BYTES)
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (Array.isArray(value)) return value.map((item) => redactExportValue(item))
  if (!isPlainRecord(value)) return '[unavailable]'
  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => [
      childKey,
      redactExportValue(child, childKey),
    ]),
  )
}

function profileForExport(
  profile: Readonly<AgentProfile>,
  redact: boolean,
): Readonly<AgentProfile> {
  if (!redact) return snapshotAgentProfile(profile)
  const candidate = redactExportValue(profile)
  const parsed = validateProfileShape(candidate)
  if (!parsed.ok || parsed.profile === undefined) {
    throw new ProfileValidationError(parsed.issues)
  }
  return parsed.profile
}

export function exportProfileDocument(
  profile: AgentProfile,
  options: ProfileExportOptions = {},
): ProfileExportDocument {
  const original = validateProfileShape(profile)
  if (!original.ok || original.profile === undefined) {
    throw new ProfileValidationError(original.issues)
  }
  const redacted = options.redact ?? true
  const exported = profileForExport(original.profile, redacted)
  const document: ProfileExportDocument = {
    format: PROFILE_EXPORT_FORMAT,
    schemaVersion: PROFILE_EXPORT_SCHEMA_VERSION,
    agentInterfacePackage: {
      name: AGENT_INTERFACE_PACKAGE_NAME,
      version: AGENT_INTERFACE_PACKAGE_VERSION,
    },
    sourceProfileDigest: canonicalAgentProfileDigest(original.profile),
    profileDigest: canonicalAgentProfileDigest(exported),
    redacted,
    profile: exported,
  }
  return Object.freeze(document)
}

export function exportProfileJson(
  profile: AgentProfile,
  options: ProfileExportOptions = {},
): string {
  const document = exportProfileDocument(profile, options)
  if (options.pretty === true) return `${JSON.stringify(document, null, 2)}\n`
  return canonicalCandidateJson(document)
}

function parseExportDocument(
  value: Record<string, unknown>,
  options: ProfileImportOptions,
): ImportedProfileDocument {
  if (value.format !== PROFILE_EXPORT_FORMAT) {
    throw new ProfilePersistenceError(
      'PROFILE_EXPORT_FORMAT_UNSUPPORTED',
      'Unknown profile export format',
    )
  }
  if (value.schemaVersion !== PROFILE_EXPORT_SCHEMA_VERSION) {
    throw new ProfilePersistenceError(
      'PROFILE_SCHEMA_VERSION_UNSUPPORTED',
      `Profile export schema ${String(value.schemaVersion)} cannot be preserved by this Braid version`,
    )
  }
  const redacted = value.redacted === true
  if (value.redacted !== true && value.redacted !== false) {
    throw new ProfilePersistenceError(
      'PROFILE_EXPORT_INVALID',
      'Profile export redaction flag is invalid',
    )
  }
  if (redacted && options.allowRedacted !== true) {
    throw new ProfilePersistenceError(
      'PROFILE_EXPORT_REDACTED',
      'A redacted profile export cannot be imported without explicit acknowledgement',
    )
  }
  if (!isPlainRecord(value.agentInterfacePackage)) {
    throw new ProfilePersistenceError(
      'PROFILE_EXPORT_INVALID',
      'Profile package metadata is missing',
    )
  }
  if (
    value.agentInterfacePackage.name !== AGENT_INTERFACE_PACKAGE_NAME ||
    typeof value.agentInterfacePackage.version !== 'string'
  ) {
    throw new ProfilePersistenceError(
      'PROFILE_EXPORT_INVALID',
      'Profile package metadata is invalid',
    )
  }
  if (!digestMatches(value.sourceProfileDigest) || !digestMatches(value.profileDigest)) {
    throw new ProfilePersistenceError(
      'PROFILE_EXPORT_INVALID',
      'Profile export digests are invalid',
    )
  }
  const parsed = validateProfileShape(value.profile)
  if (!parsed.ok || parsed.profile === undefined) {
    throw new ProfileValidationError(parsed.issues)
  }
  const digest = canonicalAgentProfileDigest(parsed.profile)
  if (digest !== value.profileDigest) {
    throw new ProfilePersistenceError(
      'PROFILE_EXPORT_DIGEST_MISMATCH',
      'Profile export digest does not match its bytes',
    )
  }
  return {
    profile: parsed.profile,
    digest,
    redacted,
    sourceProfileDigest: value.sourceProfileDigest,
    packageVersion: value.agentInterfacePackage.version,
  }
}

export function importProfileValue(
  value: unknown,
  options: ProfileImportOptions = {},
): ImportedProfileDocument {
  if (isPlainRecord(value) && 'format' in value) return parseExportDocument(value, options)
  const parsed = validateProfileShape(value)
  if (!parsed.ok || parsed.profile === undefined || parsed.digest === undefined) {
    throw new ProfileValidationError(parsed.issues)
  }
  return {
    profile: parsed.profile,
    digest: parsed.digest,
    redacted: false,
    packageVersion: AGENT_INTERFACE_PACKAGE_VERSION,
  }
}

export function importProfileJson(
  text: string,
  options: ProfileImportOptions = {},
): ImportedProfileDocument {
  if (Buffer.byteLength(text, 'utf8') > MAX_PROFILE_FILE_BYTES) {
    throw new ProfilePersistenceError('PROFILE_TOO_LARGE', 'Profile input exceeds the size limit')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw jsonError(error)
  }
  return importProfileValue(value, options)
}

export function readProfileFile(
  path: string,
  options: ProfileImportOptions = {},
): { readonly imported: ImportedProfileDocument; readonly bytesDigest: `sha256:${string}` } {
  const target = assertProfilePath(path)
  let bytes: Buffer | undefined
  try {
    bytes = readNoFollow(target, MAX_PROFILE_FILE_BYTES)
  } catch (error) {
    throw normalizeProfileFileError(error, target)
  }
  if (bytes === undefined) {
    throw new ProfilePersistenceError('PROFILE_NOT_FOUND', `Profile file does not exist: ${target}`)
  }
  const text = bytes.toString('utf8')
  return { imported: importProfileJson(text, options), bytesDigest: sha256Bytes(bytes) }
}

function normalizeProfileFileError(error: unknown, target: string): unknown {
  if (error instanceof SafeFileError && error.code === 'SAFE_FILE_NOT_REGULAR') {
    return new ProfilePersistenceError(
      'PROFILE_FILE_NOT_REGULAR',
      `Profile path is not a regular file: ${target}`,
    )
  }
  return error
}

function writeAtomic(
  path: string,
  bytes: Buffer,
  options: {
    readonly expectedBytesDigest?: `sha256:${string}`
    readonly expectedProfileDigest?: `sha256:${string}`
    readonly expectedBytesAbsent?: boolean
    readonly overwrite: boolean
    readonly verify: (bytes: Buffer) => void
    readonly onPhase?: SaveProfileFileOptions['onPhase']
  },
): void {
  const target = assertProfilePath(path)
  try {
    replacePrivateFile(target, bytes, {
      overwrite: options.overwrite,
      maxExistingBytes: MAX_PROFILE_FILE_BYTES,
      expected: (current) => {
        if (options.expectedBytesAbsent && current !== undefined) {
          throw new ProfilePersistenceError(
            'PROFILE_SOURCE_CHANGED',
            'Profile source appeared since it was opened',
          )
        }
        if (
          options.expectedBytesDigest !== undefined &&
          (current === undefined || sha256Bytes(current) !== options.expectedBytesDigest)
        ) {
          throw new ProfilePersistenceError(
            'PROFILE_SOURCE_CHANGED',
            'Profile source changed since it was opened',
          )
        }
        if (options.expectedProfileDigest !== undefined) {
          let imported: ImportedProfileDocument | undefined
          try {
            imported =
              current === undefined ? undefined : importProfileJson(current.toString('utf8'))
          } catch {
            imported = undefined
          }
          if (imported?.digest !== options.expectedProfileDigest) {
            throw new ProfilePersistenceError(
              'PROFILE_SOURCE_CHANGED',
              'Profile profile changed since it was opened',
            )
          }
        }
      },
      verify: options.verify,
      ...(options.onPhase === undefined ? {} : { onPhase: options.onPhase }),
    })
  } catch (error) {
    const normalized = normalizeProfileFileError(error, target)
    if (!options.overwrite && (normalized as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ProfilePersistenceError('PROFILE_EXISTS', `Profile file already exists: ${target}`)
    }
    throw normalized
  }
}

export function saveProfileFile(
  path: string,
  profile: AgentProfile,
  options: SaveProfileFileOptions = {},
): ProfileFileState {
  const validation = validateProfileShape(profile)
  if (!validation.ok || validation.profile === undefined || validation.digest === undefined) {
    throw new ProfileValidationError(validation.issues)
  }
  const bytes = Buffer.from(canonicalCandidateJson(validation.profile), 'utf8')
  writeAtomic(path, bytes, {
    ...(options.expectedBytesDigest === undefined
      ? {}
      : { expectedBytesDigest: options.expectedBytesDigest }),
    ...(options.expectedProfileDigest === undefined
      ? {}
      : { expectedProfileDigest: options.expectedProfileDigest }),
    ...(options.expectedBytesAbsent === undefined
      ? {}
      : { expectedBytesAbsent: options.expectedBytesAbsent }),
    overwrite: options.overwrite ?? true,
    verify: (written) => {
      const imported = importProfileJson(written.toString('utf8'))
      if (imported.redacted || imported.digest !== validation.digest) {
        throw new ProfilePersistenceError(
          'PROFILE_WRITE_VERIFY_FAILED',
          'Saved profile does not match the requested profile',
        )
      }
    },
    ...(options.onPhase === undefined ? {} : { onPhase: options.onPhase }),
  })
  const target = resolve(path)
  const read = readProfileFile(target)
  const source = Object.freeze({
    kind: 'file' as const,
    reference: target,
    label: options.sourceLabel ?? target,
    revision: read.bytesDigest,
    writable: true,
    trusted: options.trusted ?? false,
  })
  const identity = canonicalCandidateDigest({ source, profile: read.imported.digest })
  return {
    path: target,
    bytesDigest: read.bytesDigest,
    record: {
      id: `profile-${identity.slice('sha256:'.length)}`,
      displayName: read.imported.profile.name ?? 'Unnamed profile',
      source,
      profile: read.imported.profile,
      digest: read.imported.digest,
      agentInterfacePackageVersion: read.imported.packageVersion,
    },
  }
}

export function exportProfileFile(
  path: string,
  profile: AgentProfile,
  options: ExportProfileFileOptions = {},
): {
  readonly path: string
  readonly bytesDigest: `sha256:${string}`
  readonly document: ProfileExportDocument
} {
  const document = exportProfileDocument(profile, options)
  const text =
    options.pretty === true
      ? `${JSON.stringify(document, null, 2)}\n`
      : canonicalCandidateJson(document)
  const bytes = Buffer.from(text, 'utf8')
  writeAtomic(path, bytes, {
    ...(options.expectedBytesDigest === undefined
      ? {}
      : { expectedBytesDigest: options.expectedBytesDigest }),
    ...(options.expectedProfileDigest === undefined
      ? {}
      : { expectedProfileDigest: options.expectedProfileDigest }),
    overwrite: options.overwrite ?? false,
    verify: (written) => {
      const imported = importProfileJson(written.toString('utf8'), { allowRedacted: true })
      if (imported.digest !== document.profileDigest) {
        throw new ProfilePersistenceError(
          'PROFILE_WRITE_VERIFY_FAILED',
          'Exported profile digest does not match its bytes',
        )
      }
    },
  })
  const target = resolve(path)
  const written = readNoFollow(target, MAX_PROFILE_FILE_BYTES)
  if (written === undefined) {
    throw new ProfilePersistenceError(
      'PROFILE_WRITE_VERIFY_FAILED',
      'Exported profile file disappeared',
    )
  }
  return {
    path: target,
    bytesDigest: digestText(written.toString('utf8')) as `sha256:${string}`,
    document,
  }
}

export class ProfilePersistenceError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ProfilePersistenceError'
    this.code = code
  }
}
