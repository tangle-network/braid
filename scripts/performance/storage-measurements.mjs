import { environment } from './reporting.mjs'
import { summarizeStage } from './stage-timings.mjs'
import { observation } from './statistics.mjs'
import {
  createEncryptedStorageFixture,
  measureDatabaseGrowth,
  measureOpenViewport,
  measureReplayReduce,
  measureResidentMemory,
} from './storage-probes.mjs'

export async function prepareStorageFixtures(context) {
  const fixtures = {}
  try {
    context.throwIfAborted()
    fixtures.storage10k = await createEncryptedStorageFixture(10_000, {
      packageRoot: context.packageRoot,
    })
    context.throwIfAborted()
    context.lifecycle.addCleanup(fixtures.storage10k.cleanup)
  } catch (error) {
    if (context.signal.aborted) throw error
    context.storage10kError = error
  }
  try {
    context.throwIfAborted()
    fixtures.storage100k = await createEncryptedStorageFixture(100_000, {
      packageRoot: context.packageRoot,
    })
    context.throwIfAborted()
    context.lifecycle.addCleanup(fixtures.storage100k.cleanup)
  } catch (error) {
    if (context.signal.aborted) throw error
    context.storage100kError = error
  }
  return fixtures
}

export async function runStorageMeasurements(context, capture, fixtures) {
  const repetitions = context.mode === 'smoke' ? 1 : context.repetitions
  await capture('PERF-05', async () => {
    if (!fixtures.storage10k)
      throw context.storage10kError ?? new Error('10,000-event encrypted fixture unavailable')
    const measured = await measureReplayReduce(fixtures.storage10k, repetitions)
    return {
      ...measured,
      unit: 'ms',
      state: 'warm',
      repetitions: measured.samples.length,
      environment: environment({
        dimensions: 'none',
        database: 'warm-10000-event-encrypted-sqlite',
        eventCount: 10_000,
        terminal: 'none; production StorageJournal + reducer',
      }),
      observations: {
        replayedEvents: observation(measured.eventCount, 'Every committed event was replayed'),
        projectionChecksum: measured.projectionChecksum,
      },
      details: {
        stageTimings: Object.fromEntries(
          Object.entries(measured.stageSamples).map(([name, samples]) => [
            name,
            { ...summarizeStage(samples), rawSamples: samples },
          ]),
        ),
      },
      provenance: {
        seed: 'packed encrypted SQLite production storage; complete receipt-backed run',
      },
    }
  })

  await capture('PERF-06', async () => {
    if (!fixtures.storage100k)
      throw context.storage100kError ?? new Error('100,000-event encrypted fixture unavailable')
    const measured = await measureOpenViewport(fixtures.storage100k, repetitions)
    return {
      ...measured,
      unit: 'ms',
      state: 'cold',
      repetitions: measured.samples.length,
      environment: environment({
        dimensions: '80x24',
        database: 'cold-100000-event-encrypted-sqlite',
        eventCount: 100_000,
      }),
      observations: {
        openedEvents: observation(
          measured.eventCount,
          'Every committed event was opened from encrypted SQLite',
        ),
        loadedTailEvents: measured.loadedTailEvents,
        renderedRows: measured.renderedRows,
        viewportBound: 200,
      },
      provenance: {
        seed: 'packed encrypted SQLite production storage; recent useful content asserted',
      },
    }
  })

  await capture('PERF-09', async () => {
    if (!fixtures.storage10k)
      throw context.storage10kError ?? new Error('10,000-event encrypted fixture unavailable')
    const measured = await measureResidentMemory(
      fixtures.storage10k,
      repetitions,
      new URL('./memory-child.mjs', import.meta.url).pathname,
    )
    return {
      samples: measured.samples,
      rawSamples: measured.samples,
      unit: 'MiB RSS',
      state: 'warm',
      repetitions: measured.samples.length,
      environment: environment({
        dimensions: '80x24',
        database: 'warm-10000-event-encrypted-sqlite',
        eventCount: 10_000,
        terminal: 'packed production view model; child process RSS',
      }),
      observations: {
        residentMemory: measured.observations,
        boundedViewport: observation(
          200,
          'The child process enforces a maximum of 200 rendered rows',
        ),
      },
      provenance: {
        seed: 'packed encrypted SQLite production storage; one fresh child per repetition',
      },
    }
  })

  await capture('PERF-10', async () => {
    const measured = await measureDatabaseGrowth(10_000, repetitions, {
      packageRoot: context.packageRoot,
    })
    return {
      ...measured,
      unit: 'MiB',
      state: 'cold',
      repetitions: measured.samples.length,
      environment: environment({
        dimensions: 'none',
        database: 'cold-10000-event-encrypted-sqlite',
        eventCount: 10_000,
        terminal: 'none; packed production encrypted SQLite artifacts',
      }),
      observations: {
        databaseFiles: measured.observations,
        providerArtifacts: observation(
          0,
          'The normalized local text seed writes no provider payload artifact files',
        ),
      },
      provenance: {
        bytes: 'database + WAL + shared-memory SQLite artifacts only',
        providerArtifacts: 'reported separately and excluded from samples',
      },
    }
  })
}
