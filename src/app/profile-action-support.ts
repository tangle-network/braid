import { canonicalAgentProfileDigest } from '../adapters/agent-interface/profile-runtime.js'
import type {
  ProfileRecord as DomainProfileRecord,
  ProfileSourceKind as DomainProfileSourceKind,
  OperationRecord,
} from '../domain/entities.js'
import type { JsonValue } from '../domain/entities-base.js'
import { type Digest, parseProfileId } from '../domain/ids.js'
import { redactProfile, redactSensitiveText } from '../domain/redaction.js'
import { acknowledgedOperation, type parseOperation } from './conversation-support.js'
import { AppError } from './errors.js'
import {
  describeProfileSource,
  type ProfileValidationReport,
  type ProfileRecord as SourceProfileRecord,
  summarizeProfile,
} from './profiles.js'

export type SafeProfileValidationReport = Omit<ProfileValidationReport, 'profile' | 'provider'> & {
  readonly provider?: Omit<NonNullable<ProfileValidationReport['provider']>, 'result'> & {
    readonly result: Omit<
      NonNullable<ProfileValidationReport['provider']>['result'],
      'normalizedProfile'
    >
  }
}

export interface ProfileSaveIntent {
  readonly kind: 'profile-save-intent'
  readonly targetPath: string
  readonly expectedBytesDigest?: string
  readonly expectedProfileDigest?: string
  readonly expectedMissing: boolean
  readonly intendedBytesDigest: string
  readonly intendedProfileDigest: string
  readonly summary: ReturnType<typeof safeProfileSummary>
  readonly sourceLabel: string
  readonly trusted: boolean
  readonly profileId?: string
  readonly select: boolean
}

export function findProfileRecord(
  records: readonly SourceProfileRecord[],
  ref: string,
): SourceProfileRecord | undefined {
  return records.find(
    (record) =>
      record.id === ref ||
      record.source.reference === ref ||
      record.source.label === ref ||
      record.displayName === ref,
  )
}

export function newProfileFileTarget(ref: string): SourceProfileRecord['source'] {
  if (!ref.includes('/') && !ref.endsWith('.json')) {
    throw new AppError('PROFILE_NOT_FOUND', 'A new profile must name a JSON file path')
  }
  return describeProfileSource({ kind: 'file', reference: ref, path: ref })
}

export function profileRevision(value: string | undefined): `sha256:${string}` | undefined {
  return value !== undefined && /^sha256:[0-9a-f]{64}$/u.test(value)
    ? (value as `sha256:${string}`)
    : undefined
}

export function toDomainProfile(
  record: SourceProfileRecord,
  now: string,
  previous?: DomainProfileRecord,
): DomainProfileRecord {
  const executionDigest = canonicalAgentProfileDigest(record.profile).slice(
    'sha256:'.length,
  ) as Digest
  const profile = redactProfile(record.profile)
  const digest = canonicalAgentProfileDigest(profile).slice('sha256:'.length) as Digest
  const sourceKind = toDomainSourceKind(record.source.kind)
  return {
    id: parseProfileId(record.id),
    source: {
      kind: sourceKind,
      reference: record.source.reference,
      ...(record.source.revision === undefined ? {} : { revision: record.source.revision }),
    },
    profile,
    digest,
    executionDigest,
    validation: { ok: true, issues: [] },
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  }
}

export function safeProfileSummary(record: SourceProfileRecord) {
  const summary = summarizeProfile(record)
  return {
    ...summary,
    name: redactSensitiveText(summary.name, 512),
    ...(summary.description === undefined
      ? {}
      : { description: redactSensitiveText(summary.description, 4096) }),
    source: {
      ...summary.source,
      reference: redactSensitiveText(summary.source.reference, 2048),
      label: redactSensitiveText(summary.source.label, 512),
    },
  }
}

export function profileSelectionOperationResult(
  profile: ReturnType<typeof safeProfileSummary>,
  reason: 'command-line' | 'branch' | 'workspace' | 'user' | 'first-run',
): NonNullable<OperationRecord['result']> {
  return jsonObject({ profile, reason })
}

export function profileSaveOperationResult(
  profile: ReturnType<typeof safeProfileSummary>,
  path: string,
  bytesDigest: string,
  intent?: ProfileSaveIntent,
): NonNullable<OperationRecord['result']> {
  return jsonObject({
    profile,
    path: redactSensitiveText(path, 2048),
    bytesDigest,
    ...(intent === undefined ? {} : { intent }),
  })
}

export function profileSelectionFromOperation(operation: OperationRecord):
  | {
      readonly profile: ReturnType<typeof safeProfileSummary>
      readonly reason: 'command-line' | 'branch' | 'workspace' | 'user' | 'first-run'
    }
  | undefined {
  const value = operation.result
  if (!isRecord(value) || !isProfileSummary(value.profile)) return undefined
  if (!isProfileSelectionReason(value.reason)) return undefined
  return {
    profile: value.profile as unknown as ReturnType<typeof safeProfileSummary>,
    reason: value.reason,
  }
}

export function profileSaveFromOperation(operation: OperationRecord):
  | {
      readonly profile: ReturnType<typeof safeProfileSummary>
      readonly path: string
      readonly bytesDigest: string
      readonly intent?: ProfileSaveIntent
    }
  | undefined {
  const value = operation.result
  if (
    !isRecord(value) ||
    !isProfileSummary(value.profile) ||
    typeof value.path !== 'string' ||
    typeof value.bytesDigest !== 'string'
  )
    return undefined
  const intent = profileSaveIntentFromOperation(operation)
  return {
    profile: value.profile as unknown as ReturnType<typeof safeProfileSummary>,
    path: value.path,
    bytesDigest: value.bytesDigest,
    ...(intent === undefined ? {} : { intent }),
  }
}

export function profileSaveIntentFromOperation(
  operation: OperationRecord,
): ProfileSaveIntent | undefined {
  if (!isRecord(operation.result) || !isRecord(operation.result.intent)) return undefined
  const value = operation.result.intent
  if (
    value.kind !== 'profile-save-intent' ||
    typeof value.targetPath !== 'string' ||
    typeof value.expectedMissing !== 'boolean' ||
    typeof value.intendedBytesDigest !== 'string' ||
    typeof value.intendedProfileDigest !== 'string' ||
    !isProfileSummary(value.summary) ||
    typeof value.sourceLabel !== 'string' ||
    typeof value.trusted !== 'boolean' ||
    typeof value.select !== 'boolean'
  )
    return undefined
  return value as unknown as ProfileSaveIntent
}

export function fromDomainProfile(record: DomainProfileRecord): SourceProfileRecord {
  const profile = record.profile
  const kind = record.source.kind === 'catalog' ? 'provider' : record.source.kind
  const source = {
    kind,
    reference: record.source.reference,
    label: record.source.reference,
    ...(record.source.revision === undefined ? {} : { revision: record.source.revision }),
    writable: kind === 'file',
    trusted: false,
  } as const
  return {
    id: record.id,
    displayName: profile.name ?? source.label,
    source,
    profile,
    digest: canonicalAgentProfileDigest(profile),
    agentInterfacePackageVersion: 'durable-state',
  }
}

function toDomainSourceKind(kind: SourceProfileRecord['source']['kind']): DomainProfileSourceKind {
  if (kind === 'inline' || kind === 'file' || kind === 'package' || kind === 'github') return kind
  return 'catalog'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isProfileSummary(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.digest === 'string' &&
    Array.isArray(value.tags) &&
    value.tags.every((item) => typeof item === 'string') &&
    isRecord(value.source) &&
    typeof value.source.reference === 'string' &&
    typeof value.source.label === 'string'
  )
}

function isProfileSelectionReason(
  value: unknown,
): value is 'command-line' | 'branch' | 'workspace' | 'user' | 'first-run' {
  return (
    value === 'command-line' ||
    value === 'branch' ||
    value === 'workspace' ||
    value === 'user' ||
    value === 'first-run'
  )
}

function jsonObject(value: Record<string, unknown>): NonNullable<OperationRecord['result']> {
  return value as Record<string, JsonValue>
}

export function safeValidationReport(report: ProfileValidationReport): SafeProfileValidationReport {
  const { profile: _profile, provider, ...safe } = report
  return {
    ...safe,
    ...(provider === undefined
      ? {}
      : {
          provider: {
            provider: provider.provider,
            ...(provider.capabilities === undefined ? {} : { capabilities: provider.capabilities }),
            result: { ok: provider.result.ok, issues: provider.result.issues },
          },
        }),
  }
}

export function invalidProfile(report: ProfileValidationReport): AppError {
  const detail = report.issues.map((issue) => `${issue.code}: ${issue.message}`).join('; ')
  return new AppError('PROFILE_INVALID', detail || 'Profile validation failed')
}

export function pendingProfileOperation(
  id: ReturnType<typeof parseOperation>,
  digest: Digest,
  at: string,
  intent?: ProfileSaveIntent,
): OperationRecord & { readonly kind: 'profile-save' } {
  return {
    id,
    kind: 'profile-save',
    requestDigest: digest,
    status: 'pending',
    ...(intent === undefined ? {} : { result: jsonObject({ intent }) }),
    createdAt: at,
    updatedAt: at,
  }
}

export function acknowledgedProfileOperation(input: {
  readonly id: ReturnType<typeof parseOperation>
  readonly digest: Digest
  readonly at: string
  readonly result?: OperationRecord['result']
}): OperationRecord & { readonly kind: 'profile-save' } {
  return acknowledgedOperation({ ...input, kind: 'profile-save' }) as OperationRecord & {
    readonly kind: 'profile-save'
  }
}

export function reconciliationRequired(operationId: string): AppError {
  return new AppError(
    'OPERATION_REQUIRES_RECONCILIATION',
    `Operation ${operationId} needs reconciliation before it can be retried`,
  )
}

export function profileErrorCode(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : 'PROFILE_SAVE_FAILED'
}

export function profileErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Profile save failed'
}
