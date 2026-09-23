import assert from 'node:assert/strict'
import { chmod, lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import type { ExactAnalystRunResult } from '@tangle-network/agent-eval'
import type { RootHandle, TreeView } from '@tangle-network/agent-runtime/kernel'
import { AnalysisService } from '../src/analysis/service.js'
import { telemetryFor } from '../src/analysis/result.js'
import { compileEvidencePattern } from '../src/analysis/evidence-pattern.js'
import {
  sourceDigest,
  type AnalysisSourceBinding,
  type AnalysisSourcePort,
  type AnalysisSourceRecord,
} from '../src/analysis/source.js'
import { InMemoryAnalysisSourcePort } from '../src/analysis/source-port.js'
import { InMemoryTraceAnalysisStore } from '../src/analysis/trace-store.js'
import { createBraidApplication } from '../src/app/composition.js'
import { applicationAnalysisBinding } from '../src/app/analysis-source.js'
import {
  buildBraidGraph,
  assertGraphAcyclic,
  type GraphEdge,
  type GraphNode,
} from '../src/domain/graph.js'
import { runId, graphEdgeId, operationId, eventId } from '../src/domain/ids.js'
import { W11_TRACE_SPANS } from '../src/evaluation/w11-cases.js'
import {
  AnalysisServiceError,
  EncryptedBraidStatePort,
  InMemoryAnalysisRepository,
  MemoryStateKeyPort,
  StateConflictError,
  type AnalysisState,
} from '../src/index.js'
import { runRpc } from '../src/views/headless/rpc.js'
import {
  PublicRuntimeSupervisorAdapter,
  type RuntimeSupervisorClient,
} from '../src/supervisor/runtime-supervisor.js'
import { createW11FixtureAnalystRegistry } from '../src/analysis/analysts.js'

function binding(sourceId = 'source-w11'): AnalysisSourceBinding {
  const spans = W11_TRACE_SPANS
  const traceStore = new InMemoryTraceAnalysisStore([
    { traceId: 'trace-w11-1', spans: spans.filter((span) => span.trace_id === 'trace-w11-1') },
    { traceId: 'trace-w11-2', spans: spans.filter((span) => span.trace_id === 'trace-w11-2') },
  ])
  const source: AnalysisSourceRecord = {
    sourceId,
    sourceRevision: 'revision-1',
    conversationId: 'conversation-w11',
    branchId: 'branch-w11',
    runId: 'run-w11',
    profileDigest: `sha256:${'a'.repeat(64)}`,
    runner: 'fixture',
    model: 'fixture-model',
    connection: 'fixture-connection',
    eventIds: ['event-1'],
    traceReferences: [
      { traceId: 'trace-w11-1', spanIds: ['span-w11-agent', 'span-w11-tool'] },
      { traceId: 'trace-w11-2', spanIds: ['span-w11-error'] },
    ],
    eventReferences: [{ eventId: 'event-1', kind: 'run.finished', excerpt: 'finished' }],
    metrics: { wall_ms: 100 },
    artifactUris: [],
    capturedAt: '2026-01-01T00:00:00.000Z',
    complete: true,
  }
  return {
    source,
    traceStore,
    currentRevision: async () => source.sourceRevision,
    captureAtRevision: async () => ({ source, traceStore: traceStore.snapshot() }),
  }
}

function service(sourcePort = new InMemoryAnalysisSourcePort([binding()])): AnalysisService {
  return new AnalysisService({
    source: sourcePort,
    repository: new InMemoryAnalysisRepository(),
    registry: createW11FixtureAnalystRegistry(),
  })
}

test('encrypted state is private, recoverable, versioned, and conflict checked', async () => {
  const directory = await mkdtemp('/tmp/braid-w11-state-')
  const path = join(directory, 'analysis.enc')
  const key = new MemoryStateKeyPort(new Uint8Array(32).fill(9))
  const port = new EncryptedBraidStatePort<AnalysisState>(path, key)
  const empty: AnalysisState = { schemaVersion: 1, records: [], operations: [] }
  await port.commit(0, empty)
  await port.commit(1, { ...empty, operations: [] })
  const directoryStat = await lstat(directory)
  assert.equal(directoryStat.mode & 0o777, 0o700)
  const stat = await lstat(path)
  assert.equal(stat.mode & 0o777, 0o600)
  assert.doesNotMatch(await readFile(path, 'utf8'), /records|secret-value/u)
  await chmod(path, 0o644)
  await assert.rejects(port.read(), /accessible by another user/u)
  await chmod(path, 0o600)
  await writeFile(path, 'crashed-before-rename\n')
  assert.equal((await port.read())?.revision, 1)
  const second = new EncryptedBraidStatePort<AnalysisState>(path, key)
  await assert.rejects(second.commit(0, empty), StateConflictError)
  const lockPath = `${path}.lock`
  await writeFile(lockPath, JSON.stringify({ pid: process.pid }), { mode: 0o600 })
  await chmod(lockPath, 0o600)
  await assert.rejects(port.commit(1, empty), StateConflictError)
})

test('memory state keys are copied instead of retaining caller-owned bytes', async () => {
  const input = new Uint8Array(32).fill(3)
  const key = new MemoryStateKeyPort(input)
  input.fill(8)
  assert.equal((await key.resolve())[0], 3)
  const resolved = await key.resolve()
  resolved.fill(7)
  assert.equal((await key.resolve())[0], 3)
})

test('encrypted state migrations preserve the committed revision and target schema', async () => {
  const directory = await mkdtemp('/tmp/braid-w11-migration-')
  const path = join(directory, 'state.enc')
  const key = new MemoryStateKeyPort(new Uint8Array(32).fill(4))
  const oldPort = new EncryptedBraidStatePort<{ readonly value: string }>(path, key)
  await oldPort.commit(0, { value: 'old' })
  const currentPort = new EncryptedBraidStatePort<{ readonly value: string }>(path, key, {
    schemaVersion: 2,
    migrate: (schemaVersion, state) => ({
      schemaVersion: 2,
      revision: 999,
      state: { value: `${schemaVersion}:${(state as { readonly value: string }).value}` },
    }),
  })
  assert.deepEqual(await currentPort.read(), {
    schemaVersion: 2,
    revision: 1,
    state: { value: '1:old' },
  })
})

test('analysis telemetry preserves analyst identity and unknown accounting', () => {
  const result = {
    total_cost_usd: 0,
    total_cost_provenance: { kind: 'uncaptured', usd: null },
    per_analyst: [
      {
        analyst_id: 'braid.ask',
        status: 'ok',
        findings_count: 0,
        latency_ms: 4,
        usage: { calls: null, tokens: null, cost: { kind: 'uncaptured', usd: null } },
      },
    ],
  } as unknown as ExactAnalystRunResult
  const telemetry = telemetryFor(result)
  assert.equal(telemetry.calls, null)
  assert.equal(telemetry.inputTokens, null)
  assert.equal(telemetry.totalCostUsd, null)
  assert.ok(Object.hasOwn(telemetry.perAnalyst as object, 'braid.ask'))
  const empty = telemetryFor({ ...result, per_analyst: [] })
  assert.equal(empty.calls, null)
  assert.equal(empty.inputTokens, null)
})

test('capturedAt does not change a stable source digest', async () => {
  const first = binding().source
  const store = new InMemoryTraceAnalysisStore([
    {
      traceId: 'trace-w11-1',
      spans: W11_TRACE_SPANS.filter((span) => span.trace_id === 'trace-w11-1'),
    },
    {
      traceId: 'trace-w11-2',
      spans: W11_TRACE_SPANS.filter((span) => span.trace_id === 'trace-w11-2'),
    },
  ])
  const second = { ...first, capturedAt: '2026-01-02T00:00:00.000Z' }
  assert.equal(await sourceDigest(first, store), await sourceDigest(second, store))
})

test('frozen source metadata cannot be changed by a late caller mutation', async () => {
  const sourcePort = new InMemoryAnalysisSourcePort([binding()])
  const frozen = await sourcePort.freeze('source-w11')
  assert.throws(() => (frozen.source.eventIds as string[]).push('late-event'), TypeError)
})

test('unsafe evidence patterns are rejected and span filtering happens before limiting', async () => {
  assert.throws(() => compileEvidencePattern('(a+)+'), /unbounded|compound/u)
  const first = W11_TRACE_SPANS[0]
  assert.ok(first)
  const extra = Array.from({ length: 120 }, (_, index) => ({ ...first, span_id: `span-${index}` }))
  const target = { ...first, span_id: 'target-span' }
  const store = new InMemoryTraceAnalysisStore([{ traceId: 'trace', spans: [...extra, target] }])
  const result = await store.searchSpan({
    trace_id: 'trace',
    span_id: 'target-span',
    regex_pattern: 'agent\\.turn',
    max_matches: 1,
  })
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0]?.span_id, 'target-span')
  const bounded = await store.searchTrace({
    trace_id: 'trace',
    regex_pattern: 'agent\\.turn',
    max_matches: 0,
  })
  assert.equal(bounded.hits.length, 0)
  assert.equal(bounded.has_more, true)
})

test('source digests and snapshots reject missing referenced spans', async () => {
  const source = binding().source
  await assert.rejects(sourceDigest(source, new InMemoryTraceAnalysisStore()), /missing spans/u)
})

test('graph validation is iterative for a 10000-node chain', () => {
  const nodes = Array.from({ length: 10_000 }, (_, index) => ({
    id: runId(`run-${index}`),
    kind: 'run' as const,
    label: `run-${index}`,
    data: {},
  })) as GraphNode[]
  const edges = nodes.slice(0, -1).map((node, index) => ({
    id: graphEdgeId(`edge-${index}`),
    kind: 'continued' as const,
    from: node.id,
    to: nodes[index + 1]?.id ?? node.id,
    operationId: operationId(`operation-${index}`),
    at: '2026-01-01T00:00:00.000Z',
    provenance: { sourceEventId: eventId(`event-${index}`) },
  })) as GraphEdge[]
  assert.doesNotThrow(() => assertGraphAcyclic(nodes, edges))
  assert.equal(buildBraidGraph({ entities: [], relations: [] }).nodes.length, 0)
})

test('terminal analysis failures are returned and make RPC exit nonzero', async () => {
  const failedService = service(new InMemoryAnalysisSourcePort())
  const app = createBraidApplication({
    fixture: 'deterministic',
    analysis: failedService,
    analysisSourceId: () => 'missing-source',
  })
  const lines = [
    JSON.stringify({
      version: 1,
      requestId: 'init',
      command: 'initialize',
      params: { workspace: '/tmp' },
    }),
    JSON.stringify({
      version: 1,
      requestId: 'analysis',
      operationId: 'analysis-op',
      command: 'analysis',
      params: { text: '/ask why' },
    }),
    JSON.stringify({ version: 1, requestId: 'shutdown', command: 'shutdown' }),
  ]
  const output: string[] = []
  const exitCode = await runRpc(
    app,
    {
      async *[Symbol.asyncIterator]() {
        yield `${lines.join('\n')}\n`
      },
    },
    {
      write: (chunk) => {
        output.push(chunk)
        return true
      },
    },
  )
  assert.equal(exitCode, 1)
  const analysis = output.map((line) => JSON.parse(line)).find((item) => item.type === 'analysis')
  assert.equal(analysis?.result.status, 'failed')
})

test('caller provenance tags cannot override the frozen source', async () => {
  for (const tags of [{ source_digest: 'sha256:evil' }, { Source_Digest: 'sha256:evil' }])
    await assert.rejects(
      service().run({
        operationId: 'tags-op',
        analysisId: 'tags-analysis',
        sourceId: 'source-w11',
        kind: 'ask',
        tags,
      }),
      (error: unknown) => error instanceof AnalysisServiceError && error.code === 'INVALID_REQUEST',
    )
})

test('source revisions are read from live application state', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  const binding = applicationAnalysisBinding(
    () => app.state(),
    () => app.events(),
    () => app.analysisTraces(),
    () => app.analysisRunId(),
  )
  const before = await binding.currentRevision()
  app.initialize('/tmp/braid-w11-live-revision')
  assert.equal(await binding.currentRevision(), before)
  await app.send({ operationId: 'source-revision-op', text: 'revision' }).completion
  const after = await binding.currentRevision()
  assert.notEqual(after, before)
})

test('promotion replays the frozen event range before attaching findings', async () => {
  const base = new InMemoryAnalysisSourcePort([binding()])
  let replayCalls = 0
  const source: AnalysisSourcePort = {
    freeze: (sourceId, signal) => base.freeze(sourceId, signal),
    verify: (handle) => base.verify(handle),
    currentDigest: (sourceId) => base.currentDigest(sourceId),
    replay: async (handle) => {
      replayCalls += 1
      return base.replay(handle)
    },
  }
  const service = new AnalysisService({
    source,
    repository: new InMemoryAnalysisRepository(),
    registry: createW11FixtureAnalystRegistry(),
    promotion: { attach: async () => undefined },
  })
  const result = await service.run({
    operationId: 'replay-analysis-op',
    analysisId: 'replay-analysis',
    sourceId: 'source-w11',
    kind: 'ask',
  })
  assert.equal(result.status, 'complete')
  await service.promote('replay-analysis', 'replay-promote-op')
  assert.equal(replayCalls, 1)
})

test('budgets and analyst selection fail closed before dispatch', async () => {
  const run = (overrides: Partial<Parameters<AnalysisService['run']>[0]>) =>
    service().run({
      operationId: 'validation-op',
      analysisId: 'validation-analysis',
      sourceId: 'source-w11',
      kind: 'ask',
      ...overrides,
    })
  await assert.rejects(run({ analystIds: ['missing-analyst'] }), /Unknown analyst selection/u)
  await assert.rejects(
    run({ budget: { totalUsd: 1, weights: { 'braid.ask': 0 } } }),
    /positive weight/u,
  )
  await assert.rejects(run({ budget: { totalUsd: Number.NaN } }), /finite/u)
})

test('supervisor identity, bounded logs, and watch revision reconnect are enforced', async () => {
  const tree = { root: 'root', nodes: [{}], inFlight: 0, waiting: 0 } as unknown as TreeView
  let firstView = true
  const firstRoot: RootHandle<unknown> = {
    view: () => {
      if (firstView) {
        firstView = false
        return tree
      }
      throw new Error('disconnected')
    },
    signal: () => undefined,
    abort: () => undefined,
  }
  const secondRoot: RootHandle<unknown> = {
    view: () => tree,
    signal: () => undefined,
    abort: () => undefined,
  }
  const client = (
    runIdValue: string,
    root: RootHandle<unknown>,
    revision: number,
    supervisorIdValue = 'supervisor-1',
  ): RuntimeSupervisorClient => ({
    supervisorId: supervisorIdValue,
    runId: runIdValue,
    root,
    revision: () => revision,
    readLogTail: () => ['\u001b]0;secret\u0007', 'x'.repeat(5_000)],
  })
  let resolves = 0
  const adapter = new PublicRuntimeSupervisorAdapter({
    resolve: async () =>
      resolves++ === 0 ? client('run-1', firstRoot, 1) : client('run-1', secondRoot, 2),
  })
  const iterator = adapter
    .watch({ supervisorId: 'supervisor-1', afterRevision: 0, intervalMs: 1 })
    [Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value?.revision, 1)
  assert.equal((await iterator.next()).value?.revision, 2)
  const workers = (await adapter.reconnect('supervisor-1')).workers
  assert.ok(workers[0]?.logTail.every((line) => line.length <= 4_096))
  const snapshot = await adapter.snapshot('supervisor-1')
  assert.throws(() => {
    ;(snapshot.workers as Array<unknown>).push({})
  }, TypeError)
  assert.equal(JSON.stringify(snapshot).includes('\u001b]'), false)
  const wrong = new PublicRuntimeSupervisorAdapter({
    resolve: async () => client('run-1', secondRoot, 1, 'wrong-supervisor'),
  })
  await assert.rejects(wrong.reconnect('supervisor-1'), /bound to wrong-supervisor/u)
  const noLogs = new PublicRuntimeSupervisorAdapter({
    resolve: async () => client('run-1', secondRoot, 2),
    logTailLimit: Number.NaN,
  })
  assert.deepEqual((await noLogs.snapshot('supervisor-1')).workers[0]?.logTail.length, 2)
  await assert.rejects(
    adapter.cancel({
      operationId: 'wrong-run-cancel',
      supervisorId: 'supervisor-1',
      runId: 'run-2',
      reason: 'stop',
    }),
    /bound to run run-1/u,
  )
})
