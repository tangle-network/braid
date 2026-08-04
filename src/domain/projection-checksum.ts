import { canonicalDigest } from './canonical.js'
import type { Digest } from './ids.js'
import type { BraidState } from './state.js'

/**
 * Checks only product projections. Journal position and diagnostic counters
 * are deliberately excluded so incremental reduction and replay compare the
 * same durable graph even when they reached it through different batches.
 */
export function canonicalProjectionChecksum(state: BraidState): Digest {
  const {
    revision: _revision,
    sequence: _sequence,
    appliedEvents: _appliedEvents,
    projectionChecksum: _projectionChecksum,
    health: _health,
    ...projection
  } = state
  return canonicalDigest(projection)
}
