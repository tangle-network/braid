import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { TuiMainScreen } from '@earendil-works/pi-tui'
import { HeadlessTerminal } from './headless-terminal.mjs'
import { loadPackedRuntime } from './packed-runtime.mjs'
import { summarizeStage } from './stage-timings.mjs'

const FIXED_TIME = '2026-08-03T00:00:00.000Z'

function providerEnvelope(runId, sequence) {
  const marker = `perf-event-${String(sequence).padStart(5, '0')}`
  return {
    runId,
    eventId: `event-perf-stream-${sequence}`,
    sequence,
    receivedAt: FIXED_TIME,
    occurredAt: FIXED_TIME,
    event: { type: 'text_delta', text: `${marker} ` },
  }
}

function pendingExecution() {
  return {
    admissionMode: 'sync',
    capabilities: { cancel: true },
    async *streamTurn(input) {
      await new Promise((resolve) => {
        if (input.signal.aborted) {
          resolve()
          return
        }
        input.signal.addEventListener('abort', resolve, { once: true })
      })
    },
    async cancelRun(input) {
      return { operationId: input.operationId, outcome: 'accepted' }
    },
  }
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

export function visibleRuntimeEventSequences(lines) {
  const visible = new Set()
  const text = lines.join('')
  for (const match of text.matchAll(/perf-event-(\d{5})/gu)) {
    visible.add(Number(match[1]))
  }
  return visible
}

async function waitFor(predicate, label, signal, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (signal?.aborted) throw new Error(`Interrupted while waiting for ${label}`)
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await sleep(2)
  }
}

export function evaluateRuntimeEventRate({ count, elapsedMs, minimumEventsPerSecond = 100 }) {
  const achievedEventsPerSecond = count / (elapsedMs / 1_000)
  return {
    achievedEventsPerSecond,
    minimumEventsPerSecond,
    passed:
      Number.isFinite(achievedEventsPerSecond) && achievedEventsPerSecond >= minimumEventsPerSecond,
  }
}

export async function measureRuntimeEventsToFrames({
  packageRoot,
  count = 10_000,
  intervalMs = 10,
  signal,
} = {}) {
  const runtime = await loadPackedRuntime(packageRoot)
  const terminal = new HeadlessTerminal(80, 24)
  const tui = new TuiMainScreen(terminal)
  const app = runtime.index.createBraidApplication({
    execution: pendingExecution(),
    profile: { name: 'Braid performance profile', harness: 'pi' },
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
    workspace: '/performance',
    nextOperationId: (() => {
      let next = 0
      return () => `op-perf-ui-${++next}`
    })(),
    onFrameTiming: (timing) => frameTimings.push(timing),
  })
  app.initialize('/performance')

  const pending = []
  const samplesBySequence = new Map()
  const completedFrames = []
  const ingestSamples = []
  const piRenderSamples = []
  const terminalFlushSamples = []
  let latestDeliveredRevision = 0
  const originalDoRender = tui.doRender.bind(tui)
  tui.doRender = () => {
    const renderStartedAt = performance.now()
    originalDoRender()
    piRenderSamples.push(performance.now() - renderStartedAt)
    const flushStartedAt = performance.now()
    void terminal.flush().then(() => {
      const completedAt = performance.now()
      terminalFlushSamples.push(completedAt - flushStartedAt)
      const visibleSequences = visibleRuntimeEventSequences(terminal.getViewport())
      const visibleSequence = Math.max(0, ...visibleSequences)
      const timing = frameTimings.at(-1)
      if (timing?.revision !== undefined) latestDeliveredRevision = timing.revision
      let resolved = 0
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const event = pending[index]
        if (!visibleSequences.has(event.sequence)) continue
        samplesBySequence.set(event.sequence, completedAt - event.receivedAt)
        pending.splice(index, 1)
        resolved += 1
      }
      completedFrames.push({
        revision: latestDeliveredRevision,
        visibleSequence,
        visibleEvents: visibleSequences.size,
        completedAt,
        resolved,
        invalidCells: invalidCellCount(terminal),
      })
    })
  }

  let producer
  let runId
  let terminalStarted = false
  try {
    void terminalApp.start()
    terminalStarted = true
    await terminal.flush()
    const receipt = app.send({ operationId: 'op-perf-stream-start', text: 'performance stream' })
    await receipt.admissionReady
    runId = receipt.runId
    await sleep(20)

    let producerError
    let nextSequence = 1
    let startedAt
    producer = setInterval(() => {
      if (signal?.aborted) {
        producerError = new Error('Interrupted during PERF-04 event production')
        clearInterval(producer)
        return
      }
      if (nextSequence > count) return
      const sequence = nextSequence
      nextSequence += 1
      try {
        const receivedAt = performance.now()
        startedAt ??= receivedAt
        const result = app.ingestRuntimeEvent(providerEnvelope(runId, sequence))
        ingestSamples.push(performance.now() - receivedAt)
        if (result && typeof result.then === 'function')
          throw new Error('PERF-04 smoke path unexpectedly became asynchronous')
        if (result.accepted !== true)
          throw new Error(`PERF-04 event ${sequence} was not accepted by the application`)
        pending.push({
          sequence,
          receivedAt,
        })
      } catch (error) {
        producerError = error
        clearInterval(producer)
      }
      if (sequence === count) clearInterval(producer)
    }, intervalMs)
    while (nextSequence <= count) {
      if (producerError) throw producerError
      if (signal?.aborted) throw new Error('Interrupted during PERF-04 event production')
      await sleep(5)
    }
    clearInterval(producer)
    producer = undefined
    await waitFor(
      () => samplesBySequence.has(count),
      'PERF-04 final event-tagged Pi render completion',
      signal,
    )
    await terminal.flush()
    const elapsedMs = performance.now() - startedAt
    const rate = evaluateRuntimeEventRate({ count, elapsedMs })

    const results = app.events().filter((envelope) => envelope.event.kind === 'run.text.delta')
    const eventIds = results.map((envelope) => envelope.event.provider?.eventId)
    const uniqueEventIds = new Set(eventIds)
    const invalidCells = completedFrames.reduce(
      (maximum, frame) => Math.max(maximum, frame.invalidCells),
      0,
    )
    const samples = Array.from({ length: count }, (_, index) =>
      samplesBySequence.get(index + 1),
    ).filter((sample) => sample !== undefined)
    const accepted = results.length
    const duplicateEvents = eventIds.length - uniqueEventIds.size
    const missingEvents = count - samples.length
    const failureReasons = []
    if (accepted !== count) failureReasons.push(`accepted ${accepted}/${count} events`)
    if (duplicateEvents !== 0)
      failureReasons.push(`found ${duplicateEvents} duplicate event identifiers`)
    if (missingEvents !== 0) failureReasons.push(`found ${missingEvents} unrendered events`)
    if (invalidCells !== 0) failureReasons.push(`found ${invalidCells} invalid terminal cells`)
    if (!rate.passed)
      failureReasons.push(
        `achieved ${rate.achievedEventsPerSecond.toFixed(2)} events/s, below ${rate.minimumEventsPerSecond}`,
      )

    const cancel = await app.cancel({ operationId: 'op-perf-stream-cancel', runId })
    await cancel.completion
    return {
      samples,
      rawSamples: samples,
      rawEventCount: count,
      accepted,
      duplicateEvents,
      missingEvents,
      invalidCells,
      uniqueProviderEventIds: uniqueEventIds.size,
      renderedEvents: samples.length,
      frameCompletions: completedFrames.length,
      frameWrites: completedFrames.length,
      maxRenderedRevision: Math.max(...completedFrames.map((frame) => frame.revision)),
      elapsedMs,
      achievedEventsPerSecond: rate.achievedEventsPerSecond,
      minimumEventsPerSecond: rate.minimumEventsPerSecond,
      finalFrameCompleted: true,
      qualityPassed: failureReasons.length === 0,
      failureReasons,
      stageTimings: {
        applicationCommitMs: summarizeStage(ingestSamples),
        frameQueueMs: summarizeStage(frameTimings.map((timing) => timing.queueDelayMs)),
        viewProjectionMs: summarizeStage(frameTimings.map((timing) => timing.projectionMs)),
        terminalViewApplyMs: summarizeStage(frameTimings.map((timing) => timing.subscriberMs)),
        piRenderMs: summarizeStage(piRenderSamples),
        terminalFlushMs: summarizeStage(terminalFlushSamples),
        combinedUpdatesPerFrame: summarizeStage(frameTimings.map((timing) => timing.queuedUpdates)),
      },
      provenance: {
        packageRoot,
        frameBinding: 'Pi TUI doRender completion + xterm flush + each exact visible event marker',
        unrelatedWritesExcluded: true,
        rateInterval: 'producer start through the final event matching Pi frame completion',
      },
    }
  } finally {
    if (producer) clearInterval(producer)
    if (runId && app.state().activeRunId === runId) {
      try {
        const receipt = app.cancel({ operationId: 'op-perf-stream-cleanup', runId })
        await receipt.completion
      } catch {
        // Cleanup is best effort after the measured run has already settled.
      }
    }
    if (terminalStarted) terminalApp.stop()
    await app.close().catch(() => undefined)
  }
}
