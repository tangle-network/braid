import { basename, resolve } from 'node:path'
import {
  canonicalCandidateDigest,
  type AgentProfile,
  type AgentProfileRef,
} from '@tangle-network/agent-interface'
import { redactSensitiveText } from '../domain/secret-sanitizer.js'
import { readProfileFile, ProfilePersistenceError } from './profile-persistence.js'
import {
  AGENT_INTERFACE_PACKAGE_VERSION,
  validateProfileShape,
  ProfileValidationError,
} from './profile-validation.js'
import type {
  ProfileDiscoveryInput,
  ProfileDiscoveryIssue,
  ProfileDiscoveryResult,
  ProfileIssue,
  ProfileRecord,
  ProfileSourceDescriptor,
  ProfileSourceResolution,
  ProfileSourceResolverContext,
  ProfileSourceSpec,
  ProfileSourceKind,
} from './profile-types.js'

function sourceLabel(spec: ProfileSourceSpec): string {
  if (spec.label !== undefined && spec.label.length > 0) return spec.label
  if (spec.kind === 'file') return basename(resolve(spec.path))
  return spec.reference
}

export function describeProfileSource(
  spec: ProfileSourceSpec,
  overrides: {
    readonly revision?: string
    readonly writable?: boolean
  } = {},
): ProfileSourceDescriptor {
  const revision = overrides.revision ?? spec.revision
  return {
    kind: spec.kind,
    reference: redactSensitiveText(
      spec.kind === 'file' ? resolve(spec.path) : spec.reference,
      2048,
    ),
    label: redactSensitiveText(sourceLabel(spec), 512),
    ...(revision === undefined ? {} : { revision: redactSensitiveText(revision, 512) }),
    writable: overrides.writable ?? spec.writable ?? spec.kind === 'file',
    trusted: spec.trusted ?? false,
  }
}

export function createProfileRecord(
  source: ProfileSourceDescriptor,
  profile: AgentProfile,
): ProfileRecord {
  const validated = validateProfileShape(profile)
  if (!validated.ok || validated.profile === undefined || validated.digest === undefined) {
    throw new ProfileValidationError(validated.issues)
  }
  const descriptor = Object.freeze({ ...source })
  const identity = canonicalCandidateDigest({ source: descriptor, profile: validated.digest })
  return Object.freeze({
    id: `profile-${identity.slice('sha256:'.length)}`,
    displayName: validated.profile.name ?? descriptor.label,
    source: descriptor,
    profile: validated.profile,
    digest: validated.digest,
    agentInterfacePackageVersion: AGENT_INTERFACE_PACKAGE_VERSION,
  })
}

export async function resolveProfileSource(
  spec: ProfileSourceSpec,
  context: ProfileSourceResolverContext = {},
): Promise<ProfileRecord> {
  if (spec.kind === 'inline') {
    return createProfileRecord(describeProfileSource(spec), spec.profile)
  }

  if (spec.kind === 'file') {
    const path = resolve(spec.path)
    const read = readProfileFile(path)
    if (spec.revision !== undefined && spec.revision !== read.bytesDigest) {
      throw new ProfilePersistenceError(
        'PROFILE_SOURCE_REVISION_MISMATCH',
        'The profile file revision does not match the requested immutable reference',
      )
    }
    return createProfileRecord(
      describeProfileSource(spec, { revision: read.bytesDigest }),
      read.imported.profile,
    )
  }

  const resolved = await spec.resolve(spec.reference, context)
  const profile = isProfileResolution(resolved) ? resolved.profile : resolved
  const revision = isProfileResolution(resolved) ? resolved.revision : undefined
  const writable = isProfileResolution(resolved) ? resolved.writable : undefined
  return createProfileRecord(
    describeProfileSource(spec, {
      ...(revision === undefined ? {} : { revision }),
      ...(writable === undefined ? {} : { writable }),
    }),
    profile,
  )
}

function isProfileResolution(
  value: AgentProfile | ProfileSourceResolution,
): value is ProfileSourceResolution {
  return value !== null && typeof value === 'object' && 'profile' in value
}

/** Resolve an inline AgentProfile or a provider/package catalog identifier. */
export async function resolveProfileReference(
  reference: AgentProfileRef,
  source: Omit<ProfileSourceDescriptor, 'kind'> & { readonly kind: ProfileSourceKind },
  resolver?: (
    reference: string,
    context: ProfileSourceResolverContext,
  ) => AgentProfile | ProfileSourceResolution | Promise<AgentProfile | ProfileSourceResolution>,
  context: ProfileSourceResolverContext = {},
): Promise<ProfileRecord> {
  if (typeof reference !== 'string') {
    return createProfileRecord(source, reference)
  }
  if (resolver === undefined) {
    throw new ProfilePersistenceError(
      'PROFILE_REFERENCE_UNRESOLVED',
      `No source adapter can resolve profile reference ${reference}`,
    )
  }
  const resolved = await resolver(reference, context)
  const profile = isProfileResolution(resolved) ? resolved.profile : resolved
  const revision = isProfileResolution(resolved) ? resolved.revision : source.revision
  const writable = isProfileResolution(resolved) ? resolved.writable : source.writable
  return createProfileRecord(
    {
      ...source,
      reference: redactSensitiveText(reference, 2048),
      ...(revision === undefined ? {} : { revision: redactSensitiveText(revision, 512) }),
      ...(writable === undefined ? {} : { writable }),
    },
    profile,
  )
}

function sourceIssue(spec: ProfileSourceSpec, error: unknown): ProfileDiscoveryIssue {
  let code = 'profile-source-failed'
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof ProfilePersistenceError) code = error.code
  if (error instanceof ProfileValidationError) code = 'profile-validation-failed'
  const issue: ProfileIssue = {
    origin: 'source',
    level: 'error',
    code: redactSensitiveText(code, 256),
    message: redactSensitiveText(message, 4096),
  }
  return { source: describeProfileSource(spec), issue }
}

function orderedSpecs(input: ProfileDiscoveryInput): readonly ProfileSourceSpec[] {
  return [
    ...(input.explicit ?? []),
    ...(input.workspaceTrusted === true ? (input.workspace ?? []) : []),
    ...(input.user ?? []),
    ...(input.provider ?? []),
    ...(input.recent ?? []),
  ]
}

/**
 * Discover only explicitly supplied source entries.
 *
 * There is intentionally no directory walk: a workspace or user config must
 * name each profile source before Braid reads it.
 */
export async function discoverProfiles(
  input: ProfileDiscoveryInput = {},
): Promise<ProfileDiscoveryResult> {
  const profiles: ProfileRecord[] = []
  const issues: ProfileDiscoveryIssue[] = []
  const seen = new Set<string>()
  for (const spec of orderedSpecs(input)) {
    try {
      const record = await resolveProfileSource(spec, input.resolverContext)
      const identity = `${record.source.kind}\u0000${record.source.reference}\u0000${record.digest}`
      if (seen.has(identity)) continue
      seen.add(identity)
      profiles.push(record)
    } catch (error) {
      issues.push(sourceIssue(spec, error))
    }
  }
  return { profiles, issues }
}

export function profileSourceKey(record: ProfileRecord): string {
  return `${record.source.kind}\u0000${record.source.reference}\u0000${record.digest}`
}
