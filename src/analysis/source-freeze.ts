import type { AnalysisSourcePort, FrozenAnalysisSourceHandle } from './model.js'
import { AnalysisServiceError } from './model.js'

export async function freezeAnalysisSource(
  source: AnalysisSourcePort,
  sourceId: string,
  signal: AbortSignal,
): Promise<FrozenAnalysisSourceHandle> {
  const frozen = await source.freeze(sourceId, signal)
  await assertSourceUnchanged(source, frozen)
  if (!frozen.source.complete) {
    if (frozen.source.completeness === 'failed')
      throw new AnalysisServiceError('ANALYST_FAILED', 'The source capture failed')
    if (frozen.source.completeness === 'unknown')
      throw new AnalysisServiceError('OPERATION_UNKNOWN', 'The source capture state is unknown')
    throw new AnalysisServiceError('SOURCE_INCOMPLETE', 'The frozen source is incomplete', {
      missingEventIds: [...(frozen.source.missingEventIds ?? [])],
    })
  }
  return frozen
}

export async function assertSourceUnchanged(
  source: AnalysisSourcePort,
  handle: FrozenAnalysisSourceHandle,
): Promise<void> {
  const verification = await source.verify(handle)
  if (!verification.unchanged)
    throw new AnalysisServiceError('SOURCE_CHANGED', 'The source changed during analysis', {
      currentDigest: verification.currentDigest,
      currentRevision: verification.currentRevision,
    })
}

export async function assertCurrentSourceDigest(
  source: AnalysisSourcePort,
  sourceId: string,
  expected: string,
  action: string,
): Promise<void> {
  const current = await source.currentDigest(sourceId)
  if (current !== expected)
    throw new AnalysisServiceError('SOURCE_CHANGED', `The source changed before ${action}`)
}

export async function assertSourceReplay(
  source: AnalysisSourcePort,
  handle: FrozenAnalysisSourceHandle,
): Promise<void> {
  if (typeof source.replay !== 'function')
    throw new AnalysisServiceError(
      'SOURCE_REPLAY_UNAVAILABLE',
      'The source adapter cannot replay the frozen event range',
    )
  const replay = await source.replay(handle)
  if (
    !replay.complete ||
    replay.sourceRevision !== handle.source.sourceRevision ||
    replay.missingEventIds.length > 0 ||
    replay.eventIds.length !== handle.source.eventIds.length ||
    replay.eventIds.some((eventId, index) => eventId !== handle.source.eventIds[index])
  ) {
    throw new AnalysisServiceError(
      'SOURCE_CHANGED',
      'The source event range could not be replayed completely before promotion',
      {
        sourceRevision: replay.sourceRevision,
        expectedRevision: handle.source.sourceRevision,
        missingEventIds: replay.missingEventIds,
        replayedEventIds: replay.eventIds,
      },
    )
  }
}
