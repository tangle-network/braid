import { STARTER_PROFILE } from '../../src/app/composition.js'
import type { BraidEventEnvelope } from '../../src/domain/events.js'
import { createEventId } from '../../src/domain/ids.js'
import { createMaterializedStateSnapshot } from '../../src/domain/materialized-state-snapshot.js'
import { reduceEvent } from '../../src/domain/reducer.js'
import { initialState } from '../../src/domain/state.js'
import type { StateSnapshot } from '../../src/ports/storage.js'

export function snapshotForStorage(
  storage: { readonly snapshotScopeId: () => string },
  eventId: string,
  sequence: number,
): StateSnapshot {
  let state = initialState(STARTER_PROFILE)
  for (let index = 1; index <= sequence; index += 1) {
    const currentEventId = createEventId(`event-crash-${index}`)
    const envelope: BraidEventEnvelope = {
      eventId: currentEventId,
      sequence: index,
      revision: index,
      occurredAt: '2026-08-02T00:00:00.000Z',
      event: { kind: 'draft.changed', text: `snapshot-crash-${index}` },
    }
    state = reduceEvent(state, envelope)
  }
  return createMaterializedStateSnapshot({
    scopeId: storage.snapshotScopeId(),
    generation: sequence,
    eventId: createEventId(eventId),
    state,
  })
}

export async function seedSnapshots(
  storage: {
    readonly snapshotScopeId: () => string
    readonly writeStateSnapshot: (snapshot: StateSnapshot) => Promise<void>
  },
  eventIds: readonly string[],
): Promise<void> {
  for (let index = 0; index < eventIds.length; index += 1) {
    const eventId = eventIds[index]
    if (eventId === undefined) throw new Error('Snapshot fixture event id is missing')
    await storage.writeStateSnapshot(snapshotForStorage(storage, eventId, index + 1))
  }
}
