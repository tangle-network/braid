import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import type { AnalystRegistry, RunRecord } from '@tangle-network/agent-eval'
import {
  AnalysisService,
  EncryptedAnalysisRepository,
  EncryptedBraidStatePort,
  InMemoryAnalysisRepository,
  InMemoryAnalysisSourcePort,
  InMemoryTraceAnalysisStore,
  MemoryStateKeyPort,
  type AnalysisState,
  type AnalysisSourceBinding,
  type AnalysisSourceRecord,
} from '../src/index.js'
import {
  W11_SEMANTIC_CASES,
  W11_TRACE_SPANS,
  W11_UNIT_FIXTURE_RUN_RECORDS,
} from '../src/evaluation/w11-cases.js'
import { createW11FixtureAnalystRegistry } from '../src/analysis/analysts.js'
import { AnalysisServiceError } from '../src/analysis/service.js'
import {
  ANALYSIS_LIMITS,
  AnalysisLimitError,
  boundedCloneAndFreeze,
} from '../src/analysis/bounded-copy.js'
import { FrozenTraceStore } from '../src/analysis/frozen-trace-store.js'
import { comparePairedSources, type ComparisonArmBinding } from '../src/analysis/comparison.js'
import {
  evaluateApplicationAnalysis,
  type ApplicationEvaluationInput,
} from '../src/app/evaluation-route.js'
import { applicationAnalysisBinding } from '../src/app/analysis-source.js'
import { createBraidApplication } from '../src/app/composition.js'
import { ApplicationComparisonService } from '../src/app/application-comparison.js'
import { ApplicationReceiptService } from '../src/app/application-receipts.js'
import { ApplicationSupervisorService } from '../src/app/application-supervisor.js'
import {
  linesOf,
  parseJsonLine,
  RpcOutputQueue,
  RPC_MAX_LINE_BYTES,
} from '../src/views/headless/jsonl.js'
import { runRpc } from '../src/views/headless/rpc.js'
import type { RuntimeSupervisorPort } from '../src/supervisor/runtime-supervisor.js'

interface ProcessResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

function runAnalysisProcess(
  mode: 'reserve' | 'crash-temp',
  statePath: string,
  ownerId = 'owner-process',
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(process.cwd(), '.test-dist/test/support/analysis-process-worker.js'),
        mode,
        statePath,
        ownerId,
      ],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

function sourceBinding(overrides: Partial<AnalysisSourceRecord> = {}): AnalysisSourceBinding {
  const traceStore = new InMemoryTraceAnalysisStore([
    {
      traceId: 'trace-w11-1',
      spans: W11_TRACE_SPANS.filter((span) => span.trace_id === 'trace-w11-1'),
    },
    {
      traceId: 'trace-w11-2',
      spans: W11_TRACE_SPANS.filter((span) => span.trace_id === 'trace-w11-2'),
    },
  ])
  const source: AnalysisSourceRecord = {
    sourceId: 'source-w11',
    sourceRevision: 'revision-1',
    conversationId: 'conversation-w11',
    branchId: 'branch-w11',
    runId: 'run-w11',
    profileDigest: `sha256:${'a'.repeat(64)}`,
    runner: 'fixture-runner',
    model: 'fixture-model',
    connection: 'fixture-connection',
    eventIds: ['event-1', 'event-2'],
    traceReferences: [
      { traceId: 'trace-w11-1', spanIds: ['span-w11-agent', 'span-w11-tool'] },
      { traceId: 'trace-w11-2', spanIds: ['span-w11-error'] },
    ],
    eventReferences: [
      { eventId: 'event-1', kind: 'run.started' },
      { eventId: 'event-2', kind: 'run.finished' },
    ],
    metrics: { wall_ms: 100 },
    artifactUris: [],
    capturedAt: '2026-01-01T00:00:00.000Z',
    complete: true,
    runtime: 'agent-runtime',
    receiptId: 'receipt-w11',
    ...overrides,
  }
  return {
    source,
    traceStore,
    currentRevision: async () => source.sourceRevision,
    captureAtRevision: async () => ({ source, traceStore: traceStore.snapshot() }),
  }
}

function badCompletionRegistry(): AnalystRegistry {
  const result = {
    completion: { status: 'complete' },
    per_analyst: [{ analyst_id: 'braid.ask', status: 'failed', usage: {}, latency_ms: 1 }],
    findings: [],
  }
  return {
    list: () => [{ id: 'braid.ask' }],
    async *runExactStream() {
      yield { type: 'run-completed', result }
    },
  } as unknown as AnalystRegistry
}

test('contradictory source and analyst completion states cannot become complete', async () => {
  const incomplete = new AnalysisService({
    source: new InMemoryAnalysisSourcePort([
      sourceBinding({ missingEventIds: ['event-late'], complete: true }),
    ]),
    repository: new InMemoryAnalysisRepository(),
    registry: createW11FixtureAnalystRegistry(),
  })
  const partial = await incomplete.run({
    operationId: 'op-incomplete',
    analysisId: 'analysis-incomplete',
    sourceId: 'source-w11',
    kind: 'ask',
  })
  assert.equal(partial.status, 'partial')
  assert.equal(partial.error?.code, 'SOURCE_INCOMPLETE')

  const failedAnalyst = new AnalysisService({
    source: new InMemoryAnalysisSourcePort([sourceBinding()]),
    repository: new InMemoryAnalysisRepository(),
    registry: badCompletionRegistry(),
  })
  const failed = await failedAnalyst.run({
    operationId: 'op-analyst-failed',
    analysisId: 'analysis-analyst-failed',
    sourceId: 'source-w11',
    kind: 'ask',
  })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error?.code, 'ANALYST_FAILED')
})

test('application source freezes journal ranges and only referenced trace spans', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  await app.send({ operationId: 'source-run-op', text: 'capture' }).completion
  const binding = applicationAnalysisBinding(
    () => app.state(),
    () => app.events(),
    () => app.analysisTraces(),
    () => app.state().runs.at(-1)?.id,
  )
  const captured = await binding.captureAtRevision()
  assert.notEqual(captured.source.sourceId, 'source-latest')
  const runStart = app.events().findIndex((event) => event.event.kind === 'run.requested')
  assert.deepEqual(
    captured.source.eventIds,
    app
      .events()
      .slice(runStart)
      .map((event) => event.eventId),
  )
  assert.ok(captured.source.traceReferences[0]?.spanIds.length)
  assert.ok(captured.traceStore)
  const frozen = await new InMemoryAnalysisSourcePort([binding]).freeze(captured.source.sourceId)
  const trace = await frozen.traceStore.viewTrace({
    trace_id: frozen.source.traceReferences[0]?.traceId ?? '',
  })
  if (!trace.spans) assert.fail('frozen trace did not return spans')
  const spans = trace.spans
  assert.equal(spans.length, frozen.source.traceReferences[0]?.spanIds.length)
  assert.ok(spans.every((span) => span.duration_ms > 0))
  assert.throws(() => {
    ;(spans[0] as { name: string }).name = 'mutated'
  }, TypeError)
})

test('application source does not invent event identities when the journal omits one', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  await app.send({ operationId: 'source-missing-id-op', text: 'capture' }).completion
  const binding = applicationAnalysisBinding(
    () => app.state(),
    () => app.events().map(({ eventId: _eventId, ...envelope }) => envelope),
    () => app.analysisTraces(),
    () => app.state().runs.at(-1)?.id,
  )
  const captured = await binding.captureAtRevision()
  assert.equal(captured.source.complete, false)
  assert.equal(captured.source.completeness, 'unknown')
  assert.equal(
    captured.source.eventIds.some((id) => id.startsWith('event-')),
    false,
  )
})

test('application analysis freezes the explicitly selected historical run revision', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const first = app.send({ operationId: 'source-first-op', text: 'first' })
  await first.completion
  const second = app.send({ operationId: 'source-second-op', text: 'second' })
  const binding = applicationAnalysisBinding(
    () => app.state(),
    () => app.events(),
    () => app.analysisTraces(),
    () => first.runId,
  )
  const captured = await binding.captureAtRevision()
  await second.completion
  const finished = app
    .events()
    .find(
      (envelope) => envelope.event.kind === 'run.finished' && envelope.event.runId === first.runId,
    )
  if (!finished) assert.fail('missing first run completion')
  assert.equal(captured.source.runId, first.runId)
  assert.equal(captured.source.model, app.state().runs.find((run) => run.id === first.runId)?.model)
  assert.equal(captured.source.sourceRevision, String(finished?.revision))
  assert.equal(
    captured.source.eventIds.length,
    app
      .events()
      .filter((envelope) => 'runId' in envelope.event && envelope.event.runId === first.runId)
      .length,
  )
  const frozen = await new InMemoryAnalysisSourcePort([binding]).freeze(captured.source.sourceId)
  assert.equal(frozen.source.runId, first.runId)
  assert.equal(frozen.source.sourceRevision, String(finished?.revision))
})

test('operation authority replays one cancellation and protects graph snapshots', async () => {
  const app = createBraidApplication({ fixture: 'deterministic', chunkDelayMs: 30 })
  app.initialize('/workspace')
  const run = app.send({ operationId: 'cancel-run-op', text: 'cancel' })
  const first = app.cancelRun({ operationId: 'cancel-once', runId: run.runId, reason: 'stop' })
  const second = app.cancelRun({ operationId: 'cancel-once', runId: run.runId, reason: 'stop' })
  await run.completion
  assert.equal(first.status, 'accepted')
  assert.equal(second.status, 'replayed')
  assert.equal(app.events().filter((event) => event.event.kind === 'operation.receipt').length, 1)
  const graph = app.graph()
  const before = graph.digest
  assert.throws(() => {
    const node = graph.nodes.find((item) => item.kind === 'run')
    if (node) (node.data as { status: string }).status = 'changed'
  }, TypeError)
  assert.equal(app.graph().digest, before)
})

test('application comparison does not invent an empty result without frozen rows', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  await assert.rejects(
    app.compareSources({
      operationId: 'compare-empty-op',
      baselineSourceId: 'baseline',
      treatmentSourceId: 'treatment',
    }),
    /explicit frozen run rows/u,
  )
})

test('application comparison replays one exact receipt for concurrent callers', async () => {
  const baseline = W11_UNIT_FIXTURE_RUN_RECORDS.find((row) => row.candidateId === 'baseline')
  const treatment = W11_UNIT_FIXTURE_RUN_RECORDS.find((row) => row.candidateId === 'treatment')
  if (!baseline || !treatment) assert.fail('missing comparison fixtures')
  const source = new InMemoryAnalysisSourcePort([
    sourceBinding({
      sourceId: 'application-baseline-source',
      runId: baseline.runId,
      model: baseline.model,
      experimentId: baseline.experimentId,
      arm: 'baseline',
      receiptId: 'application-baseline-receipt',
    }),
    sourceBinding({
      sourceId: 'application-treatment-source',
      runId: treatment.runId,
      model: treatment.model,
      experimentId: treatment.experimentId,
      arm: 'treatment',
      receiptId: 'application-treatment-receipt',
    }),
  ])
  const baselineFrozen = await source.freeze('application-baseline-source')
  const treatmentFrozen = await source.freeze('application-treatment-source')
  const input = {
    operationId: 'application-compare-op',
    baselineSourceId: 'application-baseline-source',
    treatmentSourceId: 'application-treatment-source',
    baselineRuns: [baseline],
    treatmentRuns: [treatment],
    baselineBinding: {
      experimentId: baseline.experimentId,
      arm: 'baseline' as const,
      sourceDigest: baselineFrozen.source.digest,
      sourceRunId: baseline.runId,
      profileDigest: baselineFrozen.source.profileDigest,
      model: baseline.model,
      receiptId: baselineFrozen.source.receiptId ?? '',
    },
    treatmentBinding: {
      experimentId: treatment.experimentId,
      arm: 'treatment' as const,
      sourceDigest: treatmentFrozen.source.digest,
      sourceRunId: treatment.runId,
      profileDigest: treatmentFrozen.source.profileDigest,
      model: treatment.model,
      receiptId: treatmentFrozen.source.receiptId ?? '',
    },
  }
  const app = createBraidApplication({ fixture: 'deterministic', analysisSource: source })
  const [first, second] = await Promise.all([app.compare(input), app.compare(input)])
  assert.equal(first.replayed, false)
  assert.equal(second.replayed, true)
  assert.equal(first.receiptId, second.receiptId)
  assert.equal(app.events().filter((event) => event.event.kind === 'operation.receipt').length, 1)
})

test('application worker cancellation replays one exact receipt', async () => {
  let calls = 0
  const supervisor = {
    async cancel(command: {
      readonly operationId: string
      readonly supervisorId: string
      readonly runId: string
      readonly workerId?: string
      readonly reason: string
    }) {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return {
        operationId: command.operationId,
        supervisorId: command.supervisorId,
        runId: command.runId,
        ...(command.workerId ? { workerId: command.workerId } : {}),
        status: 'accepted' as const,
        effect: 'requested' as const,
      }
    },
  } as unknown as RuntimeSupervisorPort
  const app = createBraidApplication({ fixture: 'deterministic', supervisor })
  const command = {
    operationId: 'cancel-worker-op',
    supervisorId: 'supervisor-1',
    runId: 'run-1',
    workerId: 'worker-1',
    reason: 'stop',
  }
  const [first, second] = await Promise.all([app.cancelWorker(command), app.cancelWorker(command)])
  assert.equal(calls, 1)
  assert.equal(first.replayed, false)
  assert.equal(second.replayed, true)
  assert.equal(first.receiptId, second.receiptId)
  assert.equal(app.events().filter((event) => event.event.kind === 'operation.receipt').length, 1)
})

test('worker cancellation rejects a receipt with a foreign identity', async () => {
  const supervisor = {
    async cancel() {
      return {
        operationId: 'foreign-operation',
        supervisorId: 'supervisor-1',
        runId: 'run-1',
        workerId: 'worker-1',
        status: 'accepted' as const,
        effect: 'requested' as const,
      }
    },
  } as unknown as RuntimeSupervisorPort
  const cancellation = new ApplicationSupervisorService({
    supervisor,
    receipts: new ApplicationReceiptService({ commitReceipt: () => {} }),
  })
  await assert.rejects(
    cancellation.cancelWorker({
      operationId: 'cancel-foreign-operation',
      supervisorId: 'supervisor-1',
      runId: 'run-1',
      workerId: 'worker-1',
      reason: 'stop',
    }),
    /mismatched identity/u,
  )
})

test('application operation receipts replay without rereading a lost capability', async () => {
  let supervisor: RuntimeSupervisorPort | undefined = {
    async cancel(command: Parameters<RuntimeSupervisorPort['cancel']>[0]) {
      return {
        operationId: command.operationId,
        supervisorId: command.supervisorId,
        runId: command.runId,
        ...(command.workerId ? { workerId: command.workerId } : {}),
        status: 'accepted' as const,
        effect: 'requested' as const,
      }
    },
  } as unknown as RuntimeSupervisorPort
  const receipts = new ApplicationReceiptService({ commitReceipt: () => {} })
  const cancellation = new ApplicationSupervisorService({ supervisor, receipts })
  const command = {
    operationId: 'replay-without-capability',
    supervisorId: 'supervisor-replay',
    runId: 'run-replay',
    reason: 'stop',
  }
  const accepted = await cancellation.cancelWorker(command)
  supervisor = undefined
  const replayed = await cancellation.cancelWorker(command)
  assert.equal(accepted.receiptId, replayed.receiptId)
  assert.equal(replayed.replayed, true)

  const baseline = W11_UNIT_FIXTURE_RUN_RECORDS.find((row) => row.candidateId === 'baseline')
  const treatment = W11_UNIT_FIXTURE_RUN_RECORDS.find((row) => row.candidateId === 'treatment')
  if (!baseline || !treatment) assert.fail('missing comparison fixtures')
  let source: InMemoryAnalysisSourcePort | undefined = new InMemoryAnalysisSourcePort([
    sourceBinding({
      sourceId: 'replay-baseline',
      runId: baseline.runId,
      model: baseline.model,
      experimentId: baseline.experimentId,
      arm: 'baseline',
      receiptId: 'replay-baseline',
    }),
    sourceBinding({
      sourceId: 'replay-treatment',
      runId: treatment.runId,
      model: treatment.model,
      experimentId: treatment.experimentId,
      arm: 'treatment',
      receiptId: 'replay-treatment',
    }),
  ])
  const baselineFrozen = await source.freeze('replay-baseline')
  const treatmentFrozen = await source.freeze('replay-treatment')
  const comparison = new ApplicationComparisonService({
    readAnalysisSource: () => source,
    receipts: new ApplicationReceiptService({ commitReceipt: () => {} }),
  })
  const input = {
    operationId: 'comparison-replay-without-capability',
    baselineSourceId: 'replay-baseline',
    treatmentSourceId: 'replay-treatment',
    baselineRuns: [baseline],
    treatmentRuns: [treatment],
    baselineBinding: {
      experimentId: baseline.experimentId,
      arm: 'baseline' as const,
      sourceDigest: baselineFrozen.source.digest,
      sourceRunId: baseline.runId,
      profileDigest: baselineFrozen.source.profileDigest,
      model: baseline.model,
      receiptId: baselineFrozen.source.receiptId ?? '',
    },
    treatmentBinding: {
      experimentId: treatment.experimentId,
      arm: 'treatment' as const,
      sourceDigest: treatmentFrozen.source.digest,
      sourceRunId: treatment.runId,
      profileDigest: treatmentFrozen.source.profileDigest,
      model: treatment.model,
      receiptId: treatmentFrozen.source.receiptId ?? '',
    },
  }
  const compared = await comparison.compare(input)
  source = undefined
  const comparedAgain = await comparison.compare(input)
  assert.equal(compared.receiptId, comparedAgain.receiptId)
  assert.equal(comparedAgain.replayed, true)
})

test('frozen trace data and deep copies enforce bounded hostile input', async () => {
  const first = W11_TRACE_SPANS[0]
  if (!first) assert.fail('missing fixture span')
  const privateSpan = { ...first, span_id: 'private-span' }
  const store = new InMemoryTraceAnalysisStore([
    { traceId: first.trace_id, spans: [first, privateSpan] },
  ])
  const source = sourceBinding({
    traceReferences: [{ traceId: first.trace_id, spanIds: [first.span_id] }],
  })
  const frozen = await new InMemoryAnalysisSourcePort([{ ...source, traceStore: store }]).freeze(
    'source-w11',
  )
  const spans = await frozen.traceStore.viewSpans({
    trace_id: first.trace_id,
    span_ids: [first.span_id],
  })
  assert.deepEqual(
    spans.spans.map((span) => span.span_id),
    [first.span_id],
  )
  assert.throws(() => {
    ;(spans.spans[0]?.attributes as Record<string, unknown>).evil = true
  }, TypeError)
  assert.throws(() => {
    let value: Record<string, unknown> = {}
    for (let index = 0; index < 15_000; index += 1) value = { next: value }
    boundedCloneAndFreeze(value)
  }, AnalysisLimitError)
  assert.throws(
    () =>
      new FrozenTraceStore([
        {
          traceId: 't',
          spans: Array.from({ length: ANALYSIS_LIMITS.maxSpans + 1 }, () => first),
        },
      ]),
    /span count/u,
  )
  assert.throws(
    () =>
      new FrozenTraceStore([
        { traceId: 'x'.repeat(ANALYSIS_LIMITS.maxStringBytes + 1), spans: [] },
      ]),
    /identity exceeds/u,
  )
  const direct = new FrozenTraceStore([
    { traceId: 'direct', spans: [{ ...first, trace_id: 'direct' }] },
  ])
  await assert.rejects(
    direct.searchTrace({
      trace_id: 'x'.repeat(ANALYSIS_LIMITS.maxStringBytes + 1),
      regex_pattern: 'agent',
    }),
    /identity exceeds/u,
  )
  await assert.rejects(
    direct.searchSpan({
      trace_id: 'direct',
      span_id: 'x'.repeat(ANALYSIS_LIMITS.maxStringBytes + 1),
      regex_pattern: 'agent',
    }),
    /span identity exceeds/u,
  )
  assert.throws(
    () =>
      new FrozenTraceStore(
        Array.from({ length: 65 }, (_, index) => ({
          traceId: `${'x'.repeat(ANALYSIS_LIMITS.maxStringBytes - 5)}${String(index).padStart(3, '0')}`,
          spans: [],
        })),
      ),
    /bytes exceed/u,
  )
})

test('diagnostics never persist a bearer canary', () => {
  const error = new AnalysisServiceError('ANALYST_FAILED', 'Bearer CANARY-SECRET-1234')
  assert.doesNotMatch(JSON.stringify(error), /CANARY-SECRET-1234/u)
  assert.doesNotMatch(JSON.stringify({ message: error.message }), /CANARY-SECRET-1234/u)
})

test('analyst bearer diagnostics stay out of persisted records and RPC output', async () => {
  const source = new InMemoryAnalysisSourcePort([sourceBinding()])
  const repository = new InMemoryAnalysisRepository()
  const registry = {
    list: () => [{ id: 'braid.ask' }],
    runExactStream: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw new Error('Bearer CANARY-SECRET-1234')
        },
      }),
    }),
  } as unknown as AnalystRegistry
  const app = createBraidApplication({
    fixture: 'deterministic',
    analysis: new AnalysisService({ source, repository, registry }),
    analysisSource: source,
    analysisSourceId: () => 'source-w11',
  })
  const output: string[] = []
  const code = await runRpc(
    app,
    {
      async *[Symbol.asyncIterator]() {
        yield `${JSON.stringify({ version: 1, requestId: 'secret-init', command: 'initialize', params: { workspace: '/workspace' } })}\n`
        yield `${JSON.stringify({ version: 1, requestId: 'secret-analysis', operationId: 'secret-analysis-op', command: 'analysis', params: { text: '/ask why' } })}\n`
        yield `${JSON.stringify({ version: 1, requestId: 'secret-stop', command: 'shutdown' })}\n`
      },
    },
    {
      write: (chunk) => {
        output.push(chunk)
        return true
      },
    },
  )
  assert.equal(code, 1)
  assert.doesNotMatch(
    JSON.stringify({ output, events: app.events(), records: await repository.list() }),
    /CANARY-SECRET-1234/u,
  )
})

test('JSONL rejects hostile bytes and depth, preserves own prototype-sensitive keys, and fails closed on backpressure', async () => {
  async function* oversized(): AsyncGenerator<Uint8Array> {
    yield new Uint8Array(1_048_577).fill(0x20)
    yield new Uint8Array([0x0a])
  }
  await assert.rejects(linesOf(oversized()).next(), /line exceeds/u)
  async function* oversizedText(): AsyncGenerator<string> {
    yield 'x'.repeat(RPC_MAX_LINE_BYTES + 1)
    yield '\n'
  }
  await assert.rejects(linesOf(oversizedText()).next(), /line exceeds/u)
  const unicodeLines = linesOf({
    async *[Symbol.asyncIterator]() {
      yield '{"text":"🙂"}\n'
    },
  })
  assert.equal((await unicodeLines.next()).value, '{"text":"🙂"}')
  assert.throws(
    () => parseJsonLine(`[${'['.repeat(15_000)}${']'.repeat(15_001)}`),
    /nesting is too deep/u,
  )
  assert.throws(
    () => parseJsonLine(`{"${'x'.repeat(65_537)}":true}`),
    /string exceeds its byte limit/u,
  )
  const value = parseJsonLine('{"__proto__":{"own":true}}') as Record<string, unknown>
  assert.equal(Object.getPrototypeOf(value), null)
  assert.equal(Object.hasOwn(value, '__proto__'), true)

  const app = createBraidApplication({ fixture: 'deterministic' })
  const input = {
    async *[Symbol.asyncIterator]() {
      yield `${JSON.stringify({ version: 1, requestId: 'init', command: 'initialize', params: { workspace: '/w' } })}\n`
    },
  }
  const code = await runRpc(app, input, { write: () => false })
  assert.equal(code, 1)

  let drainEvents = 0
  const drained = new RpcOutputQueue({
    write: () => false,
    once: (_event, listener) => {
      drainEvents += 1
      queueMicrotask(listener)
    },
  })
  drained.enqueue('response\n')
  await drained.flush()
  assert.equal(drainEvents, 1)
})

test('state recovery chooses the highest valid revision and rejects symlinks', async () => {
  const directory = await mkdtemp('/tmp/braid-w11-repair-state-')
  const path = join(directory, 'state.enc')
  const port = new EncryptedBraidStatePort(path, new MemoryStateKeyPort(new Uint8Array(32).fill(8)))
  await port.commit(0, { value: 'one' })
  const revisionOne = await readFile(path)
  await port.commit(1, { value: 'two' })
  const revisionTwo = await readFile(path)
  await writeFile(path, revisionOne, { mode: 0o600 })
  await writeFile(`${path}.tmp`, revisionTwo, { mode: 0o600 })
  assert.equal((await port.read())?.revision, 2)
  const tampered = JSON.parse(revisionTwo.toString('utf8')) as { revision: number }
  tampered.revision = 99
  await writeFile(path, JSON.stringify(tampered), { mode: 0o600 })
  await rm(`${path}.tmp`)
  assert.equal((await port.read())?.revision, 1)
  await rm(path)
  await symlink(join(directory, 'outside'), path)
  await assert.rejects(port.read(), /symlink/u)
  await rm(directory, { recursive: true, force: true })
})

test('cross-process analysis leases preserve the owner terminal result', async () => {
  const directory = await mkdtemp('/tmp/braid-w11-owner-')
  const path = join(directory, 'analysis.enc')
  const key = new MemoryStateKeyPort(new Uint8Array(32).fill(12))
  const firstRepository = new EncryptedAnalysisRepository(new EncryptedBraidStatePort(path, key))
  const secondRepository = new EncryptedAnalysisRepository(new EncryptedBraidStatePort(path, key))
  const baseRegistry = createW11FixtureAnalystRegistry()
  let entered!: () => void
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve
  })
  const slowRegistry = {
    list: () => baseRegistry.list(),
    runExactStream: (
      runId: Parameters<AnalystRegistry['runExactStream']>[0],
      inputs: Parameters<AnalystRegistry['runExactStream']>[1],
      options: Parameters<AnalystRegistry['runExactStream']>[2],
    ) =>
      (async function* () {
        entered()
        await new Promise((resolve) => setTimeout(resolve, 25))
        yield* baseRegistry.runExactStream(runId, inputs, options)
      })(),
  } as unknown as AnalystRegistry
  const request = {
    operationId: 'cross-process-analysis-op',
    analysisId: 'cross-process-analysis',
    sourceId: 'source-w11',
    kind: 'ask' as const,
  }
  const first = new AnalysisService({
    source: new InMemoryAnalysisSourcePort([sourceBinding()]),
    repository: firstRepository,
    registry: slowRegistry,
    ownerId: 'owner-a',
    leaseMs: 60_000,
  })
  const second = new AnalysisService({
    source: new InMemoryAnalysisSourcePort([sourceBinding()]),
    repository: secondRepository,
    registry: slowRegistry,
    ownerId: 'owner-b',
    leaseMs: 60_000,
  })
  const firstPromise = first.run(request)
  await enteredPromise
  const secondResult = await second.run(request)
  const firstResult = await firstPromise
  assert.equal(firstResult.status, 'complete')
  assert.equal(secondResult.status, 'unknown')
  const operation = await secondRepository.getOperation(request.operationId)
  assert.equal(operation?.status, 'terminal')
  assert.equal((operation?.result as { readonly status?: string } | undefined)?.status, 'complete')
  assert.equal((await secondRepository.get(request.analysisId))?.status, 'complete')
})

test('real processes serialize reservations and recover after a forced crash', async () => {
  const directory = await mkdtemp('/tmp/braid-w11-real-process-')
  try {
    const path = join(directory, 'analysis.enc')
    const [first, second] = await Promise.all([
      runAnalysisProcess('reserve', path, 'owner-process-a'),
      runAnalysisProcess('reserve', path, 'owner-process-b'),
    ])
    assert.equal(first.code, 0)
    assert.equal(second.code, 0)
    const reservations = [JSON.parse(first.stdout), JSON.parse(second.stdout)] as const
    assert.equal(reservations.filter((result) => result.created).length, 1)
    assert.equal(reservations.filter((result) => !result.created).length, 1)
    const crashed = await runAnalysisProcess('crash-temp', path)
    assert.equal(crashed.signal, 'SIGKILL')
    const recovered = await new EncryptedBraidStatePort<AnalysisState>(
      path,
      new MemoryStateKeyPort(new Uint8Array(32).fill(21)),
    ).read()
    assert.equal(recovered?.revision, 1)
    assert.equal(recovered?.state.operations.length, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('an expired owner cannot replace a takeover terminal state', async () => {
  const repository = new InMemoryAnalysisRepository()
  await repository.reserve({
    operationId: 'lease-operation',
    kind: 'analysis',
    targetId: 'lease-analysis',
    requestDigest: 'sha256:lease-request',
    ownerId: 'owner-a',
    leaseUntil: '2026-01-01T00:00:01.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
  const takeover = await repository.reserve({
    operationId: 'lease-operation',
    kind: 'analysis',
    targetId: 'lease-analysis',
    requestDigest: 'sha256:lease-request',
    ownerId: 'owner-b',
    leaseUntil: '2026-01-01T00:01:00.000Z',
    updatedAt: '2026-01-01T00:00:02.000Z',
  })
  assert.equal(takeover.created, true)
  await assert.rejects(
    repository.complete(
      'lease-operation',
      'sha256:lease-request',
      { status: 'complete' },
      '2026-01-01T00:00:03.000Z',
      'owner-a',
    ),
    /ownership was lost/u,
  )
  await repository.complete(
    'lease-operation',
    'sha256:lease-request',
    { status: 'complete' },
    '2026-01-01T00:00:03.000Z',
    'owner-b',
  )
  assert.equal((await repository.getOperation('lease-operation'))?.status, 'terminal')
})

test('a foreign digest cannot reclaim an expired analysis lease', async () => {
  const directory = await mkdtemp('/tmp/braid-w11-digest-lease-')
  try {
    const repositories = [
      new InMemoryAnalysisRepository(),
      new EncryptedAnalysisRepository(
        new EncryptedBraidStatePort(
          join(directory, 'analysis.enc'),
          new MemoryStateKeyPort(new Uint8Array(32).fill(17)),
        ),
      ),
    ]
    for (const repository of repositories) {
      await repository.reserve({
        operationId: 'lease-digest-operation',
        kind: 'analysis',
        targetId: 'lease-digest-analysis',
        requestDigest: 'sha256:request-a',
        ownerId: 'owner-a',
        leaseUntil: '2026-01-01T00:00:01.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })
      assert.equal(
        await repository.renew(
          'lease-digest-operation',
          'sha256:request-a',
          '2026-01-01T00:00:02.000Z',
          '2026-01-01T00:01:00.000Z',
          'owner-a',
        ),
        false,
      )
      await assert.rejects(
        repository.complete(
          'lease-digest-operation',
          'sha256:request-a',
          { status: 'complete' },
          '2026-01-01T00:00:02.000Z',
          'owner-a',
        ),
        /lease expired/u,
      )
      const result = await repository.reserve({
        operationId: 'lease-digest-operation',
        kind: 'analysis',
        targetId: 'lease-digest-analysis',
        requestDigest: 'sha256:request-b',
        ownerId: 'owner-b',
        leaseUntil: '2026-01-01T00:01:00.000Z',
        updatedAt: '2026-01-01T00:00:02.000Z',
      })
      assert.equal(result.created, false)
      assert.equal(result.reclaimed, undefined)
      assert.equal(result.record.requestDigest, 'sha256:request-a')
      assert.equal(result.record.ownerId, 'owner-a')
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('comparison binds rows to both frozen source identities', async () => {
  const baseline = W11_UNIT_FIXTURE_RUN_RECORDS.find((row) => row.candidateId === 'baseline')
  const treatment = W11_UNIT_FIXTURE_RUN_RECORDS.find((row) => row.candidateId === 'treatment')
  if (!baseline || !treatment) assert.fail('missing comparison fixtures')
  const baselineBinding = sourceBinding({
    sourceId: 'baseline-source',
    runId: baseline.runId,
    model: baseline.model,
    experimentId: baseline.experimentId,
    arm: 'baseline',
    receiptId: 'receipt-baseline',
  })
  const treatmentBinding = sourceBinding({
    sourceId: 'treatment-source',
    runId: treatment.runId,
    model: treatment.model,
    experimentId: treatment.experimentId,
    arm: 'treatment',
    receiptId: 'receipt-treatment',
  })
  const source = new InMemoryAnalysisSourcePort([baselineBinding, treatmentBinding])
  const baselineFrozen = await source.freeze('baseline-source')
  const treatmentFrozen = await source.freeze('treatment-source')
  const binding = (
    frozen: typeof baselineFrozen,
    record: RunRecord,
    arm: ComparisonArmBinding['arm'],
  ): ComparisonArmBinding => ({
    experimentId: record.experimentId,
    arm,
    sourceDigest: frozen.source.digest,
    sourceRunId: record.runId,
    profileDigest: frozen.source.profileDigest,
    model: record.model,
    receiptId: frozen.source.receiptId ?? '',
  })
  const valid = await comparePairedSources({
    source,
    baselineSourceId: 'baseline-source',
    treatmentSourceId: 'treatment-source',
    baselineRuns: [baseline],
    treatmentRuns: [treatment],
    baselineBinding: binding(baselineFrozen, baseline, 'baseline'),
    treatmentBinding: binding(treatmentFrozen, treatment, 'treatment'),
  })
  assert.equal(valid.pairs.length, 1)
  await assert.rejects(
    comparePairedSources({
      source,
      baselineSourceId: 'baseline-source',
      treatmentSourceId: 'treatment-source',
      baselineRuns: [{ ...baseline, runId: 'foreign-baseline' }],
      treatmentRuns: [treatment],
      baselineBinding: binding(baselineFrozen, baseline, 'baseline'),
      treatmentBinding: binding(treatmentFrozen, treatment, 'treatment'),
    }),
    /outside its frozen source run/u,
  )
  await assert.rejects(
    comparePairedSources({
      source,
      baselineSourceId: 'baseline-source',
      treatmentSourceId: 'treatment-source',
      baselineRuns: [],
      treatmentRuns: [],
      baselineBinding: {
        ...binding(baselineFrozen, baseline, 'baseline'),
        sourceDigest: 'sha256:detached',
      },
      treatmentBinding: binding(treatmentFrozen, treatment, 'treatment'),
    }),
    /source digest is not bound/u,
  )
})

test('application evaluation rejects a candidate detached from its frozen analysis', async () => {
  const service = new AnalysisService({
    source: new InMemoryAnalysisSourcePort([sourceBinding()]),
    repository: new InMemoryAnalysisRepository(),
    registry: createW11FixtureAnalystRegistry(),
  })
  const record = await service.run({
    operationId: 'eval-analysis-op',
    analysisId: 'eval-analysis',
    sourceId: 'source-w11',
    kind: 'ask',
  })
  if (!record.source) assert.fail('missing frozen source')
  const input = {
    caseId: W11_SEMANTIC_CASES[0]?.id ?? 'EVAL-01',
    fixtureId: W11_SEMANTIC_CASES[0]?.fixtures[0]?.id ?? 'EVAL-01-fixture-1',
    dimension: W11_SEMANTIC_CASES[0]?.dimension ?? 'analysis',
    candidate: 'candidate',
    analysisId: record.analysisId,
    operationId: record.operationId,
    sourceId: record.source.sourceId,
    sourceDigest: 'sha256:detached',
    sourceRevision: record.source.sourceRevision,
    conversationId: record.source.conversationId,
    branchId: record.source.branchId,
    runId: record.source.runId,
    runtime: record.source.runtime ?? '',
    profileDigest: record.source.profileDigest,
    model: record.source.model,
    receiptId: record.source.receiptId ?? '',
  } satisfies ApplicationEvaluationInput
  await assert.rejects(
    evaluateApplicationAnalysis({ record, judge: {} as never, evaluationInputs: [input] }),
    /sourceDigest/u,
  )
})

test('application evaluation reloads the exact persisted analysis before scoring', async () => {
  const sourcePort = new InMemoryAnalysisSourcePort([sourceBinding()])
  const repository = new InMemoryAnalysisRepository()
  const service = new AnalysisService({
    source: sourcePort,
    repository,
    registry: createW11FixtureAnalystRegistry(),
  })
  const app = createBraidApplication({
    fixture: 'deterministic',
    analysis: service,
    analysisSource: sourcePort,
    analysisSourceId: () => 'source-w11',
  })
  app.initialize('/workspace')
  const result = await app.executeAnalysisCommand(
    { command: 'analysis', kind: 'ask' },
    'application-evaluation-op',
  )
  if (!('status' in result)) assert.fail('application analysis did not return a record')
  await assert.rejects(
    app.evaluateAnalysis({ ...result, sourceDigest: 'sha256:detached' }, {} as never, []),
    /exact persisted application analysis result/u,
  )
})
