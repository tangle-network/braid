import type { AgentProfile } from '@tangle-network/agent-interface'
import { canonicalAgentProfileDigestHex } from '../adapters/agent-interface/profile-runtime.js'
import { canonicalDigest } from '../domain/canonical.js'
import type { BranchRecord, ProfileSnapshotRecord } from '../domain/entities.js'
import type { BraidEvent } from '../domain/events.js'
import { type Digest, createProfileSnapshotId, parseProfileId } from '../domain/ids.js'
import { redactBraidEvent } from '../domain/redaction.js'
import type { BraidState } from '../domain/state.js'
import type { ForkDestinationProfile } from './conversation-types.js'
import { AppError } from './errors.js'

/**
 * Return the AgentProfile that a profile-changing fork bound to this branch.
 *
 * The branch's provider session was created from that profile, so every later
 * turn keeps it. A branch without a binding uses the selected profile.
 */
export function boundBranchProfile(
  state: Pick<BraidState, 'profileSnapshots'>,
  branch: Pick<BranchRecord, 'profileSnapshotId'>,
): Readonly<AgentProfile> | undefined {
  if (branch.profileSnapshotId === undefined) return undefined
  const snapshot = state.profileSnapshots.find(
    (candidate) => candidate.id === branch.profileSnapshotId,
  )
  if (snapshot === undefined)
    throw new AppError(
      'PROFILE_SNAPSHOT_UNAVAILABLE',
      'The profile bound to this branch is unavailable; fork again to choose a profile',
    )
  return snapshot.profile
}

/** Build the durable branch binding for one accepted profile-changing fork. */
export function forkProfileSnapshot(input: {
  readonly operationId: string
  readonly destination: ForkDestinationProfile
  readonly createdAt: string
}): ProfileSnapshotRecord {
  const digest = canonicalAgentProfileDigestHex(input.destination.profile) as Digest
  return {
    id: createProfileSnapshotId(
      `profile-snapshot-${canonicalDigest({ operationId: input.operationId, digest }).slice(0, 32)}`,
    ),
    profileId: parseProfileId(input.destination.profileId),
    source: input.destination.source,
    profile: input.destination.profile,
    digest,
    createdAt: input.createdAt,
  }
}

/**
 * True when the journal keeps this binding byte-for-byte.
 *
 * Every committed event passes the same redaction, so a profile that it would
 * change could not be replayed under its accepted digest.
 */
export function profileSnapshotRetained(snapshot: ProfileSnapshotRecord): boolean {
  const event: BraidEvent = { kind: 'profile.snapshot.created', snapshot }
  try {
    return canonicalDigest(redactBraidEvent(event)) === canonicalDigest(event)
  } catch {
    return false
  }
}
