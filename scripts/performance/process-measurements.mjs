import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  measureFirstVisibleFrame,
  measureIdleCpu,
  measureIdleKeyFrames,
} from './process-probes.mjs'
import { environment, fixtureOptions, packedOptions } from './reporting.mjs'
import { measurePackedResizeStream } from './resize-probe.mjs'
import { assertFullDuration, mergeObservations, observation } from './statistics.mjs'

const READY_ERROR =
  /(?:PRODUCTION_|STORAGE_|CREDENTIAL_STORE_UNAVAILABLE|startup error|encrypted storage)/iu
// Linux child CPU accounting advances in 10 ms ticks on the release machine.
// Two seconds gives the 1%-of-one-core target at least two observable ticks;
// the former 250 ms smoke could only distinguish 0% from 4% and produced false failures.
const SMOKE_IDLE_DURATION_MS = 2_000
const SMOKE_IDLE_SETTLE_MS = 250

function readyFramePredicate(marker) {
  return (lines, output) =>
    lines.some((line) => line.includes(marker)) &&
    lines.some((line) => /braid/iu.test(line)) &&
    !READY_ERROR.test(output)
}

export function interactiveReadyFramePredicate(marker) {
  const ready = readyFramePredicate(marker)
  return (lines, output) =>
    ready(lines, output) &&
    lines.some((line) => line.includes('profile Braid performance profile')) &&
    lines.some((line) => line.includes('type / for commands'))
}

function composerKeyPredicate(snapshot, token) {
  const keyLines = snapshot.lines.filter((line) => line.includes(token))
  const otherTokens = snapshot.lines.filter(
    (line) => /perf-key-\d+/u.test(line) && !line.includes(token),
  )
  return keyLines.length === 1 && otherTokens.length === 0
}

function composerEmptyPredicate(snapshot) {
  return !snapshot.lines.some((line) => /perf-key-\d+/u.test(line))
}

function seedMarker(eventCount) {
  return `Completed Braid performance conversation (${eventCount} committed events)`
}

function startupTimingPath(fixture, state, index) {
  return join(fixture.root, `.braid-startup-${state}-${index}.json`)
}

function startupStages(result) {
  const timing = result.startup
  if (timing === undefined) throw new Error('Packed startup timing was not captured')
  const duration = (end, start) => Number((end - start).toFixed(3))
  const compileCacheReadyEpochMs = timing.compileCacheReadyEpochMs ?? timing.scriptReadyEpochMs
  const previewModulesReadyEpochMs =
    timing.previewModulesReadyEpochMs ?? timing.applicationModulesReadyEpochMs
  const startupModulesReadyEpochMs = Math.max(
    timing.applicationModulesReadyEpochMs,
    previewModulesReadyEpochMs,
  )
  const previewReadyEpochMs = timing.previewReadyEpochMs ?? timing.applicationReadyEpochMs
  const firstFrameEpochMs = result.startedAtEpochMs + result.value
  const applicationOpenMs = duration(timing.applicationReadyEpochMs, startupModulesReadyEpochMs)
  return Object.freeze({
    spawnMs: duration(timing.processStartEpochMs, result.startedAtEpochMs),
    scriptMs: duration(timing.scriptReadyEpochMs, timing.processStartEpochMs),
    compileCacheMs: duration(compileCacheReadyEpochMs, timing.scriptReadyEpochMs),
    applicationImportsMs: duration(timing.applicationModulesReadyEpochMs, compileCacheReadyEpochMs),
    previewImportsMs: duration(previewModulesReadyEpochMs, compileCacheReadyEpochMs),
    startupImportsMs: duration(startupModulesReadyEpochMs, compileCacheReadyEpochMs),
    applicationOpenMs,
    applicationStages: timing.applicationStages ?? [],
    previewRenderMs: duration(firstFrameEpochMs, timing.applicationReadyEpochMs),
    terminalImportsMs: duration(timing.terminalModulesReadyEpochMs, previewReadyEpochMs),
    terminalMs: duration(timing.terminalReadyEpochMs, timing.terminalModulesReadyEpochMs),
    initializeMs: duration(timing.initializedEpochMs, timing.terminalReadyEpochMs),
    interactivePreparationMs: duration(timing.initializedEpochMs, previewReadyEpochMs),
  })
}

export async function runProcessMeasurements(context, capture) {
  const {
    packed,
    warmProcessFixture,
    coldProcessFixture,
    repetitions,
    mode,
    signal,
    repeatCompileCachePath,
  } = context
  const count = mode === 'smoke' ? 1 : repetitions
  const keyCount = mode === 'smoke' ? 1 : 1_000
  const resizeCount = mode === 'smoke' ? 10 : 1_000

  await capture('PERF-01', async () => {
    if (!packed) throw new Error(context.packedError ?? 'Packed candidate unavailable')
    if (!warmProcessFixture)
      throw new Error(context.processPrerequisiteError ?? 'Warm fixture unavailable')
    if (!repeatCompileCachePath)
      throw new Error(context.compileCacheError ?? 'Primed Node compile cache unavailable')
    const results = []
    for (let index = 0; index < count; index += 1) {
      const timingPath = startupTimingPath(warmProcessFixture, 'warm', index)
      results.push(
        await measureFirstVisibleFrame({
          ...packedOptions(packed, warmProcessFixture, {
            environment: {
              BRAID_STARTUP_TIMING_PATH: timingPath,
              NODE_COMPILE_CACHE: repeatCompileCachePath,
            },
          }),
          signal,
          startupTimingPath: timingPath,
          readyFramePredicate: readyFramePredicate(seedMarker(10_000)),
          shutdownReadyFramePredicate: interactiveReadyFramePredicate(seedMarker(10_000)),
        }),
      )
    }
    const invalidCells = Math.max(...results.map((result) => result.frame.invalidCells), 0)
    const readyFrames = results.filter((result) => result.value !== undefined).length
    const compileCacheFrames = results.filter(
      (result) => result.startup?.compileCacheEnabled === true,
    ).length
    return {
      samples: results.map((result) => result.value),
      unit: 'ms',
      state: 'warm',
      repetitions: results.length,
      observations: {
        readyFrames: observation(
          readyFrames,
          'Every sample waited for the seeded useful ready frame',
        ),
        invalidCells: observation(
          invalidCells,
          invalidCells === 0
            ? 'All parsed frames had valid terminal cells'
            : 'Invalid cells were observed',
        ),
        startupErrors: observation(
          0,
          'No startup or encrypted-storage error appeared before readiness',
        ),
        compileCacheFrames: observation(
          compileCacheFrames,
          'Every repeat launch used the primed Node compile cache',
        ),
        compileCacheStatuses: results.map((result) => result.startup?.compileCacheStatus ?? null),
        startupStages: results.map(startupStages),
      },
      qualityPassed:
        readyFrames === results.length &&
        compileCacheFrames === results.length &&
        invalidCells === 0,
      provenance: {
        seed: warmProcessFixture.database,
        readyMarker: seedMarker(10_000),
        frameReadiness: 'unique seeded final-content marker plus braid shell and no startup error',
        compileCache:
          'primed exact packed startup modules; one shared cache across repeat launches',
      },
      environment: environment({
        dimensions: '80x24',
        database: 'warm-10000-event-encrypted-sqlite',
        eventCount: 10_000,
      }),
    }
  })

  await capture('PERF-02', async () => {
    if (!packed) throw new Error(context.packedError ?? 'Packed candidate unavailable')
    if (!coldProcessFixture)
      throw new Error(context.processPrerequisiteError ?? 'Cold fixture unavailable')
    const results = []
    for (let index = 0; index < count; index += 1) {
      const timingPath = startupTimingPath(coldProcessFixture, 'cold', index)
      const compileCachePath = await mkdtemp(join(tmpdir(), 'braid-empty-compile-cache-'))
      try {
        results.push(
          await measureFirstVisibleFrame({
            ...packedOptions(packed, coldProcessFixture, {
              environment: {
                BRAID_STARTUP_TIMING_PATH: timingPath,
                NODE_COMPILE_CACHE: compileCachePath,
              },
            }),
            signal,
            startupTimingPath: timingPath,
            readyFramePredicate: readyFramePredicate(seedMarker(100_000)),
            shutdownReadyFramePredicate: interactiveReadyFramePredicate(seedMarker(100_000)),
          }),
        )
      } finally {
        await rm(compileCachePath, { force: true, recursive: true })
      }
    }
    const invalidCells = Math.max(...results.map((result) => result.frame.invalidCells), 0)
    const readyFrames = results.filter((result) => result.value !== undefined).length
    const compileCacheFrames = results.filter(
      (result) => result.startup?.compileCacheEnabled === true,
    ).length
    return {
      samples: results.map((result) => result.value),
      unit: 'ms',
      state: 'cold',
      repetitions: results.length,
      observations: {
        readyFrames: observation(
          readyFrames,
          'Every sample waited for the seeded useful ready frame',
        ),
        invalidCells: observation(
          invalidCells,
          invalidCells === 0
            ? 'All parsed frames had valid terminal cells'
            : 'Invalid cells were observed',
        ),
        startupErrors: observation(
          0,
          'No startup or encrypted-storage error appeared before readiness',
        ),
        compileCacheFrames: observation(
          compileCacheFrames,
          'Every first launch started with its own empty Node compile-cache directory',
        ),
        compileCacheStatuses: results.map((result) => result.startup?.compileCacheStatus ?? null),
        startupStages: results.map(startupStages),
      },
      qualityPassed:
        readyFrames === results.length &&
        compileCacheFrames === results.length &&
        invalidCells === 0,
      provenance: {
        seed: coldProcessFixture.database,
        readyMarker: seedMarker(100_000),
        frameReadiness: 'unique seeded final-content marker plus braid shell and no startup error',
        compileCache: 'fresh empty directory for every launch; no compiled startup modules reused',
      },
      environment: environment({
        dimensions: '80x24',
        database: 'cold-100000-event-encrypted-sqlite',
        eventCount: 100_000,
      }),
    }
  })

  await capture('PERF-03', async () => {
    if (!packed) throw new Error(context.packedError ?? 'Packed candidate unavailable')
    if (!warmProcessFixture)
      throw new Error(context.processPrerequisiteError ?? 'Warm fixture unavailable')
    const result = await measureIdleKeyFrames({
      ...packedOptions(packed, warmProcessFixture),
      signal,
      count: keyCount,
      readyFramePredicate: interactiveReadyFramePredicate(seedMarker(10_000)),
      keyFramePredicate: composerKeyPredicate,
      emptyFramePredicate: composerEmptyPredicate,
    })
    const invalidCells = result.frame.invalidCells
    const allEditsBound =
      result.edits.length === keyCount &&
      result.edits.every((edit) => edit.eraseFrameVersion > edit.keyFrameVersion)
    return {
      samples: result.samples,
      rawSamples: result.samples,
      unit: 'ms',
      state: 'warm',
      repetitions: result.samples.length,
      observations: {
        keyCount: observation(
          result.edits.length,
          'Every unique composer edit reached a matching frame',
        ),
        eraseFrames: observation(
          result.edits.filter((edit) => edit.eraseFrameVersion > edit.keyFrameVersion).length,
          'Every edit awaited a later composer-empty frame before the next edit',
        ),
        invalidCells: observation(
          invalidCells,
          invalidCells === 0
            ? 'The final parsed frame had valid terminal cells'
            : 'Invalid cells were observed',
        ),
        editBindings: result.edits,
      },
      qualityPassed: allEditsBound && invalidCells === 0,
      provenance: {
        seed: warmProcessFixture.database,
        inputBinding: 'unique perf-key-N text accepted by the real PTY composer',
        eraseBinding: 'Ctrl-U followed by a later frame with no perf-key-N token',
      },
      environment: environment({
        dimensions: '80x24',
        database: 'warm-10000-event-encrypted-sqlite',
        eventCount: 10_000,
      }),
    }
  })

  await capture('PERF-07', async () => {
    if (!packed) throw new Error(context.packedError ?? 'Packed candidate unavailable')
    const measured = await measurePackedResizeStream({
      packageRoot: context.packageRoot,
      resizeCount,
      eventIntervalMs: mode === 'smoke' ? 4 : 8,
      signal,
    })
    const qualityPassed =
      measured.qualityPassed &&
      measured.ratePassed &&
      measured.observedEventsPerSecond >= measured.minimumEventsPerSecond &&
      measured.renderedResizes === resizeCount &&
      measured.duplicateEvents === 0 &&
      measured.duplicateProviderEventIds === 0 &&
      measured.missingEvents === 0 &&
      measured.unexpectedEvents === 0 &&
      measured.invalidCells === 0 &&
      measured.activeDuringEveryResize &&
      !measured.staticTranscript
    return {
      samples: measured.samples,
      rawSamples: measured.rawSamples,
      unit: 'ms',
      state: 'warm',
      repetitions: measured.samples.length,
      observations: mergeObservations(
        {
          producedEvents: observation(
            measured.produced,
            'Generated events were counted inside the packed execution stream',
          ),
          acceptedEvents: observation(
            measured.accepted,
            'Accepted events were counted from the packed application journal',
          ),
          renderedFrames: observation(
            measured.rendered,
            'Pi render completions were counted after xterm flush',
          ),
          renderedResizes: observation(
            measured.renderedResizes,
            'Every resize received a completed Pi render',
          ),
          elapsedMs: observation(
            measured.elapsedMs,
            'The interval starts at the first generated event and ends after the final resize-bound frame',
          ),
          offeredEventsPerSecond: observation(
            measured.offeredEventsPerSecond,
            'Offered rate uses generated events over the measured stream interval',
          ),
          acceptedEventsPerSecond: observation(
            measured.acceptedEventsPerSecond,
            measured.acceptedEventsPerSecond >= measured.minimumEventsPerSecond
              ? 'Accepted rate met the required 100 events/s'
              : 'Accepted rate was below the required 100 events/s',
          ),
          observedEventsPerSecond: observation(
            measured.observedEventsPerSecond,
            'The pass rate is the accepted stream rate through the final resize-bound frame',
          ),
          producerEventsPerSecond: observation(
            measured.producerEventsPerSecond,
            'Producer cadence uses the first through last generated event timestamps',
          ),
          minimumEventsPerSecond: observation(
            measured.minimumEventsPerSecond,
            'The accepted stream must sustain at least this rate',
          ),
          minimumExpectedEvents: observation(
            measured.minimumExpectedEvents,
            'Exact event-count equivalent of the 100 events/s requirement over this interval',
          ),
          ratePassed: observation(
            measured.ratePassed ? 1 : 0,
            'Accepted stream rate passed the exact lower bound',
          ),
          duplicateEvents: observation(
            measured.duplicateEvents,
            'No duplicate stream sequence markers were committed',
          ),
          duplicateProviderEventIds: observation(
            measured.duplicateProviderEventIds,
            'No duplicate provider event IDs were committed',
          ),
          missingEvents: observation(
            measured.missingEvents,
            'No generated stream marker was absent from the accepted journal',
          ),
          unexpectedEvents: observation(
            measured.unexpectedEvents,
            'No accepted event had an unexpected stream marker',
          ),
          invalidCells: observation(
            measured.invalidCells,
            'Every reference-size frame contained valid cells',
          ),
          activeDuringEveryResize: observation(
            measured.activeDuringEveryResize ? 1 : 0,
            'The run stayed active through every resize',
          ),
          staticTranscript: observation(
            measured.staticTranscript ? 1 : 0,
            'Accepted event counts changed while resizing',
          ),
          perResize: measured.perResize,
        },
        {},
      ),
      qualityPassed,
      failureReasons: measured.failureReasons,
      details: {
        streamElapsedMs: measured.streamElapsedMs,
        firstGeneratedAt: measured.firstGeneratedAt,
        lastGeneratedAt: measured.lastGeneratedAt,
        finalResizeFrameCompletedAt: measured.finalResizeFrameCompletedAt,
        intendedEventsPerSecond: measured.intendedEventsPerSecond,
        producerEventsPerSecond: measured.producerEventsPerSecond,
        offeredEventsPerSecond: measured.offeredEventsPerSecond,
        acceptedEventsPerSecond: measured.acceptedEventsPerSecond,
        observedEventsPerSecond: measured.observedEventsPerSecond,
        minimumEventsPerSecond: measured.minimumEventsPerSecond,
        minimumExpectedEvents: measured.minimumExpectedEvents,
        ratePassed: measured.ratePassed,
        stageTimings: measured.stageTimings,
      },
      provenance: measured.provenance,
      environment: environment({
        dimensions: '40x12,80x24,120x40,200x60',
        database: 'packed headless 100-events-per-second stream',
        eventCount: measured.accepted,
      }),
    }
  })

  await capture('PERF-08', async () => {
    if (!packed) throw new Error(context.packedError ?? 'Packed candidate unavailable')
    const durationMs =
      mode === 'smoke'
        ? SMOKE_IDLE_DURATION_MS
        : Number(process.env.BRAID_PERFORMANCE_IDLE_DURATION_MS ?? 60_000)
    const settleMs =
      mode === 'smoke'
        ? SMOKE_IDLE_SETTLE_MS
        : Number(process.env.BRAID_PERFORMANCE_IDLE_SETTLE_MS ?? 2_000)
    const result = []
    for (let index = 0; index < (mode === 'smoke' ? 1 : 2); index += 1) {
      const sample = await measureIdleCpu({
        ...fixtureOptions(packed, { signal }),
        durationMs,
        settleMs,
      })
      assertFullDuration(sample.elapsedSeconds * 1_000, durationMs)
      result.push(sample)
    }
    return {
      samples: result.map((sample) => sample.value),
      rawSamples: result.map((sample) => sample.value),
      unit: '% of one core',
      state: 'warm',
      repetitions: result.length,
      observations: {
        durationSeconds: result.map((sample) => sample.elapsedSeconds),
        cpuSeconds: result.map((sample) => sample.cpuSeconds),
        requiredDurationSeconds: durationMs / 1_000,
      },
      qualityPassed: result.every((sample) => sample.elapsedSeconds * 1_000 >= durationMs),
      provenance: {
        settlingSeconds: settleMs / 1_000,
        measuredSeconds: durationMs / 1_000,
        cpuMeter: process.platform === 'linux' ? '/proc/<pid>/stat' : 'ps',
        commandPath: 'packed deterministic Braid process',
      },
      environment: environment({
        dimensions: '80x24',
        database: 'deterministic-offline-fixture-idle',
        eventCount: 0,
      }),
    }
  })
}
