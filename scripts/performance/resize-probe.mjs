import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { TuiMainScreen } from '@earendil-works/pi-tui'
import { HeadlessTerminal } from './headless-terminal.mjs'
import { loadPackedRuntime } from './packed-runtime.mjs'
import { summarizeStage } from './stage-timings.mjs'

const REFERENCE_DIMENSIONS = Object.freeze([
  Object.freeze([40, 12]),
  Object.freeze([80, 24]),
  Object.freeze([120, 40]),
  Object.freeze([200, 60]),
])
const PROFILE = Object.freeze({ name: 'Braid performance profile', harness: 'pi' })
const FIXED_TIME = '2026-08-03T00:00:00.000Z'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function invalidCellCount(terminal) {
  const buffer = terminal.xterm.buffer.active
  let invalid = 0
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row)
    for (let column = 0; column < terminal.columns; column += 1) {
      const cell = line?.getCell(column)
      if (!cell || typeof cell.getChars !== 'function') invalid += 1
    }
  }
  return invalid
}

async function waitFor(predicate, label, signal, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (signal?.aborted) throw new Error(`Interrupted while waiting for ${label}`)
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await sleep(2)
  }
}

function streamingExecution({ intervalMs, totalEvents, generated, capabilities }) {
  return {
    admissionMode: 'sync',
    capabilities: () => capabilities,
    async *streamTurn(input) {
      const cadenceStartedAt = performance.now()
      for (let sequence = 1; sequence <= totalEvents; sequence += 1) {
        if (input.signal.aborted) return
        const delayMs = scheduledProducerDelay({
          cadenceStartedAt,
          sequence,
          intervalMs,
          now: performance.now(),
        })
        if (delayMs > 0) await sleep(delayMs, undefined, { signal: input.signal })
        const generatedAt = performance.now()
        generated.events.push({ sequence, generatedAt })
        generated.firstGeneratedAt ??= generatedAt
        generated.lastGeneratedAt = generatedAt
        yield {
          type: 'text_delta',
          text: `resize-event-${String(sequence).padStart(6, '0')} `,
          timestamp: FIXED_TIME,
        }
      }
      if (!input.signal.aborted) {
        yield {
          type: 'final',
          status: 'completed',
          reason: 'resize performance stream complete',
          text: 'resize performance stream complete',
          timestamp: FIXED_TIME,
          metadata: { inputTokens: 1, outputTokens: totalEvents, model: 'fixture/resize' },
        }
      }
    },
    async cancelRun(input) {
      return { operationId: input.operationId, outcome: 'accepted' }
    },
  }
}

export function scheduledProducerDelay({ cadenceStartedAt, sequence, intervalMs, now }) {
  return Math.max(0, cadenceStartedAt + (sequence - 1) * intervalMs - now)
}

export function evaluateResizeStreamRate({
  produced,
  accepted,
  streamElapsedMs,
  minimumEventsPerSecond = 100,
}) {
  const elapsedSeconds = streamElapsedMs / 1_000
  const offeredEventsPerSecond = produced / elapsedSeconds
  const acceptedEventsPerSecond = accepted / elapsedSeconds
  const minimumExpectedEvents = Math.ceil(minimumEventsPerSecond * elapsedSeconds)
  return {
    streamElapsedMs,
    offeredEventsPerSecond,
    acceptedEventsPerSecond,
    observedEventsPerSecond: acceptedEventsPerSecond,
    minimumEventsPerSecond,
    minimumExpectedEvents,
    passed:
      Number.isFinite(acceptedEventsPerSecond) && acceptedEventsPerSecond >= minimumEventsPerSecond,
  }
}

export async function measurePackedResizeStream({
  packageRoot,
  resizeCount = 1_000,
  eventIntervalMs = 10,
  signal,
} = {}) {
  const runtime = await loadPackedRuntime(packageRoot)
  const generated = {
    events: [],
    firstGeneratedAt: undefined,
    lastGeneratedAt: undefined,
  }
  const terminal = new HeadlessTerminal(80, 24)
  const tui = new TuiMainScreen(terminal)
  const app = runtime.index.createBraidApplication({
    execution: streamingExecution({
      intervalMs: eventIntervalMs,
      totalEvents: resizeCount * 20,
      generated,
      capabilities: runtime.index.DEFAULT_RUN_CAPABILITIES,
    }),
    profile: PROFILE,
    clock: new runtime.clock.FixedClock(FIXED_TIME),
    journal: new runtime.index.MemoryJournal(new runtime.clock.FixedClock(FIXED_TIME)),
  })
  const controller = runtime.tui.createApplicationUiController(app, {
    color: 'none',
    reducedMotion: true,
  })
  const frameTimings = []
  const terminalApp = new runtime.terminal.BraidTerminalApp({
    controller,
    tui,
    theme: runtime.theme.createBraidTheme({ colors: false, reducedMotion: true }),
    workspace: '/performance-resize',
    nextOperationId: (() => {
      let next = 0
      return () => `op-perf-resize-ui-${++next}`
    })(),
    onFrameTiming: (timing) => frameTimings.push(timing),
  })
  const completedFrames = []
  const piRenderSamples = []
  const terminalFlushSamples = []
  const resizeCallSamples = []
  let resizeEpoch = 0
  let runId
  let terminalStarted = false
  let renderFailure
  const originalDoRender = tui.doRender.bind(tui)
  tui.doRender = () => {
    const renderEpoch = resizeEpoch
    const renderStartedAt = performance.now()
    try {
      originalDoRender()
      piRenderSamples.push(performance.now() - renderStartedAt)
      const flushStartedAt = performance.now()
      void terminal.flush().then(() => {
        const completedAt = performance.now()
        terminalFlushSamples.push(completedAt - flushStartedAt)
        completedFrames.push({
          epoch: renderEpoch,
          completedAt,
          columns: terminal.columns,
          rows: terminal.rows,
          invalidCells: invalidCellCount(terminal),
        })
      })
    } catch (error) {
      renderFailure = error
    }
  }

  const perResize = []
  try {
    if (signal?.aborted) throw new Error('Interrupted before PERF-07 started')
    app.initialize('/performance-resize')
    void terminalApp.start()
    terminalStarted = true
    await terminal.flush()
    const receipt = app.send({
      operationId: 'op-perf-resize-start',
      text: 'keep the resize stream active while the terminal changes size',
    })
    await receipt.admissionReady
    runId = receipt.runId
    await waitFor(() => app.state().activeRunId === runId, 'PERF-07 active run admission', signal)
    await waitFor(
      () => generated.firstGeneratedAt !== undefined,
      'PERF-07 first generated stream event',
      signal,
    )

    for (let index = 0; index < resizeCount; index += 1) {
      if (signal?.aborted) throw new Error('Interrupted during PERF-07 resize stream')
      if (renderFailure) throw renderFailure
      const [columns, rows] = REFERENCE_DIMENSIONS[index % REFERENCE_DIMENSIONS.length]
      const epoch = ++resizeEpoch
      const resizeStartedAt = performance.now()
      terminal.resize(columns, rows)
      const resizeCallMs = performance.now() - resizeStartedAt
      resizeCallSamples.push(resizeCallMs)
      let resizeFrame
      await waitFor(
        () => {
          resizeFrame = completedFrames.find((frame) => frame.epoch === epoch)
          return resizeFrame
        },
        `Pi render after resize ${index + 1}`,
        signal,
      )
      if (!resizeFrame) throw new Error(`PERF-07 resize ${index + 1} had no completed frame`)
      const state = app.state()
      const run = state.runs.find((candidate) => candidate.id === runId)
      const active = state.activeRunId === runId && run?.complete === false
      const cells = invalidCellCount(terminal)
      const dimensions = { columns: terminal.columns, rows: terminal.rows }
      assert(
        dimensions.columns === columns && dimensions.rows === rows,
        'Resize dimensions changed',
      )
      perResize.push({
        index: index + 1,
        requested: { columns, rows },
        dimensions,
        elapsedMs: performance.now() - resizeStartedAt,
        resizeCallMs,
        frameCompletions: completedFrames.length,
        frameCompletedAt: resizeFrame.completedAt,
        acceptedEvents: run?.eventCount ?? 0,
        active,
        invalidCells: cells,
      })
      if (!active) throw new Error(`PERF-07 stream completed before resize ${index + 1}`)
      if (cells !== 0)
        throw new Error(`PERF-07 found ${cells} invalid cells at resize ${index + 1}`)
      const remaining = eventIntervalMs - (performance.now() - resizeStartedAt)
      if (remaining > 0) await sleep(remaining, undefined, { signal })
    }

    const finalResizeFrame = perResize.at(-1)
    const streamElapsedMs =
      finalResizeFrame?.frameCompletedAt === undefined || generated.firstGeneratedAt === undefined
        ? Number.NaN
        : finalResizeFrame.frameCompletedAt - generated.firstGeneratedAt
    const events = app.events().filter((envelope) => envelope.event.kind === 'run.text.delta')
    const eventIds = events.map((envelope) => envelope.event.provider?.eventId)
    const uniqueEventIds = new Set(eventIds)
    const acceptedSequences = events.flatMap((envelope) => {
      const match = /^resize-event-(\d{6}) /u.exec(envelope.event.text)
      return match ? [Number(match[1])] : []
    })
    const acceptedSequenceSet = new Set(acceptedSequences)
    const expectedSequences = generated.events.map((event) => event.sequence)
    const produced = expectedSequences.length
    const accepted = acceptedSequences.length
    const missingEvents = expectedSequences.filter(
      (sequence) => !acceptedSequenceSet.has(sequence),
    ).length
    const duplicateEvents = acceptedSequences.length - acceptedSequenceSet.size
    const duplicateProviderEventIds = eventIds.length - uniqueEventIds.size
    const unexpectedEvents = acceptedSequences.filter(
      (sequence) => !expectedSequences.includes(sequence),
    ).length
    const rate = evaluateResizeStreamRate({
      produced,
      accepted,
      streamElapsedMs,
    })
    const staticSamples = new Set(perResize.map((sample) => sample.acceptedEvents)).size <= 1
    const failureReasons = []
    if (perResize.length !== resizeCount)
      failureReasons.push(`only ${perResize.length}/${resizeCount} resizes completed`)
    if (!Number.isFinite(streamElapsedMs) || streamElapsedMs <= 0)
      failureReasons.push(
        'the stream interval did not span generated input through the final resize frame',
      )
    if (produced < rate.minimumExpectedEvents)
      failureReasons.push(
        `only ${produced} events offered; expected at least ${rate.minimumExpectedEvents} at 100 events/s`,
      )
    if (accepted < rate.minimumExpectedEvents)
      failureReasons.push(
        `only ${accepted} events accepted; expected at least ${rate.minimumExpectedEvents} at 100 events/s`,
      )
    if (!rate.passed)
      failureReasons.push(
        `accepted stream rate ${rate.acceptedEventsPerSecond.toFixed(2)} events/s is below 100`,
      )
    if (duplicateEvents !== 0)
      failureReasons.push(`found ${duplicateEvents} duplicate stream events`)
    if (duplicateProviderEventIds !== 0)
      failureReasons.push(`found ${duplicateProviderEventIds} duplicate provider event IDs`)
    if (missingEvents !== 0) failureReasons.push(`found ${missingEvents} missing stream events`)
    if (unexpectedEvents !== 0)
      failureReasons.push(`found ${unexpectedEvents} unexpected stream event markers`)
    if (perResize.some((sample) => !sample.active))
      failureReasons.push('the run was not active for every resize')
    if (staticSamples) failureReasons.push('accepted event count was static during resizing')
    if (perResize.some((sample) => sample.invalidCells !== 0))
      failureReasons.push('invalid terminal cells were observed')
    return {
      samples: perResize.map((sample) => sample.elapsedMs),
      rawSamples: perResize.map((sample) => ({ ...sample })),
      produced,
      accepted,
      rendered: completedFrames.length,
      renderedResizes: perResize.length,
      elapsedMs: streamElapsedMs,
      streamElapsedMs,
      firstGeneratedAt: generated.firstGeneratedAt,
      lastGeneratedAt: generated.lastGeneratedAt,
      finalResizeFrameCompletedAt: finalResizeFrame?.frameCompletedAt,
      offeredEventsPerSecond: rate.offeredEventsPerSecond,
      acceptedEventsPerSecond: rate.acceptedEventsPerSecond,
      observedEventsPerSecond: rate.observedEventsPerSecond,
      producerEventsPerSecond:
        generated.lastGeneratedAt === undefined || generated.firstGeneratedAt === undefined
          ? Number.NaN
          : produced / ((generated.lastGeneratedAt - generated.firstGeneratedAt) / 1_000),
      intendedEventsPerSecond: 1_000 / eventIntervalMs,
      minimumEventsPerSecond: rate.minimumEventsPerSecond,
      minimumExpectedEvents: rate.minimumExpectedEvents,
      ratePassed: rate.passed,
      duplicateEvents,
      duplicateProviderEventIds,
      missingEvents,
      unexpectedEvents,
      invalidCells: Math.max(...perResize.map((sample) => sample.invalidCells), 0),
      activeDuringEveryResize: perResize.every((sample) => sample.active),
      staticTranscript: staticSamples,
      perResize,
      qualityPassed: failureReasons.length === 0,
      failureReasons,
      stageTimings: {
        resizeCallMs: summarizeStage(resizeCallSamples),
        frameQueueMs: summarizeStage(frameTimings.map((timing) => timing.queueDelayMs)),
        viewProjectionMs: summarizeStage(frameTimings.map((timing) => timing.projectionMs)),
        terminalViewApplyMs: summarizeStage(frameTimings.map((timing) => timing.subscriberMs)),
        piRenderMs: summarizeStage(piRenderSamples),
        terminalFlushMs: summarizeStage(terminalFlushSamples),
        resizeToVisibleMs: summarizeStage(perResize.map((sample) => sample.elapsedMs)),
        combinedUpdatesPerFrame: summarizeStage(frameTimings.map((timing) => timing.queuedUpdates)),
      },
      provenance: {
        packageRoot,
        stream: 'packed Braid application + packed Pi terminal headless path',
        eventReceipt: 'application committed uniquely marked run.text.delta events',
        resizeReceipt:
          'Pi doRender completion followed by xterm flush at each reference size and resize epoch',
        rateInterval: 'first generated stream event through the final resize-bound Pi frame',
        referenceDimensions: REFERENCE_DIMENSIONS.map(([columns, rows]) => `${columns}x${rows}`),
      },
    }
  } finally {
    if (runId && app.state().activeRunId === runId) {
      try {
        const receipt = app.cancel({ operationId: 'op-perf-resize-cleanup', runId })
        await receipt.completion
      } catch {
        // Cleanup is best effort after the measured run has already settled.
      }
    }
    if (terminalStarted) terminalApp.stop()
    await app.close().catch(() => undefined)
  }
}

export { REFERENCE_DIMENSIONS }
