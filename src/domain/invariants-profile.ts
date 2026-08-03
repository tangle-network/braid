import { canonicalAgentProfileDigest, snapshotAgentProfile } from '@tangle-network/agent-interface'

import type {
  ConnectionRecord,
  CredentialReference,
  ProfileRecord,
  ProfileSnapshotRecord,
  WorkspaceRecord,
} from './entities.js'
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
    if (canonicalAgentProfileDigest(snapshot) !== digest) {
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
  const allowedOptions = new Set(['transport', 'endpoint', 'region', 'account', 'capabilityHints'])
  for (const [key, value] of Object.entries(record.providerOptions)) {
    if (!allowedOptions.has(key)) fail(`connection.providerOptions.${key} is provider-native state`)
    if (key === 'capabilityHints') {
      if (
        !Array.isArray(value) ||
        value.some((entry) => typeof entry !== 'string' || entry.length === 0)
      ) {
        fail('connection.providerOptions.capabilityHints must contain non-empty names')
      }
    } else if (typeof value !== 'string' || value.length === 0) {
      fail(`connection.providerOptions.${key} must be a non-empty string`)
    }
    if (key === 'endpoint' && typeof value === 'string')
      assertPublicReference(value, 'connection.providerOptions.endpoint')
  }
  assertDate(record.createdAt, 'connection.createdAt')
  assertDate(record.updatedAt, 'connection.updatedAt')
  if (record.credentialRef !== undefined)
    assertEntityId('credentialRef', record.credentialRef, 'connection.credentialRef')
}
