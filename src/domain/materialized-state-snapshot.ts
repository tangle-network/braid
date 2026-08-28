import { canonicalDigest } from './canonical.js'
import type { EventId } from './ids.js'
import { assertBraidState, DomainInvariantError } from './invariants.js'
import { migrateLegacyInteractions } from './legacy-interaction-snapshot.js'
import type { MaterializedState } from './materialized-state.js'
import { canonicalProjectionChecksum } from './projection-checksum.js'
import { withHealth } from './reducer-helpers.js'
import { normalizeActiveRuns, type BraidState, initialState } from './state.js'

export const MATERIALIZED_SNAPSHOT_SCHEMA_VERSION = 1 as const

/**
 * The durable projection needed to resume the application.
 *
 * This is deliberately an explicit list rather than BraidState. Replay-only
 * identity history, unknown-event payloads, health, and derived checksums are
 * reconstructed from the journal tail and database projection metadata.
 */
export type { MaterializedState } from './materialized-state.js'

export interface MaterializedStateSnapshot {
  readonly kind: 'braid.materialized-state'
  readonly schemaVersion: typeof MATERIALIZED_SNAPSHOT_SCHEMA_VERSION
  readonly scopeId: string
  readonly generation: number
  readonly eventId: EventId
  readonly sequence: number
  readonly revision: number
  readonly state: MaterializedState
  readonly stateChecksum: string
}

function materializedState(state: BraidState): MaterializedState {
  return {
    schemaVersion: state.schemaVersion,
    workspace: state.workspace,
    workspaceId: state.workspaceId,
    conversationId: state.conversationId,
    branchId: state.branchId,
    selectedProfileId: state.selectedProfileId,
    selectedConnectionId: state.selectedConnectionId,
    profile: state.profile,
    draft: state.draft,
    messages: state.messages,
    messageParts: state.messageParts,
    runs: state.runs,
    activeRuns: state.activeRuns,
    focusedRunId: state.focusedRunId,
    activeRunId: state.activeRunId,
    queuedInputs: state.queuedInputs,
    lastError: state.lastError,
    workspaces: state.workspaces,
    profiles: state.profiles,
    profileSnapshots: state.profileSnapshots,
    credentials: state.credentials,
    connections: state.connections,
    conversations: state.conversations,
    branches: state.branches,
    turns: state.turns,
    analyses: state.analyses,
    analysisAttachments: state.analysisAttachments,
    environments: state.environments,
    checkpoints: state.checkpoints,
    supervisors: state.supervisors,
    workers: state.workers,
    drafts: state.drafts,
    queues: state.queues,
    queueEntries: state.queueEntries,
    rules: state.rules,
    bindings: state.bindings,
    graphNodes: state.graphNodes,
    graphEdges: state.graphEdges,
    operations: state.operations,
    effects: state.effects,
    feedbackDecisions: state.feedbackDecisions,
    replayCursors: state.replayCursors,
    missingHistory: state.missingHistory,
  }
}

export function createMaterializedStateSnapshot(input: {
  readonly scopeId: string
  readonly generation: number
  readonly eventId: EventId
  readonly state: BraidState
}): MaterializedStateSnapshot {
  const state = materializedState(input.state)
  return {
    kind: 'braid.materialized-state',
    schemaVersion: MATERIALIZED_SNAPSHOT_SCHEMA_VERSION,
    scopeId: input.scopeId,
    generation: input.generation,
    eventId: input.eventId,
    sequence: input.state.sequence,
    revision: input.state.revision,
    state,
    stateChecksum: canonicalDigest(state),
  }
}

export function isMaterializedStateSnapshot(value: unknown): value is MaterializedStateSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<MaterializedStateSnapshot>
  const generation = candidate.generation
  const sequence = candidate.sequence
  const revision = candidate.revision
  if (
    candidate.kind !== 'braid.materialized-state' ||
    candidate.schemaVersion !== MATERIALIZED_SNAPSHOT_SCHEMA_VERSION ||
    typeof candidate.scopeId !== 'string' ||
    typeof generation !== 'number' ||
    !Number.isSafeInteger(generation) ||
    generation <= 0 ||
    typeof candidate.eventId !== 'string' ||
    typeof sequence !== 'number' ||
    !Number.isSafeInteger(sequence) ||
    sequence <= 0 ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision <= 0 ||
    candidate.state === null ||
    typeof candidate.state !== 'object' ||
    Array.isArray(candidate.state) ||
    typeof candidate.stateChecksum !== 'string'
  )
    return false
  if (candidate.state.schemaVersion !== 2) return false
  return canonicalDigest(candidate.state) === candidate.stateChecksum
}

export function restoreMaterializedState(value: unknown): BraidState {
  if (!isMaterializedStateSnapshot(value)) {
    throw new Error('Materialized state snapshot failed validation')
  }
  const snapshot = value
  const base = initialState(snapshot.state.profile, {
    conversationId: snapshot.state.conversationId,
    branchId: snapshot.state.branchId,
  })
  const stateFields = migrateLegacyInteractions({ ...snapshot.state } as MaterializedState & {
    interactions?: unknown
  })
  validatePersistedActiveRunReferences(stateFields)
  const restored: BraidState = normalizeActiveRuns({
    ...base,
    ...stateFields,
    activeRuns: stateFields.activeRuns ?? base.activeRuns,
    focusedRunId: stateFields.focusedRunId ?? stateFields.activeRunId ?? base.focusedRunId,
    revision: snapshot.revision,
    sequence: snapshot.sequence,
    appliedEvents: [],
    unknownEvents: [],
    projectionChecksum: null,
    health: {
      status: 'healthy',
      lastError: snapshot.state.lastError,
      missingHistoryCount: snapshot.state.missingHistory.length,
      unknownEventCount: 0,
    },
  })
  const healthy = withHealth(restored)
  const finalized: BraidState = {
    ...healthy,
    projectionChecksum: canonicalProjectionChecksum(healthy),
  }
  assertBraidState(finalized)
  return finalized
}

function validatePersistedActiveRunReferences(state: MaterializedState): void {
  const runs = new Map(state.runs.map((run) => [run.id, run]))
  for (const [name, runId] of [
    ['activeRunId', state.activeRunId],
    ['focusedRunId', state.focusedRunId],
  ] as const) {
    if (runId !== null && runId !== undefined && !runs.has(runId)) {
      throw new DomainInvariantError(`state.${name} references unknown run ${runId}`)
    }
  }
  const seen = new Set<string>()
  for (const active of state.activeRuns ?? []) {
    if (seen.has(active.runId)) {
      throw new DomainInvariantError(`state.activeRuns contains duplicate run ${active.runId}`)
    }
    seen.add(active.runId)
    const run = runs.get(active.runId)
    if (!run)
      throw new DomainInvariantError(`state.activeRuns references unknown run ${active.runId}`)
    if (run.conversationId !== active.conversationId || run.branchId !== active.branchId) {
      throw new DomainInvariantError(`state.activeRuns has stale identity for run ${active.runId}`)
    }
  }
}
