import type { AgentProfile } from '@tangle-network/agent-interface'
import {
  canonicalAgentProfileDigestHex,
  snapshotAgentProfile,
} from '../adapters/agent-interface/profile-runtime.js'
import { canonicalDigest } from '../domain/canonical.js'
import type { ConnectionRecord } from '../domain/entities.js'
import type { ConnectionId, ProfileId } from '../domain/ids.js'
import { createDigest } from '../domain/ids.js'
import type { BraidState } from '../domain/state.js'
import type { AnalysisExecutionTarget } from './analysis-types.js'

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}

function snapshotConnection(
  connection: ConnectionRecord | undefined,
): ConnectionRecord | undefined {
  return connection === undefined ? undefined : freezeDeep(structuredClone(connection))
}

export function snapshotAnalysisExecutionTarget(input: {
  readonly profile: Readonly<AgentProfile>
  readonly profileId?: ProfileId
  readonly connection?: ConnectionRecord
  readonly connectionId?: ConnectionId
}): AnalysisExecutionTarget {
  const profile = snapshotAgentProfile(input.profile)
  const connection = snapshotConnection(input.connection)
  const connectionId = connection?.id ?? input.connectionId
  const model = profile.model?.default?.trim()
  return Object.freeze({
    profile,
    ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
    profileDigest: createDigest(canonicalAgentProfileDigestHex(profile)),
    ...(connection === undefined ? {} : { connection }),
    ...(connectionId === undefined ? {} : { connectionId }),
    ...(connection === undefined ? {} : { connectionDigest: canonicalDigest(connection) }),
    ...(model === undefined || model.length === 0 ? {} : { model }),
    ...(profile.harness === undefined ? {} : { runner: profile.harness }),
  })
}

export function analysisExecutionTargetFromState(state: BraidState): AnalysisExecutionTarget {
  const connection =
    state.selectedConnectionId === null
      ? undefined
      : state.connections.find((candidate) => candidate.id === state.selectedConnectionId)
  return snapshotAnalysisExecutionTarget({
    profile: state.profile,
    ...(state.selectedProfileId === null ? {} : { profileId: state.selectedProfileId }),
    ...(connection === undefined ? {} : { connection }),
    ...(state.selectedConnectionId === null ? {} : { connectionId: state.selectedConnectionId }),
  })
}
