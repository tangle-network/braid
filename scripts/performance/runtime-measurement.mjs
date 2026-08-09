import { measureRuntimeEventsToFrames } from './application-probe.mjs'
import { environment, virtualTerminal } from './reporting.mjs'
import { mergeObservations, observation } from './statistics.mjs'

export async function runRuntimeMeasurement(context, capture) {
  await capture('PERF-04', async () => {
    const count = context.mode === 'smoke' ? 100 : 10_000
    const intervalMs = 5
    const measured = await measureRuntimeEventsToFrames({
      packageRoot: context.packageRoot,
      count,
      intervalMs,
      signal: context.signal,
    })
    const qualityPassed =
      measured.missingEvents === 0 &&
      measured.duplicateEvents === 0 &&
      measured.invalidCells === 0 &&
      measured.uniqueProviderEventIds === count &&
      measured.renderedEvents === count &&
      measured.finalFrameCompleted === true &&
      measured.achievedEventsPerSecond >= 100
    return {
      ...measured,
      unit: 'ms',
      state: 'warm',
      repetitions: measured.samples.length,
      allowSingleSample: false,
      qualityPassed,
      failureReasons: measured.failureReasons,
      details: {
        achievedEventsPerSecond: measured.achievedEventsPerSecond,
        minimumEventsPerSecond: measured.minimumEventsPerSecond,
        elapsedMs: measured.elapsedMs,
        finalFrameCompleted: measured.finalFrameCompleted,
        accepted: measured.accepted,
        renderedEvents: measured.renderedEvents,
        producerIntervalMs: intervalMs,
        stageTimings: measured.stageTimings,
      },
      environment: environment({
        dimensions: '80x24',
        database: 'memory-journal-runtime-frame-path',
        eventCount: count,
        terminal: virtualTerminal,
      }),
      observations: mergeObservations(
        {
          missingEvents: observation(
            measured.missingEvents,
            measured.missingEvents === 0
              ? 'No runtime events were missing'
              : 'Runtime events were missing',
          ),
          duplicateEvents: observation(
            measured.duplicateEvents,
            measured.duplicateEvents === 0
              ? 'No duplicate runtime events were accepted'
              : 'Duplicate runtime events were accepted',
          ),
          invalidCells: observation(
            measured.invalidCells,
            measured.invalidCells === 0
              ? 'The Pi terminal contained no invalid cells'
              : 'The Pi terminal contained invalid cells',
          ),
          uniqueProviderEventIds: observation(
            measured.uniqueProviderEventIds,
            measured.uniqueProviderEventIds === count
              ? 'Every provider event identifier was unique'
              : 'Provider event identifiers were not unique',
          ),
          acceptedEvents: measured.accepted,
          frameWrites: measured.frameWrites,
          producerElapsedMs: measured.elapsedMs,
          achievedEventsPerSecond: observation(
            measured.achievedEventsPerSecond,
            measured.achievedEventsPerSecond >= 100
              ? 'The final event frame completed within the required 100 events/s interval'
              : 'The producer plus final-frame interval was slower than 100 events/s',
          ),
          finalFrameCompleted: observation(
            measured.finalFrameCompleted ? 1 : 0,
            'Elapsed time ends after the final event matched a completed Pi frame',
          ),
          eventFrameBindings: measured.provenance?.frameBinding,
        },
        {},
      ),
    }
  })
}
