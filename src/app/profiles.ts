import { ProfileDraft } from './profile-draft.js'
import { profileModelSettings } from './profile-model-settings.js'
import {
  exportProfileDocument,
  exportProfileFile,
  exportProfileJson,
  importProfileJson,
  importProfileValue,
  ProfilePersistenceError,
  readProfileFile,
  saveProfileFile,
} from './profile-persistence.js'
import { resolveEffectiveProfile, selectBaseProfile } from './profile-selection.js'
import { createProfileSnapshot } from './profile-snapshots.js'
import {
  createProfileRecord,
  describeProfileSource,
  discoverProfiles,
  profileSourceKey,
  resolveProfileReference,
  resolveProfileSource,
} from './profile-sources.js'
import type {
  EffectiveProfileInput,
  EffectiveProfileResult,
  ExportProfileFileOptions,
  ProfileDiscoveryInput,
  ProfileDiscoveryResult,
  ProfileExportDocument,
  ProfileExportOptions,
  ProfileFileState,
  ProfileImportOptions,
  ProfileRecord,
  ProfileSelectionCandidates,
  ProfileSelectionResult,
  ProfileSnapshotInput,
  ProfileSnapshotReceipt,
  ProfileSourceDescriptor,
  ProfileSourceSpec,
  ProfileValidationOptions,
  ProfileValidationReport,
  SaveProfileFileOptions,
} from './profile-types.js'
import {
  assertValidProfile,
  ProfileValidationError,
  validateProfile,
  validateProfileShape,
} from './profile-validation.js'

export * from './profile-draft.js'
export * from './profile-persistence.js'
export * from './profile-selection.js'
export * from './profile-snapshots.js'
export * from './profile-sources.js'
export * from './profile-types.js'
export * from './profile-validation.js'

export {
  assertValidProfile,
  createProfileRecord,
  createProfileSnapshot,
  describeProfileSource,
  discoverProfiles,
  exportProfileDocument,
  exportProfileFile,
  exportProfileJson,
  importProfileJson,
  importProfileValue,
  ProfileDraft,
  ProfilePersistenceError,
  ProfileValidationError,
  readProfileFile,
  resolveEffectiveProfile,
  resolveProfileReference,
  resolveProfileSource,
  saveProfileFile,
  selectBaseProfile,
  validateProfile,
  validateProfileShape,
}

export interface ProfileSummary {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly version?: string
  readonly tags: readonly string[]
  readonly source: ProfileSourceDescriptor
  readonly digest: string
  readonly runner?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly maxVisibleOutputTokens?: number
  readonly maxReasoningTokens?: number
  readonly maxTotalOutputTokens?: number
  readonly tools: readonly string[]
  readonly skills: readonly string[]
  readonly connections: readonly string[]
  readonly validation?: ProfileValidationReport
  readonly lastUsedRunner?: string
}

export interface ProfileSummaryOptions {
  readonly validation?: ProfileValidationReport
  readonly lastUsedRunner?: string
}

export function summarizeProfile(
  record: ProfileRecord,
  options: ProfileSummaryOptions = {},
): ProfileSummary {
  const profile = record.profile
  const modelSettings = profileModelSettings(profile)
  return Object.freeze({
    id: record.id,
    name: profile.name ?? record.displayName,
    ...(profile.description === undefined ? {} : { description: profile.description }),
    ...(profile.version === undefined ? {} : { version: profile.version }),
    tags: [...(profile.tags ?? [])],
    source: record.source,
    digest: record.digest,
    ...(profile.harness === undefined ? {} : { runner: profile.harness }),
    ...(profile.model?.default === undefined ? {} : { model: profile.model.default }),
    ...modelSettings,
    tools: Object.keys(profile.tools ?? {}).sort(),
    skills: (profile.resources?.skills ?? [])
      .map((resource) => (resource.kind === 'github' ? resource.path : resource.name))
      .filter((name) => name.length > 0),
    connections: (profile.connections ?? []).map((connection) => connection.connectionId),
    ...(options.validation === undefined ? {} : { validation: options.validation }),
    ...(options.lastUsedRunner === undefined ? {} : { lastUsedRunner: options.lastUsedRunner }),
  })
}

function searchableProfileText(record: ProfileRecord): string {
  const profile = record.profile
  const resourceNames = [
    ...(profile.resources?.skills ?? []),
    ...(profile.resources?.tools ?? []),
    ...(profile.resources?.agents ?? []),
    ...(profile.resources?.commands ?? []),
  ].flatMap((resource) => [
    resource.name,
    resource.kind === 'github' ? resource.path : undefined,
    resource.kind,
  ])
  return [
    profile.name,
    profile.description,
    profile.version,
    ...(profile.tags ?? []),
    record.source.label,
    record.source.reference,
    profile.harness,
    profile.model?.default,
    profile.model?.small,
    profile.model?.provider,
    ...Object.keys(profile.tools ?? {}),
    ...Object.keys(profile.mcp ?? {}),
    ...(profile.connections ?? []).flatMap((connection) => [
      connection.connectionId,
      ...(connection.capabilities ?? []),
      connection.alias,
    ]),
    ...resourceNames,
  ]
    .filter((value): value is string => value !== undefined)
    .join('\u0000')
    .toLocaleLowerCase()
}

export function searchProfiles(
  records: readonly ProfileRecord[],
  query: string,
): readonly ProfileRecord[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (normalized.length === 0) return [...records]
  return records.filter((record) => searchableProfileText(record).includes(normalized))
}

export function importProfileSource(
  value: unknown,
  source: ProfileSourceDescriptor,
  options: ProfileImportOptions = {},
): ProfileRecord {
  const imported = importProfileValue(value, options)
  return createProfileRecord(
    {
      ...source,
      ...(source.revision === undefined ? {} : { revision: source.revision }),
    },
    imported.profile,
  )
}

export interface ProfileCatalogOptions {
  readonly profiles?: readonly ProfileRecord[]
}

/** A small immutable-record catalog; source resolution and validation stay outside it. */
export class ProfileCatalog {
  #profiles: readonly ProfileRecord[]

  constructor(options: ProfileCatalogOptions = {}) {
    this.#profiles = [...(options.profiles ?? [])]
  }

  get size(): number {
    return this.#profiles.length
  }

  list(query = ''): readonly ProfileRecord[] {
    return searchProfiles(this.#profiles, query)
  }

  get(id: string): ProfileRecord | undefined {
    return this.#profiles.find((profile) => profile.id === id)
  }

  add(record: ProfileRecord): readonly ProfileRecord[] {
    if (
      this.#profiles.some((existing) => profileSourceKey(existing) === profileSourceKey(record))
    ) {
      return this.#profiles
    }
    this.#profiles = [...this.#profiles, record]
    return this.#profiles
  }

  replace(records: readonly ProfileRecord[]): readonly ProfileRecord[] {
    this.#profiles = [...records]
    return this.#profiles
  }

  select(candidates: ProfileSelectionCandidates): ProfileSelectionResult | undefined {
    return selectBaseProfile(candidates)
  }
}

export type {
  EffectiveProfileInput,
  EffectiveProfileResult,
  ExportProfileFileOptions,
  ProfileDiscoveryInput,
  ProfileDiscoveryResult,
  ProfileExportDocument,
  ProfileExportOptions,
  ProfileFileState,
  ProfileImportOptions,
  ProfileRecord,
  ProfileSelectionCandidates,
  ProfileSelectionResult,
  ProfileSnapshotInput,
  ProfileSnapshotReceipt,
  ProfileSourceDescriptor,
  ProfileSourceSpec,
  ProfileValidationOptions,
  ProfileValidationReport,
  SaveProfileFileOptions,
}
