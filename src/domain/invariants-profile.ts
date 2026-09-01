import {
  canonicalAgentProfileDigest,
  snapshotAgentProfile,
} from '../adapters/agent-interface/profile-runtime.js'

import type {
  ConnectionRecord,
  CredentialReference,
  ProfileRecord,
  ProfileSnapshotRecord,
  WorkspaceRecord,
} from './entities.js'
import {
  MAX_CONFIDENTIAL_ATTESTATION_MAX_AGE_SECONDS,
  MAX_RETAINED_IDLE_TTL_SECONDS,
  MIN_CONFIDENTIAL_ATTESTATION_MAX_AGE_SECONDS,
  MIN_RETAINED_IDLE_TTL_SECONDS,
} from './entities-core.js'
import {
  assertDate,
  assertDigest,
  assertEntityId,
  assertPublicReference,
  DomainInvariantError,
  fail,
  nonEmpty,
  objectValue,
} from './invariants-base.js'

export function assertWorkspaceRecord(record: WorkspaceRecord): void {
  assertEntityId('workspace', record.id, 'workspace.id')
  nonEmpty(record.root, 'workspace.root')
  if (record.trustDigest !== undefined) assertDigest(record.trustDigest, 'workspace.trustDigest')
  assertDate(record.createdAt, 'workspace.createdAt')
  assertDate(record.updatedAt, 'workspace.updatedAt')
}

export function assertProfileRecord(record: ProfileRecord): void {
  assertEntityId('profile', record.id, 'profile.id')
  assertCanonicalProfile(record.profile, record.digest, 'profile.profile')
  assertPublicReference(record.source.reference, 'profile.source.reference')
  assertDigest(record.digest, 'profile.digest')
  if (record.executionDigest !== undefined)
    assertDigest(record.executionDigest, 'profile.executionDigest')
  if (!Array.isArray(record.validation.issues)) fail('profile.validation.issues must be an array')
  assertDate(record.createdAt, 'profile.createdAt')
  assertDate(record.updatedAt, 'profile.updatedAt')
}

export function assertProfileSnapshotRecord(record: ProfileSnapshotRecord): void {
  assertEntityId('profileSnapshot', record.id, 'profileSnapshot.id')
  if (record.profileId !== undefined)
    assertEntityId('profile', record.profileId, 'profileSnapshot.profileId')
  assertCanonicalProfile(record.profile, record.digest, 'profileSnapshot.profile')
  assertPublicReference(record.source.reference, 'profileSnapshot.source.reference')
  assertDigest(record.digest, 'profileSnapshot.digest')
  assertDate(record.createdAt, 'profileSnapshot.createdAt')
}

export function assertCanonicalProfile(
  profile: ProfileRecord['profile'],
  digest: unknown,
  name: string,
): void {
  objectValue(profile, name)
  try {
    const snapshot = snapshotAgentProfile(profile)
    const canonicalDigest = canonicalAgentProfileDigest(snapshot)
    const bareDigest = canonicalDigest.startsWith('sha256:')
      ? canonicalDigest.slice('sha256:'.length)
      : canonicalDigest
    if (canonicalDigest !== digest && bareDigest !== digest) {
      fail(`${name} digest does not match the canonical AgentProfile`)
    }
  } catch (error) {
    if (error instanceof DomainInvariantError) throw error
    fail(`${name} is not a canonical AgentProfile`)
  }
}

export function assertCredentialReference(record: CredentialReference): void {
  assertEntityId('credentialRef', record.id, 'credentialReference.id')
  nonEmpty(record.label, 'credentialReference.label')
  nonEmpty(record.facility, 'credentialReference.facility')
  assertDate(record.createdAt, 'credentialReference.createdAt')
  assertDate(record.updatedAt, 'credentialReference.updatedAt')
}

export function assertConnectionRecord(record: ConnectionRecord): void {
  assertEntityId('connection', record.id, 'connection.id')
  if (record.workspaceId !== undefined)
    assertEntityId('workspace', record.workspaceId, 'connection.workspaceId')
  nonEmpty(record.name, 'connection.name')
  if (record.endpoint !== undefined) assertPublicReference(record.endpoint, 'connection.endpoint')
  const allowedOptions = new Set([
    'transport',
    'endpoint',
    'region',
    'account',
    'capabilityHints',
    'lifecycle',
    'idleTtlSeconds',
  ])
  for (const [key, value] of Object.entries(record.providerOptions)) {
    if (!allowedOptions.has(key)) fail(`connection.providerOptions.${key} is provider-native state`)
    if (key === 'capabilityHints') {
      if (
        !Array.isArray(value) ||
        value.some((entry) => typeof entry !== 'string' || entry.length === 0)
      ) {
        fail('connection.providerOptions.capabilityHints must contain non-empty names')
      }
    } else if (key === 'lifecycle') {
      if (value !== 'ephemeral' && value !== 'retained') {
        fail('connection.providerOptions.lifecycle is invalid')
      }
    } else if (key === 'idleTtlSeconds') {
      if (
        !Number.isSafeInteger(value) ||
        (value as number) < MIN_RETAINED_IDLE_TTL_SECONDS ||
        (value as number) > MAX_RETAINED_IDLE_TTL_SECONDS
      ) {
        fail(
          `connection.providerOptions.idleTtlSeconds must be an integer from ${MIN_RETAINED_IDLE_TTL_SECONDS} to ${MAX_RETAINED_IDLE_TTL_SECONDS}`,
        )
      }
    } else if (typeof value !== 'string' || value.length === 0) {
      fail(`connection.providerOptions.${key} must be a non-empty string`)
    }
    if (key === 'endpoint' && typeof value === 'string')
      assertPublicReference(value, 'connection.providerOptions.endpoint')
  }
  if (
    record.providerOptions.lifecycle === 'retained' &&
    record.providerOptions.idleTtlSeconds === undefined
  ) {
    fail('connection.providerOptions.lifecycle=retained requires idleTtlSeconds')
  }
  if (
    record.providerOptions.lifecycle !== 'retained' &&
    record.providerOptions.idleTtlSeconds !== undefined
  ) {
    fail('connection.providerOptions.idleTtlSeconds requires lifecycle=retained')
  }
  if (
    record.kind !== 'tangle-sandbox' &&
    (record.providerOptions.lifecycle !== undefined ||
      record.providerOptions.idleTtlSeconds !== undefined)
  ) {
    fail('connection.providerOptions lifecycle is available only for tangle-sandbox')
  }
  assertDate(record.createdAt, 'connection.createdAt')
  assertDate(record.updatedAt, 'connection.updatedAt')
  if (record.credentialRef !== undefined)
    assertEntityId('credentialRef', record.credentialRef, 'connection.credentialRef')
  if (record.confidentialAttestationPolicy !== undefined) {
    if (record.kind !== 'tangle-sandbox') {
      fail('connection.confidentialAttestationPolicy is available only for tangle-sandbox')
    }
    const policy = record.confidentialAttestationPolicy
    const keys = Object.keys(policy)
    if (
      keys.some(
        (key) =>
          key !== 'acceptedMeasurements' && key !== 'acceptedPolicyIds' && key !== 'maxAgeSeconds',
      )
    ) {
      fail('connection.confidentialAttestationPolicy contains an unsupported field')
    }
    if (
      !Array.isArray(policy.acceptedMeasurements) ||
      policy.acceptedMeasurements.length === 0 ||
      policy.acceptedMeasurements.length > 256 ||
      policy.acceptedMeasurements.some((measurement) => !/^sha256:[0-9a-f]{64}$/u.test(measurement))
    ) {
      fail(
        'connection.confidentialAttestationPolicy.acceptedMeasurements must contain one to 256 canonical SHA-256 digests',
      )
    }
    if (new Set(policy.acceptedMeasurements).size !== policy.acceptedMeasurements.length) {
      fail(
        'connection.confidentialAttestationPolicy.acceptedMeasurements must not contain duplicates',
      )
    }
    if (
      !Array.isArray(policy.acceptedPolicyIds) ||
      policy.acceptedPolicyIds.length === 0 ||
      policy.acceptedPolicyIds.length > 256 ||
      policy.acceptedPolicyIds.some((value) => !/^[A-Za-z][A-Za-z0-9._:-]{0,255}$/u.test(value))
    ) {
      fail(
        'connection.confidentialAttestationPolicy.acceptedPolicyIds must contain one to 256 canonical ids',
      )
    }
    if (new Set(policy.acceptedPolicyIds).size !== policy.acceptedPolicyIds.length) {
      fail('connection.confidentialAttestationPolicy.acceptedPolicyIds must not contain duplicates')
    }
    if (
      !Number.isSafeInteger(policy.maxAgeSeconds) ||
      policy.maxAgeSeconds < MIN_CONFIDENTIAL_ATTESTATION_MAX_AGE_SECONDS ||
      policy.maxAgeSeconds > MAX_CONFIDENTIAL_ATTESTATION_MAX_AGE_SECONDS
    ) {
      fail(
        `connection.confidentialAttestationPolicy.maxAgeSeconds must be an integer from ${MIN_CONFIDENTIAL_ATTESTATION_MAX_AGE_SECONDS} to ${MAX_CONFIDENTIAL_ATTESTATION_MAX_AGE_SECONDS}`,
      )
    }
  }
}
