import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  type Analyst,
  type AnalystRegistry,
  buildDefaultAnalystRegistry,
  type ExactCapableAnalyst,
  makeFinding,
  roundTripRunRecord,
  type TraceAnalysisEngine,
  type TraceAnalysisStore,
  validateRunRecord,
} from '@tangle-network/agent-eval'
import type { RootHandle, TreeView } from '@tangle-network/agent-runtime/kernel'
import { AnalysisService } from '../src/analysis/service.js'
import { AnalysisCancellationCoordinator } from '../src/analysis/cancellation.js'
import { traceSpanUri } from '../src/analysis/source.js'
import { buildBraidGraph } from '../src/domain/graph.js'
import {
  W11_SEMANTIC_CASES,
  W11_TRACE_SPANS,
  W11_UNIT_FIXTURE_RUN_RECORDS,
} from '../src/evaluation/w11-cases.js'
import {
  type AnalysisRepository,
  type AnalysisSourceBinding,
  type AnalysisSourceRecord,
  analysisId,
  assertFeedbackSafe,
  branchId,
  comparePairedRunRecords,
  comparePairedSources,
  conversationId,
  createW11AnalystRegistry,
  createW11FixtureAnalystRegistry,
  eventId,
  exportFeedbackTrajectories,
  feedbackTrajectoryForAnalysis,
  graphEdgeId,
  InMemoryAnalysisRepository,
  InMemoryAnalysisSourcePort,
  InMemoryTraceAnalysisStore,
  importFeedbackTrajectories,
  EncryptedAnalysisRepository,
  EncryptedBraidStatePort,
  MemoryStateKeyPort,
  operationId,
  PublicRuntimeSupervisorAdapter,
  type RuntimeSupervisorClient,
  parseAnalysisCommand,
  runId,
  runW11Evaluation,
  supervisorId,
  turnId,
  type W11Judge,
  workerId,
} from '../src/index.js'

const execFileAsync = promisify(execFile)

function sourceBinding(
  sourceId = 'source-w11',
  overrides: Partial<AnalysisSourceRecord> = {},
): AnalysisSourceBinding {
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
    sourceId,
    sourceRevision: 'revision-1',
    conversationId: 'conversation-w11',
    branchId: 'branch-w11',
    runId: 'run-w11',
    profileDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    runner: 'deterministic-test-runner@2026-01-01',
    model: 'braid-test-model@2026-01-01',
    connection: 'fixture-connection',
    eventIds: ['event-1', 'event-2'],
    traceReferences: [
      { traceId: 'trace-w11-1', spanIds: ['span-w11-agent', 'span-w11-tool'] },
      { traceId: 'trace-w11-2', spanIds: ['span-w11-error'] },
    ],
    eventReferences: [
      { eventId: 'event-1', kind: 'run.started', excerpt: 'run started' },
      { eventId: 'event-2', kind: 'run.finished', excerpt: 'run finished' },
    ],
    metrics: { wall_ms: 100, cost_usd: 0.02 },
    artifactUris: [],
    capturedAt: '2026-01-01T00:00:00.000Z',
    complete: true,
    ...overrides,
  }
  return {
    source,
    traceStore,
    currentRevision: async () => source.sourceRevision,
    captureAtRevision: async () => ({ source, traceStore: traceStore.snapshot() }),
  }
}

function serviceFor(
  source = sourceBinding(),
  repository: AnalysisRepository = new InMemoryAnalysisRepository(),
): AnalysisService {
  return new AnalysisService({
    source: new InMemoryAnalysisSourcePort([source]),
    repository,
    registry: createW11FixtureAnalystRegistry(),
  })
}

test('W11 graph requires branded IDs and committed provenance', () => {
  const graph = buildBraidGraph({
    entities: [
      { id: conversationId('conversation-1'), kind: 'conversation' },
      { id: branchId('branch-1'), kind: 'branch' },
      { id: turnId('turn-1'), kind: 'turn' },
      { id: runId('run-1'), kind: 'run' },
      { id: analysisId('analysis-1'), kind: 'analysis' },
      { id: supervisorId('supervisor-1'), kind: 'supervisor' },
      { id: workerId('worker-1'), kind: 'worker' },
    ],
    relations: [
      {
        id: graphEdgeId('edge-1'),
        kind: 'continued',
        from: conversationId('conversation-1'),
        to: branchId('branch-1'),
        operationId: operationId('op-1'),
        at: '2026-01-01T00:00:00.000Z',
        provenance: { sourceEventId: eventId('event-1') },
      },
      {
        id: graphEdgeId('edge-2'),
        kind: 'continued',
        from: branchId('branch-1'),
        to: turnId('turn-1'),
        operationId: operationId('op-2'),
        at: '2026-01-01T00:00:00.000Z',
        provenance: { sourceEventId: eventId('event-2') },
      },
      {
        id: graphEdgeId('edge-3'),
        kind: 'continued',
        from: turnId('turn-1'),
        to: runId('run-1'),
        operationId: operationId('op-3'),
        at: '2026-01-01T00:00:00.000Z',
        provenance: { sourceEventId: eventId('event-3') },
      },
      {
        id: graphEdgeId('edge-4'),
        kind: 'analyzed',
        from: runId('run-1'),
        to: analysisId('analysis-1'),
        operationId: operationId('op-4'),
        at: '2026-01-01T00:00:00.000Z',
        provenance: { sourceEventId: eventId('event-4') },
      },
      {
        id: graphEdgeId('edge-5'),
        kind: 'supervised_by',
        from: runId('run-1'),
        to: supervisorId('supervisor-1'),
        operationId: operationId('op-5'),
        at: '2026-01-01T00:00:00.000Z',
        provenance: { sourceEventId: eventId('event-5') },
      },
      {
        id: graphEdgeId('edge-6'),
        kind: 'spawned',
        from: supervisorId('supervisor-1'),
        to: workerId('worker-1'),
        operationId: operationId('op-6'),
        at: '2026-01-01T00:00:00.000Z',
        provenance: { sourceEventId: eventId('event-6') },
      },
    ],
  })
  assert.equal(graph.nodes.length, 7)
  assert.equal(graph.edges.length, 6)
  assert.throws(
    () =>
      buildBraidGraph({
        entities: [{ id: conversationId('conversation-1'), kind: 'conversation' }],
        relations: [
          {
            id: graphEdgeId('edge-7'),
            kind: 'continued',
            from: conversationId('conversation-1'),
            to: conversationId('conversation-1'),
            operationId: operationId('op-7'),
            at: '1970-01-01T00:00:00.000Z',
            provenance: { sourceEventId: eventId('event-7') },
          },
        ],
      }),
    /cannot point to itself/u,
  )
})

test('AN-01 through AN-03 use the exact analyst stream and persist JSON-safe telemetry', async () => {
  const repository = new InMemoryAnalysisRepository()
  const result = await serviceFor(sourceBinding(), repository).run({
    operationId: 'analysis-op-1',
    analysisId: 'analysis-1',
    sourceId: 'source-w11',
    kind: 'ask',
    question: 'why did this fail?',
    budget: { totalUsd: 0 },
  })
  assert.equal(result.status, 'complete')
  assert.equal(result.citations?.valid, true)
  assert.ok(result.source && !Object.hasOwn(result.source, 'traceStore'))
  assert.equal(result.registryRun?.execution_plan.policy.budget.kind, 'equal')
  assert.ok(result.telemetry)
  assert.equal((await repository.getOperation('analysis-op-1'))?.status, 'terminal')
})

test('configured analyst receives the exact /ask question through the upstream engine', async () => {
  const questions: string[] = []
  const engine: TraceAnalysisEngine = {
    id: 'unit-engine',
    description: 'Unit engine; no external calls.',
    model: 'unit-model',
    version: '1.0.0',
    executionConfig: { unit: true },
    analyze: async (request) => {
      questions.push(request.question)
      return {
        answer: 'unit answer',
        findings: [],
        trajectory: [],
        modelCalls: 0,
        toolCalls: 0,
        runtime: {},
      }
    },
  }
  const result = await new AnalysisService({
    source: new InMemoryAnalysisSourcePort([sourceBinding()]),
    repository: new InMemoryAnalysisRepository(),
    registry: createW11AnalystRegistry({ engine }),
  }).run({
    operationId: 'analysis-op-question',
    analysisId: 'analysis-question',
    sourceId: 'source-w11',
    kind: 'ask',
    question: 'why did this exact run fail?',
  })
  assert.equal(result.status, 'complete')
  assert.deepEqual(questions, ['why did this exact run fail?'])
})

test('AN-04 rejects citations that do not resolve', async () => {
  const registry = buildDefaultAnalystRegistry({ includeBehavioral: false })
  const invalid: ExactCapableAnalyst<TraceAnalysisStore> = {
    id: 'invalid-citation',
    description: 'Test analyst with an intentionally invalid citation.',
    inputKind: 'trace-store',
    cost: { kind: 'deterministic' },
    version: '1.0.0',
    executionConfig: { test: true },
    analyze: async () => [
      makeFinding({
        analyst_id: 'invalid-citation',
        severity: 'high',
        area: 'test',
        claim: 'This claim cannot be promoted.',
        evidence_refs: [{ kind: 'span', uri: traceSpanUri('missing-trace', 'missing-span') }],
        confidence: 1,
      }),
    ],
  }
  registry.register(invalid satisfies Analyst)
  const result = await new AnalysisService({
    source: new InMemoryAnalysisSourcePort([sourceBinding()]),
    repository: new InMemoryAnalysisRepository(),
    registry,
  }).run({
    operationId: 'analysis-op-invalid',
    analysisId: 'analysis-invalid',
    sourceId: 'source-w11',
    kind: 'ask',
    analystIds: ['invalid-citation'],
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.error?.code, 'CITATION_UNRESOLVED')
})

test('AN-05 source mutation fails before promotion and fork', async () => {
  const sourcePort = new InMemoryAnalysisSourcePort([sourceBinding()])
  const repository = new InMemoryAnalysisRepository()
  const service = new AnalysisService({
    source: sourcePort,
    repository,
    registry: createW11FixtureAnalystRegistry(),
    fork: { forkFromAnalysis: async () => ({ branchId: 'branch-from-analysis' }) },
    promotion: { attach: async () => undefined },
  })
  const complete = await service.run({
    operationId: 'analysis-op-promote',
    analysisId: 'analysis-promote',
    sourceId: 'source-w11',
    kind: 'failure',
  })
  assert.equal(complete.status, 'complete')
  sourcePort.replace(
    sourceBinding('source-w11', {
      eventIds: ['event-1', 'event-2', 'event-late'],
      eventReferences: [
        { eventId: 'event-1', kind: 'run.started' },
        { eventId: 'event-2', kind: 'run.finished' },
        { eventId: 'event-late', kind: 'run.finished' },
      ],
    }),
  )
  await assert.rejects(service.promote('analysis-promote', 'promote-op'), /source changed/u)
  await assert.rejects(service.forkFromAnalysis('analysis-promote', 'fork-op'), /source changed/u)
})

test('AN-06 cancellation has a durable operation result', async () => {
  const registry = buildDefaultAnalystRegistry({ includeBehavioral: false })
  const waiting: ExactCapableAnalyst<TraceAnalysisStore> = {
    id: 'waiting-analyst',
    description: 'Test analyst that waits for cancellation.',
    inputKind: 'trace-store',
    cost: { kind: 'deterministic' },
    version: '1.0.0',
    executionConfig: { test: true },
    analyze: async (_store, context) =>
      await new Promise<never>((_resolve, reject) => {
        context.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('cancelled', 'AbortError')),
          { once: true },
        )
      }),
  }
  registry.register(waiting satisfies Analyst)
  const repository = new InMemoryAnalysisRepository()
  const service = new AnalysisService({
    source: new InMemoryAnalysisSourcePort([sourceBinding()]),
    repository,
    registry,
  })
  const promise = service.run({
    operationId: 'analysis-op-cancel',
    analysisId: 'analysis-cancel',
    sourceId: 'source-w11',
    kind: 'ask',
    analystIds: ['waiting-analyst'],
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal((await service.requestCancel('analysis-cancel', 'cancel-op-a')).status, 'pending')
  assert.equal((await service.requestCancel('analysis-cancel', 'cancel-op-b')).status, 'pending')
  assert.equal((await promise).status, 'cancelled')
  for (const operation of ['cancel-op-a', 'cancel-op-b']) {
    const persisted = await repository.getOperation(operation)
    assert.equal(persisted?.status, 'terminal')
    assert.deepEqual(persisted?.result, {
      operationId: operation,
      analysisId: 'analysis-cancel',
      status: 'cancelled',
    })
  }
})

test('identical analysis cancellation requests trigger one abort effect', async () => {
  const repository = new InMemoryAnalysisRepository()
  const coordinator = new AnalysisCancellationCoordinator(
    repository,
    () => '2026-01-01T00:00:00.000Z',
  )
  let aborts = 0
  coordinator.register('analysis-duplicate-cancel', {
    abort: () => {
      aborts += 1
    },
  } as unknown as AbortController)
  const [first, second] = await Promise.all([
    coordinator.request('analysis-duplicate-cancel', 'cancel-duplicate', 'stop'),
    coordinator.request('analysis-duplicate-cancel', 'cancel-duplicate', 'stop'),
  ])
  assert.equal(first.status, 'pending')
  assert.equal(second.status, 'pending')
  assert.equal(aborts, 1)
})

test('pending operation recovery returns unknown without repeating provider work', async () => {
  const repository = new InMemoryAnalysisRepository()
  const request = {
    operationId: 'restart-op',
    analysisId: 'restart-analysis',
    sourceId: 'source-w11',
    kind: 'ask' as const,
  }
  const requestDigest = `sha256:${(await import('../src/domain/canonical.js')).canonicalDigest({ kind: 'analysis', targetId: request.analysisId, request })}`
  await repository.reserve({
    operationId: request.operationId,
    kind: 'analysis',
    targetId: request.analysisId,
    requestDigest,
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
  const result = await serviceFor(sourceBinding(), repository).run(request)
  assert.equal(result.status, 'unknown')
  assert.equal((await repository.getOperation(request.operationId))?.status, 'unknown')
})

test('expired lease takeover resolves unknown without repeating provider work', async () => {
  const repository = new InMemoryAnalysisRepository()
  const baseRegistry = createW11FixtureAnalystRegistry()
  let dispatches = 0
  let entered!: () => void
  let release!: () => void
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve
  })
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve
  })
  const registry = {
    list: () => baseRegistry.list(),
    runExactStream: (
      runId: Parameters<AnalystRegistry['runExactStream']>[0],
      inputs: Parameters<AnalystRegistry['runExactStream']>[1],
      options: Parameters<AnalystRegistry['runExactStream']>[2],
    ) =>
      (async function* () {
        dispatches += 1
        entered()
        await releasePromise
        yield* baseRegistry.runExactStream(runId, inputs, options)
      })(),
  } as unknown as AnalystRegistry
  const request = {
    operationId: 'expired-lease-op',
    analysisId: 'expired-lease-analysis',
    sourceId: 'source-w11',
    kind: 'ask' as const,
  }
  let now = '2026-01-01T00:00:00.000Z'
  const first = new AnalysisService({
    source: new InMemoryAnalysisSourcePort([sourceBinding()]),
    repository,
    registry,
    now: () => now,
    leaseMs: 10,
  })
  const firstPromise = first.run(request)
  await enteredPromise
  now = '2026-01-01T00:00:00.020Z'
  const second = new AnalysisService({
    source: new InMemoryAnalysisSourcePort([sourceBinding()]),
    repository,
    registry,
    now: () => now,
    leaseMs: 10,
  })
  const secondResult = await second.run(request)
  assert.equal(secondResult.status, 'unknown')
  assert.equal(dispatches, 1)
  release()
  assert.equal((await firstPromise).status, 'unknown')
})

test('an active owner renews its lease before another process can take over', async () => {
  const repository = new InMemoryAnalysisRepository()
  const baseRegistry = createW11FixtureAnalystRegistry()
  let dispatches = 0
  let entered!: () => void
  let release!: () => void
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve
  })
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve
  })
  const registry = {
    list: () => baseRegistry.list(),
    runExactStream: (
      runId: Parameters<AnalystRegistry['runExactStream']>[0],
      inputs: Parameters<AnalystRegistry['runExactStream']>[1],
      options: Parameters<AnalystRegistry['runExactStream']>[2],
    ) =>
      (async function* () {
        dispatches += 1
        entered()
        await releasePromise
        yield* baseRegistry.runExactStream(runId, inputs, options)
      })(),
  } as unknown as AnalystRegistry
  const request = {
    operationId: 'renewed-lease-op',
    analysisId: 'renewed-lease-analysis',
    sourceId: 'source-w11',
    kind: 'ask' as const,
  }
  const first = new AnalysisService({
    source: new InMemoryAnalysisSourcePort([sourceBinding()]),
    repository,
    registry,
    ownerId: 'owner-a',
    leaseMs: 300,
  })
  const firstPromise = first.run(request)
  await enteredPromise
  await new Promise((resolve) => setTimeout(resolve, 450))
  const second = new AnalysisService({
    source: new InMemoryAnalysisSourcePort([sourceBinding()]),
    repository,
    registry,
    ownerId: 'owner-b',
    leaseMs: 300,
  })
  const secondResult = await second.run(request)
  assert.equal(secondResult.status, 'unknown')
  assert.equal(dispatches, 1)
  release()
  assert.equal((await firstPromise).status, 'complete')
})

test('encrypted state repository preserves a pending operation across service instances', async () => {
  const directory = await mkdtemp('/tmp/braid-w11-recovery-')
  const key = new MemoryStateKeyPort(new Uint8Array(32).fill(7))
  const path = join(directory, 'analysis.enc')
  const first = new EncryptedAnalysisRepository(new EncryptedBraidStatePort(path, key))
  const request = {
    operationId: 'file-restart-op',
    analysisId: 'file-restart-analysis',
    sourceId: 'source-w11',
    kind: 'ask' as const,
  }
  const requestDigest = `sha256:${(await import('../src/domain/canonical.js')).canonicalDigest({ kind: 'analysis', targetId: request.analysisId, request })}`
  await first.reserve({
    operationId: request.operationId,
    kind: 'analysis',
    targetId: request.analysisId,
    requestDigest,
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
  const second = new EncryptedAnalysisRepository(new EncryptedBraidStatePort(path, key))
  const result = await serviceFor(sourceBinding(), second).run(request)
  assert.equal(result.status, 'unknown')
  assert.equal((await second.getOperation(request.operationId))?.status, 'unknown')
})

test('source freeze rejects a revision that changes during capture', async () => {
  const initial = sourceBinding()
  let sourcePort!: InMemoryAnalysisSourcePort
  sourcePort = new InMemoryAnalysisSourcePort([
    {
      ...initial,
      captureAtRevision: async () => {
        sourcePort.replace({
          ...sourceBinding(),
          source: { ...sourceBinding().source, sourceRevision: 'revision-2' },
        })
        return {
          source: initial.source,
          traceStore: (initial.traceStore as InMemoryTraceAnalysisStore).snapshot(),
        }
      },
    },
  ])
  await assert.rejects(sourcePort.freeze('source-w11'), /source changed/u)
})

test('source freeze checks the same adapter revision before and after snapshot reads', async () => {
  const initial = sourceBinding()
  let revision = initial.source.sourceRevision
  const sourcePort = new InMemoryAnalysisSourcePort([
    {
      ...initial,
      currentRevision: async () => revision,
      captureAtRevision: async () => {
        revision = 'revision-2'
        return {
          source: initial.source,
          traceStore: (initial.traceStore as InMemoryTraceAnalysisStore).snapshot(),
        }
      },
    },
  ])
  await assert.rejects(sourcePort.freeze('source-w11'), /source changed/u)
})

test('operation IDs reject a different request', async () => {
  const repository = new InMemoryAnalysisRepository()
  const service = serviceFor(sourceBinding(), repository)
  await service.run({
    operationId: 'conflict-op',
    analysisId: 'analysis-a',
    sourceId: 'source-w11',
    kind: 'ask',
  })
  await assert.rejects(
    service.run({
      operationId: 'conflict-op',
      analysisId: 'analysis-b',
      sourceId: 'source-w11',
      kind: 'ask',
    }),
    /already bound/u,
  )
})

test('AN-07 paired comparisons expose unmatched work and freeze both sources', async () => {
  const baseline = W11_UNIT_FIXTURE_RUN_RECORDS.filter(
    (record) => record.experimentId === 'w11-EVAL-01' && record.candidateId === 'baseline',
  )
  const treatment = W11_UNIT_FIXTURE_RUN_RECORDS.filter(
    (record) => record.experimentId === 'w11-EVAL-01' && record.candidateId === 'treatment',
  ).slice(0, 2)
  const comparison = comparePairedRunRecords(baseline, treatment)
  assert.equal(comparison.pairs.length, 2)
  assert.equal(comparison.unpairedBaseline.length, 1)
  const source = new InMemoryAnalysisSourcePort([
    sourceBinding('baseline-source', {
      runId: baseline[0]?.runId ?? 'missing-baseline',
      model: baseline[0]?.model ?? 'missing-model',
      experimentId: baseline[0]?.experimentId ?? 'missing-experiment',
      arm: 'baseline',
      receiptId: 'receipt-baseline',
    }),
    sourceBinding('treatment-source', {
      runId: treatment[0]?.runId ?? 'missing-treatment',
      model: treatment[0]?.model ?? 'missing-model',
      experimentId: treatment[0]?.experimentId ?? 'missing-experiment',
      arm: 'treatment',
      receiptId: 'receipt-treatment',
    }),
  ])
  const baselineFrozen = await source.freeze('baseline-source')
  const treatmentFrozen = await source.freeze('treatment-source')
  const frozen = await comparePairedSources({
    source,
    baselineSourceId: 'baseline-source',
    treatmentSourceId: 'treatment-source',
    baselineRuns: baseline.slice(0, 1),
    treatmentRuns: treatment.slice(0, 1),
    baselineBinding: {
      experimentId: baseline[0]?.experimentId ?? '',
      arm: 'baseline',
      sourceDigest: baselineFrozen.source.digest,
      sourceRunId: baseline[0]?.runId ?? '',
      profileDigest: baselineFrozen.source.profileDigest,
      model: baseline[0]?.model ?? '',
      receiptId: baselineFrozen.source.receiptId ?? '',
    },
    treatmentBinding: {
      experimentId: treatment[0]?.experimentId ?? '',
      arm: 'treatment',
      sourceDigest: treatmentFrozen.source.digest,
      sourceRunId: treatment[0]?.runId ?? '',
      profileDigest: treatmentFrozen.source.profileDigest,
      model: treatment[0]?.model ?? '',
      receiptId: treatmentFrozen.source.receiptId ?? '',
    },
  })
  assert.ok(frozen.baselineSource?.digest && frozen.treatmentSource?.digest)
})

test('AN-08 and AN-09 attach selected findings explicitly', async () => {
  const attached: string[][] = []
  const forked: string[][] = []
  const service = new AnalysisService({
    source: new InMemoryAnalysisSourcePort([sourceBinding()]),
    repository: new InMemoryAnalysisRepository(),
    registry: createW11FixtureAnalystRegistry(),
    promotion: {
      attach: async (input) => {
        attached.push([...input.findingIds])
      },
    },
    fork: {
      forkFromAnalysis: async (input) => {
        forked.push([...input.findingIds])
        return { branchId: 'branch-from-analysis' }
      },
    },
  })
  const result = await service.run({
    operationId: 'analysis-op-attach',
    analysisId: 'analysis-attach',
    sourceId: 'source-w11',
    kind: 'tools',
  })
  const findingId = result.findings[0]?.finding_id
  assert.ok(findingId)
  await service.promote('analysis-attach', 'promote-attach', [findingId])
  assert.equal(
    (await service.forkFromAnalysis('analysis-attach', 'fork-attach', [findingId])).branchId,
    'branch-from-analysis',
  )
  assert.deepEqual(attached, [[findingId]])
  assert.deepEqual(forked, [[findingId]])
})

test('AN-10 feedback rejects secret-designated values instead of deleting keys', async () => {
  const analysis = await serviceFor(sourceBinding()).run({
    operationId: 'analysis-op-feedback',
    analysisId: 'analysis-feedback',
    sourceId: 'source-w11',
    kind: 'improvement',
  })
  assert.throws(
    () =>
      feedbackTrajectoryForAnalysis(analysis, [
        {
          source: 'user',
          kind: 'comment',
          value: { apiToken: 'do-not-export' },
          at: analysis.endedAt,
        },
      ]),
    /secret/u,
  )
  assert.throws(
    () =>
      assertFeedbackSafe({
        answerSpec: { fields: [{ name: 'credential', type: 'secret' }] },
        value: { neutral: 'do-not-export' },
      }),
    /secret/u,
  )
  assert.throws(
    () =>
      assertFeedbackSafe({
        request: { answerSpec: { fields: [{ name: 'credential', type: 'secret' }] } },
        response: { data: { neutral: 'do-not-export' } },
      }),
    /secret/u,
  )
  assert.throws(
    () =>
      assertFeedbackSafe({
        answerSpec: { fields: [{ name: 'credential', type: 'secret' }] },
        answers: [{ nested: { neutral: 'do-not-export' } }],
      }),
    /secret/u,
  )
  assert.throws(
    () =>
      assertFeedbackSafe({
        errors: [{ metadata: { containsSecret: true }, value: ['do-not-export'] }],
      }),
    /secret/u,
  )
  assert.throws(
    () =>
      assertFeedbackSafe({
        findings: [{ metadata: { secretDesignated: true }, value: ['do-not-export'] }],
      }),
    /secret/u,
  )
  assert.throws(() => assertFeedbackSafe({ metadata: { apiKey: 'do-not-export' } }), /secret/u)
  const trajectory = feedbackTrajectoryForAnalysis(analysis)
  const jsonl = exportFeedbackTrajectories([trajectory])
  assert.equal(importFeedbackTrajectories(jsonl).length, 1)
})

test('real judge runner calibrates before unit-fixture cases and records raw observations', async () => {
  let calls = 0
  const judge: W11Judge = {
    source: 'unit-fixture',
    name: 'unit-fixture-judge',
    version: 'unit-fixture-judge-1',
    judge: async (input) => {
      calls += 1
      const score = input.candidate === input.reference ? 1 : 0
      return {
        input: { candidate: input.candidate, reference: input.reference, scenario: input.scenario },
        output: String(score),
        score,
        notes: 'fixture-only',
        costUsd: null,
        tokens: null,
        disagreement: null,
      }
    },
  }
  const inputs = W11_SEMANTIC_CASES.flatMap((item) =>
    item.fixtures.map((fixture) => ({
      caseId: item.id,
      fixtureId: fixture.id,
      dimension: item.dimension,
      candidate: fixture.good,
    })),
  )
  const result = await runW11Evaluation(judge, inputs)
  assert.equal(result.provenance.source, 'unit-fixture')
  assert.equal(result.provenance.fixtureCount, 18)
  assert.equal(result.provenance.observationCount, 54)
  assert.equal(result.observations.length, 54)
  assert.equal(result.observations.filter((item) => item.role === 'candidate').length, 18)
  assert.equal(result.observations.filter((item) => item.role === 'seeded-bad').length, 18)
  assert.equal(result.observations.filter((item) => item.role === 'trivial').length, 18)
  assert.equal(result.calibration.goodWins, 12)
  assert.equal(result.calibration.trivialWins, 12)
  assert.equal(result.verdict.status, 'passed')
  assert.equal(result.verdict.passedCases, 18)
  assert.equal(result.verdict.requiredCases, 18)
  assert.ok(result.verdict.candidateMean > result.verdict.seededBadMean)
  assert.equal(calls, 90)
})

test('semantic evaluation returns a failed verdict when the candidate loses to a seeded bad output', async () => {
  const judge: W11Judge = {
    source: 'unit-fixture',
    name: 'verdict-fixture-judge',
    version: 'verdict-fixture-judge-1',
    judge: async (input) => {
      const score =
        input.scenario.kind === 'w11-calibration'
          ? input.candidate === input.reference
            ? 1
            : 0
          : input.scenario.id.endsWith(':seeded-bad')
            ? 1
            : 0
      return {
        input: { candidate: input.candidate, reference: input.reference, scenario: input.scenario },
        output: String(score),
        score,
        notes: 'fixture-only',
        costUsd: null,
        tokens: null,
        disagreement: null,
      }
    },
  }
  const inputs = W11_SEMANTIC_CASES.flatMap((item) =>
    item.fixtures.map((fixture) => ({
      caseId: item.id,
      fixtureId: fixture.id,
      dimension: item.dimension,
      candidate: fixture.good,
    })),
  )
  const result = await runW11Evaluation(judge, inputs)
  assert.equal(result.verdict.status, 'failed')
  assert.equal(result.verdict.passedCases, 0)
  assert.equal(result.verdict.failedFixtureIds.length, 18)
})

test('judge calibration failure prevents all semantic cases from running', async () => {
  let calls = 0
  const badJudge: W11Judge = {
    source: 'unit-fixture',
    name: 'flat-fixture-judge',
    version: 'flat-fixture-judge-1',
    judge: async (input) => {
      calls += 1
      return {
        input: { candidate: input.candidate, reference: input.reference, scenario: input.scenario },
        output: 'flat',
        score: 0.5,
        notes: 'flat',
        costUsd: null,
        tokens: null,
        disagreement: null,
      }
    },
  }
  const inputs = W11_SEMANTIC_CASES.flatMap((item) =>
    item.fixtures.map((fixture) => ({
      caseId: item.id,
      fixtureId: fixture.id,
      dimension: item.dimension,
      candidate: fixture.good,
    })),
  )
  await assert.rejects(runW11Evaluation(badJudge, inputs), /calibration failed/u)
  assert.equal(calls, 36)
})

test('the braid eval entry point exits nonzero when required inputs are absent', async () => {
  const environment = { ...process.env }
  delete environment.BRAID_ANALYST_API_KEY
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [fileURLToPath(new URL('../src/bin/braid.js', import.meta.url)), 'eval'],
      { env: environment },
    ),
    (error: unknown) => {
      const failure = error as { readonly code?: number; readonly stderr?: string }
      assert.equal(failure.code, 1)
      assert.match(failure.stderr ?? '', /eval requires --trace-file/u)
      return true
    },
  )
})

test('runtime supervisor adapter binds root identity and forwards cancellation', async () => {
  const tree = { root: 'root', nodes: [], inFlight: 0, waiting: 0 } as unknown as TreeView
  let abortedWith: string | undefined
  const client: RuntimeSupervisorClient = {
    supervisorId: 'supervisor-1',
    runId: 'run-1',
    root: {
      view: () => tree,
      signal: () => undefined,
      abort: (reason) => {
        abortedWith = reason
      },
    } satisfies RootHandle<unknown>,
    revision: () => 7,
    observedAt: () => '2026-01-01T00:00:00.000Z',
  }
  const adapter = new PublicRuntimeSupervisorAdapter({ resolve: async () => client })
  const snapshot = await adapter.reconnect('supervisor-1')
  assert.equal(snapshot.revision, 7)
  assert.equal(snapshot.supervisorId, 'supervisor-1')
  assert.equal(snapshot.runId, 'run-1')
  assert.equal((await adapter.snapshot('supervisor-1')).status, 'unknown')
  assert.equal(
    (
      await adapter.cancel({
        operationId: 'cancel-1',
        supervisorId: 'supervisor-1',
        runId: 'run-1',
        reason: 'stop',
      })
    ).effect,
    'requested',
  )
  assert.equal(abortedWith, 'stop')
  await assert.rejects(
    adapter.cancel({
      operationId: 'cancel-worker-1',
      supervisorId: 'supervisor-1',
      runId: 'run-1',
      workerId: 'worker-1',
      reason: 'stop worker',
    }),
    /cannot cancel one worker/u,
  )
  const iterator = adapter
    .watch({ supervisorId: 'supervisor-1', intervalMs: 1 })
    [Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value?.revision, 7)
})

test('slash commands cover all W11 recipes', () => {
  assert.deepEqual(parseAnalysisCommand('/ask why did this fail'), {
    status: 'command',
    command: { command: 'analysis', kind: 'ask', question: 'why did this fail' },
  })
  assert.deepEqual(parseAnalysisCommand('/analyze failure'), {
    status: 'command',
    command: { command: 'analysis', kind: 'failure' },
  })
  for (const name of ['failure', 'cost', 'tools', 'improvement']) {
    const prototype = parseAnalysisCommand(`/${name}`)
    assert.equal(prototype?.status, 'invalid')
    if (prototype?.status === 'invalid') assert.match(prototype.message, /prototype/u)
  }
  assert.deepEqual(parseAnalysisCommand('/compare baseline treatment'), {
    status: 'command',
    command: { command: 'compare', baselineSourceId: 'baseline', treatmentSourceId: 'treatment' },
  })
  assert.equal(parseAnalysisCommand('ordinary message'), null)
  const firstRecord = W11_UNIT_FIXTURE_RUN_RECORDS[0]
  assert.ok(firstRecord)
  assert.deepEqual(roundTripRunRecord(firstRecord), validateRunRecord(firstRecord))
})
