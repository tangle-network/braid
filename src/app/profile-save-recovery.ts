import { resolve } from 'node:path'
import {
  type AgentProfile,
  canonicalCandidateJson,
  sha256Bytes,
} from '@tangle-network/agent-interface'
import { readNoFollow } from '../adapters/persistence/safe-file.js'
import type { Digest } from '../domain/ids.js'
import { redactSensitiveText } from '../domain/redaction.js'
import type { ActionHost } from './action-host.js'
import type { parseOperation } from './conversation-support.js'
import { AppError } from './errors.js'
import {
  acknowledgedProfileOperation,
  type ProfileSaveIntent,
  profileSaveOperationResult,
  toDomainProfile,
} from './profile-action-support.js'
import {
  importProfileJson,
  MAX_PROFILE_FILE_BYTES,
  ProfilePersistenceError,
  saveProfileFile,
} from './profile-persistence.js'
import { validateProfileShape } from './profile-validation.js'
import {
  createProfileRecord,
  type ProfileRecord,
  type ProfileSourceDescriptor,
  type ProfileSummary,
} from './profiles.js'

export interface ProfileSaveRecoveryResult {
  readonly profile: ProfileSummary
  readonly path: string
  readonly bytesDigest: string
  readonly revision: number
  readonly replayed: boolean
}

export interface ProfileSaveRecoveryRuntime {
  readonly host: ActionHost
  readonly now: () => string
  readonly summary: (record: ProfileRecord) => ProfileSummary
  readonly onPhase?: (
    phase:
      | 'temporary-written'
      | 'temporary-fsynced'
      | 'renamed'
      | 'directory-fsynced'
      | 'acknowledgment',
  ) => void
}

export interface ProfileSaveIntentInput {
  readonly path: string
  readonly profile: Readonly<AgentProfile>
  readonly summary: ProfileSummary
  readonly expectedBytesDigest?: string
  readonly expectedProfileDigest?: string
  readonly expectedMissing: boolean
  readonly sourceLabel: string
  readonly trusted: boolean
  readonly profileId?: string
  readonly select: boolean
}

export type ProfileSaveObservation =
  | { readonly status: 'missing' }
  | {
      readonly status: 'present'
      readonly bytesDigest: string
      readonly profileDigest: string
      readonly profile: Readonly<AgentProfile>
    }
  | { readonly status: 'conflict'; readonly detail: string }

export function createProfileSaveIntent(input: ProfileSaveIntentInput): ProfileSaveIntent {
  const validation = validateProfileShape(input.profile)
  if (!validation.ok || validation.profile === undefined || validation.digest === undefined) {
    throw new ProfilePersistenceError('PROFILE_INVALID', 'Profile save intent is invalid')
  }
  const bytes = Buffer.from(canonicalCandidateJson(validation.profile), 'utf8')
  return {
    kind: 'profile-save-intent',
    targetPath: resolve(input.path),
    ...(input.expectedBytesDigest === undefined
      ? {}
      : { expectedBytesDigest: input.expectedBytesDigest }),
    ...(input.expectedProfileDigest === undefined
      ? {}
      : { expectedProfileDigest: input.expectedProfileDigest }),
    expectedMissing: input.expectedMissing,
    intendedBytesDigest: sha256Bytes(bytes),
    intendedProfileDigest: validation.digest,
    summary: input.summary,
    sourceLabel: redactSensitiveText(input.sourceLabel, 512),
    trusted: input.trusted,
    ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
    select: input.select,
  }
}

export function observeProfileSaveTarget(intent: ProfileSaveIntent): ProfileSaveObservation {
  let bytes: Buffer | undefined
  try {
    bytes = readNoFollow(intent.targetPath, MAX_PROFILE_FILE_BYTES)
  } catch (error) {
    return {
      status: 'conflict',
      detail: error instanceof Error ? error.message : 'Profile target could not be inspected',
    }
  }
  if (bytes === undefined) {
    return intent.expectedMissing
      ? { status: 'missing' }
      : { status: 'conflict', detail: 'Profile target disappeared before recovery' }
  }
  const bytesDigest = sha256Bytes(bytes)
  let imported: ReturnType<typeof importProfileJson>
  try {
    imported = importProfileJson(bytes.toString('utf8'))
  } catch {
    return { status: 'conflict', detail: 'Profile target contains invalid profile data' }
  }
  return {
    status: 'present',
    bytesDigest,
    profileDigest: imported.digest,
    profile: imported.profile,
  }
}

export function classifyProfileSaveObservation(
  intent: ProfileSaveIntent,
  observation: ProfileSaveObservation,
): 'intended' | 'old' | 'conflict' {
  if (observation.status === 'conflict') return 'conflict'
  if (observation.status === 'missing') return intent.expectedMissing ? 'old' : 'conflict'
  if (
    observation.bytesDigest === intent.intendedBytesDigest &&
    observation.profileDigest === intent.intendedProfileDigest
  )
    return 'intended'
  if (
    !intent.expectedMissing &&
    observation.bytesDigest === intent.expectedBytesDigest &&
    (intent.expectedProfileDigest === undefined ||
      observation.profileDigest === intent.expectedProfileDigest)
  )
    return 'old'
  return 'conflict'
}

export function profileRecordFromSaveObservation(
  intent: ProfileSaveIntent,
  observation: Extract<ProfileSaveObservation, { readonly status: 'present' }>,
): ProfileRecord {
  const source: ProfileSourceDescriptor = {
    kind: 'file',
    reference: intent.targetPath,
    label: intent.sourceLabel,
    revision: observation.bytesDigest,
    writable: true,
    trusted: intent.trusted,
  }
  const record = createProfileRecord(source, observation.profile)
  return intent.profileId === undefined ? record : { ...record, id: intent.profileId }
}

export async function recoverPendingProfileSave(
  runtime: ProfileSaveRecoveryRuntime,
  input: { readonly profile: unknown },
  operationId: ReturnType<typeof parseOperation>,
  digest: Digest,
  intent: ProfileSaveIntent,
): Promise<ProfileSaveRecoveryResult> {
  const validation = validateProfileShape(input.profile)
  if (
    !validation.ok ||
    validation.profile === undefined ||
    validation.digest !== intent.intendedProfileDigest
  )
    throw new AppError('OPERATION_ID_CONFLICT', 'The retry profile does not match the saved intent')
  let observation = observeProfileSaveTarget(intent)
  const classification = classifyProfileSaveObservation(intent, observation)
  if (classification === 'conflict') {
    throw new AppError('PROFILE_SOURCE_CHANGED', observationDetail(observation))
  }
  if (classification === 'old') {
    saveProfileFileForRecovery(runtime, intent, validation.profile)
    observation = observeProfileSaveTarget(intent)
    if (observation.status !== 'present')
      throw new AppError('PROFILE_SOURCE_CHANGED', observationDetail(observation))
  }
  if (observation.status !== 'present')
    throw new AppError('PROFILE_SOURCE_CHANGED', observationDetail(observation))
  const record = profileRecordFromSaveObservation(intent, observation)
  return acknowledgeProfileSave(
    runtime,
    operationId,
    digest,
    intent,
    record,
    intent.targetPath,
    observation.bytesDigest,
    true,
  )
}

function saveProfileFileForRecovery(
  runtime: ProfileSaveRecoveryRuntime,
  intent: ProfileSaveIntent,
  profile: Readonly<AgentProfile>,
): void {
  saveProfileFile(intent.targetPath, profile, {
    overwrite: true,
    ...(intent.expectedBytesDigest === undefined
      ? {}
      : { expectedBytesDigest: intent.expectedBytesDigest as `sha256:${string}` }),
    ...(intent.expectedProfileDigest === undefined
      ? {}
      : { expectedProfileDigest: intent.expectedProfileDigest as `sha256:${string}` }),
    ...(intent.expectedMissing ? { expectedBytesAbsent: true } : {}),
    sourceLabel: intent.sourceLabel,
    trusted: intent.trusted,
    ...(runtime.onPhase === undefined ? {} : { onPhase: runtime.onPhase }),
  })
}

export async function acknowledgeProfileSave(
  runtime: ProfileSaveRecoveryRuntime,
  operationId: ReturnType<typeof parseOperation>,
  digest: Digest,
  intent: ProfileSaveIntent,
  record: ProfileRecord,
  path: string,
  bytesDigest: string,
  replayed: boolean,
): Promise<ProfileSaveRecoveryResult> {
  const next = await runtime.host.configuration.saveProfile({
    profile: toDomainProfile(
      record,
      runtime.now(),
      runtime.host.state().profiles.find((candidate) => candidate.id === record.id),
    ),
    operation: acknowledgedProfileOperation({
      id: operationId,
      digest,
      at: runtime.now(),
      result: {
        profileId: record.id,
        ...profileSaveOperationResult(runtime.summary(record), path, bytesDigest, intent),
      },
    }),
    select: intent.select,
  })
  if (intent.select) runtime.host.runtime?.setProfile(record.profile)
  return {
    profile: runtime.summary(record),
    path,
    bytesDigest,
    revision: next.revision,
    replayed,
  }
}

export async function handleProfileSaveFailure(
  runtime: ProfileSaveRecoveryRuntime,
  operationId: ReturnType<typeof parseOperation>,
  digest: Digest,
  intent: ProfileSaveIntent,
): Promise<void> {
  const observation = observeProfileSaveTarget(intent)
  if (classifyProfileSaveObservation(intent, observation) !== 'conflict') return
  try {
    await runtime.host.configuration.failOperation({
      id: operationId,
      kind: 'profile-save',
      requestDigest: digest,
      status: 'failed',
      failureCode: 'PROFILE_SOURCE_CHANGED',
      failureMessage: redactSensitiveText(observationDetail(observation), 2048),
      result: profileSaveOperationResult(
        intent.summary,
        intent.targetPath,
        intent.intendedBytesDigest,
        intent,
      ),
      createdAt: runtime.now(),
      updatedAt: runtime.now(),
    })
  } catch {
    // Leave the pending intent when the conflict record is not durable.
  }
}

function observationDetail(observation: ProfileSaveObservation): string {
  return observation.status === 'conflict'
    ? observation.detail
    : 'Profile save recovery found an unexpected target state'
}
