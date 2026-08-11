import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  AnalystFinding,
  ExactAnalystRunEvent,
  ExactAnalystRunResult,
} from '@tangle-network/agent-eval'
import type { AgentProfile } from '@tangle-network/agent-interface'
import { mapAnalystFinding } from '../src/adapters/analysis/citations.js'
import {
  AgentEvalAnalystAdapter,
  type AnalystRegistryPort,
} from '../src/adapters/analysis/eval-analyst.js'
import {
  BRAID_QUESTION_ANALYST_DEFINITION,
  BRAID_QUESTION_ANALYST_ID,
} from '../src/adapters/analysis/question-analyst.js'
import { safeAnalysisText } from '../src/adapters/analysis/trace-event-projection.js'
import { buildAnalysisTraceStore } from '../src/adapters/analysis/trace-store.js'
import { RuntimeSupervisorController } from '../src/adapters/runtime/supervisor-control.js'
import {
  RuntimeSupervisorWatcher,
  type TopSnapshot,
} from '../src/adapters/runtime/supervisor-watch.js'
import { AnalysisComparisonService } from '../src/app/analysis-comparison.js'
import { comparisonSnapshot } from '../src/app/analysis-comparison-evidence.js'
import { compareFrozenRuns } from '../src/app/analysis-comparison-facts.js'
import { resultFromComparisonRecord } from '../src/app/analysis-comparison-record.js'
import { AnalysisPromotionService } from '../src/app/analysis-promotion.js'
import { AnalysisService } from '../src/app/analysis-service.js'
import { analysisIdentity } from '../src/app/analysis-operation.js'
import {
  completedAnalysisRecord,
  initialAnalysisRecord,
} from '../src/app/analysis-result-mapper.js'
import { freezeAnalysisSource, verifyFrozenAnalysisSource } from '../src/app/analysis-source.js'
import {
  type AnalysisApplicationHost,
  type AnalysisRequest,
  AnalysisSourceError,
  type FrozenAnalysisEvidence,
} from '../src/app/analysis-types.js'
import { SupervisorService } from '../src/app/supervisor-service.js'
import type { AnalysisRecord } from '../src/domain/entities.js'
import type { BraidEvent, JournalEventEnvelope } from '../src/domain/events.js'
import { createAnalysisId, createEventId } from '../src/domain/ids-values.js'
import { replayEvents } from '../src/domain/reducer.js'
import { initialState } from '../src/domain/state.js'
import { analysisEvidence } from '../src/eval/fixtures.js'
import { analysisViewForRecord } from '../src/views/shared/analysis-presentation.js'

const NOW = '2026-08-03T20:00:00.000Z'
const TEST_PROFILE = {} as Readonly<AgentProfile>

function envelope(event: BraidEvent, sequence: number): JournalEventEnvelope {
  return {
    eventId: createEventId(`event-${sequence}`),
    sequence,
    revision: sequence,
    occurredAt: new Date(Date.parse(NOW) + sequence).toISOString(),
    event,
  }
}

function history(runId = 'run-analysis', turnId = 'turn-analysis') {
  const events: JournalEventEnvelope[] = [
    envelope({ kind: 'workspace.opened', workspace: '/tmp/braid' }, 1),
    envelope({ kind: 'draft.changed', text: 'inspect the run' }, 2),
    envelope(
      {
        kind: 'run.requested',
        operationId: `operation-${runId}`,
        runId,
        turnId,
        userMessageId: `message-user-${runId}`,
        assistantMessageId: `message-assistant-${runId}`,
        text: 'inspect the run',
      },
      3,
    ),
    envelope(
      {
        kind: 'run.tool.call',
        runId,
        partId: `part-tool-${runId}`,
        toolName: 'shell',
        callId: `call-${runId}`,
        input: { command: 'printf safe' },
        provider: {
          eventId: `provider-call-${runId}`,
          providerSequence: 1,
          occurredAt: NOW,
        },
      },
      4,
    ),
    envelope(
      {
        kind: 'run.tool.result',
        runId,
        partId: `part-tool-${runId}`,
        toolName: 'shell',
        callId: `call-${runId}`,
        result: 'safe',
        provider: {
          eventId: `provider-result-${runId}`,
          providerSequence: 2,
          occurredAt: NOW,
        },
      },
      5,
    ),
    envelope(
      {
        kind: 'run.text.delta',
        runId,
        text: 'completed',
        provider: {
          eventId: `provider-text-${runId}`,
          providerSequence: 3,
          occurredAt: NOW,
        },
      },
      6,
    ),
    envelope(
      {
        kind: 'run.finished',
        runId,
        status: 'completed',
        finalText: 'completed',
        usage: { input: 4, output: 2 },
      },
      7,
    ),
  ]
  return { events, state: replayEvents(initialState(TEST_PROFILE), events) }
}

function host(
  state: ReturnType<typeof history>['state'],
  events: readonly JournalEventEnvelope[],
): AnalysisApplicationHost & { readonly committed: BraidEvent[] } {
  const committed: BraidEvent[] = []
  return {
    currentState: () => state,
    eventHistory: () => events,
    commit: (event) => {
      committed.push(event)
    },
    now: () => NOW,
    committed,
  }
}

function findingFor(evidence: FrozenAnalysisEvidence): AnalystFinding {
  const spanId = buildAnalysisTraceStore(evidence).spans[0]?.spanId
  assert.ok(spanId)
  return {
    schema_version: '1.0.0',
    finding_id: 'finding-shell',
    analyst_id: 'efficiency-behavioral',
    produced_at: NOW,
    severity: 'medium',
    area: 'tool-use',
    claim: 'The shell trace is supported',
    confidence: 0.9,
    evidence_refs: [
      {
        kind: 'span',
        uri: `trace://${evidence.source.runId}/span/${spanId}`,
        excerpt: 'shell',
      },
    ],
  }
}

function fakeRegistry(
  options: {
    readonly findings?: readonly AnalystFinding[]
    readonly failure?: string
    readonly waitForAbort?: boolean
    readonly received?: { options?: unknown; inputs?: unknown }
  } = {},
): AnalystRegistryPort {
  const runExactStream: AnalystRegistryPort['runExactStream'] = async function* (
    runId,
    inputs,
    runOptions,
  ): AsyncGenerator<ExactAnalystRunEvent, void, void> {
    if (options.received !== undefined) {
      options.received.options = runOptions
      options.received.inputs = inputs
    }
    yield {
      type: 'run-started',
      run_id: runId,
      correlation_id: 'correlation-test',
      started_at: NOW,
      analyst_ids: runOptions.analystIds,
      execution_plan: {},
    } as unknown as ExactAnalystRunEvent
    if (options.waitForAbort) {
      await new Promise<void>((resolve) => {
        if (runOptions.signal?.aborted) {
          resolve()
          return
        }
        runOptions.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      return
    }
    const findings = [...(options.findings ?? [])]
    const summary = {
      analyst_id: runOptions.analystIds[0] ?? 'efficiency-behavioral',
      status: options.failure === undefined ? 'ok' : 'failed',
      findings_count: findings.length,
      latency_ms: 1,
      usage: {
        calls: 0,
        tokens: null,
        cost: { kind: 'known', usd: 0 },
        knownCostUsd: 0,
      },
      ...(options.failure === undefined
        ? {}
        : { error: { class: 'Error', message: options.failure } }),
    } as const
    yield {
      type: 'analyst-started',
      analyst_id: runOptions.analystIds[0] ?? 'efficiency-behavioral',
      started_at: NOW,
    } as unknown as ExactAnalystRunEvent
    yield {
      type: 'analyst-completed',
      analyst_id: runOptions.analystIds[0] ?? 'efficiency-behavioral',
      findings,
      summary,
    } as unknown as ExactAnalystRunEvent
    const result: ExactAnalystRunResult = {
      run_id: runId,
      correlation_id: 'correlation-test',
      started_at: NOW,
      ended_at: NOW,
      findings,
      per_analyst: [summary],
      total_cost_usd: 0,
      execution_plan: {},
      completion: { status: 'complete' },
    } as unknown as ExactAnalystRunResult
    yield { type: 'run-completed', result } as unknown as ExactAnalystRunEvent
  }
  return {
    list: () => [
      {
        id: 'efficiency-behavioral',
        description: 'test analyst',
        version: '2.0.0',
        cost: { kind: 'deterministic' },
      },
      {
        id: BRAID_QUESTION_ANALYST_ID,
        description: 'test question analyst',
        version: '1.0.0',
        cost: { kind: 'deterministic' },
      },
    ],
    runExactStream,
  }
}

test('freezing a source holds the original digest when later journal events arrive', () => {
  const first = history()
  const evidence = freezeAnalysisSource({
    state: first.state,
    events: first.events,
    runId: 'run-analysis',
  })
  const originalDigest = evidence.source.digest
  const late = [
    ...first.events,
    envelope({ kind: 'run.text.delta', runId: 'run-analysis', text: 'late event' }, 8),
  ]
  const laterEvidence = freezeAnalysisSource({
    state: first.state,
    events: late,
    runId: 'run-analysis',
  })
  assert.equal(laterEvidence.source.digest, originalDigest)
  assert.equal(evidence.source.digest, originalDigest)
  assert.equal(
    evidence.events.some(
      (event) => event.event.kind === 'run.text.delta' && event.event.text === 'late event',
    ),
    false,
  )
  assert.equal(Object.isFrozen(evidence), true)
})

test('frozen source verification rejects tampered evidence', () => {
  const first = history()
  const evidence = freezeAnalysisSource({
    state: first.state,
    events: first.events,
    runId: 'run-analysis',
  })
  const tampered = {
    ...evidence,
    source: { ...evidence.source, digest: '0'.repeat(64) },
  } as FrozenAnalysisEvidence
  assert.throws(() => verifyFrozenAnalysisSource(tampered), AnalysisSourceError)
})

test('trace analysis keeps run identity, outcome, usage, and merged tools in one bounded view', async () => {
  const evidence = analysisEvidence('trace-projection').evidence
  const trace = buildAnalysisTraceStore(evidence)
  const prepared = await BRAID_QUESTION_ANALYST_DEFINITION.prepareContext(trace.store)
  assert.match(prepared, /Exact trace id: "run-analysis-trace-projection"/u)
  assert.match(prepared, /SUBMIT\(answer, json\.dumps\(findings\)\)/u)
  assert.match(prepared, /Omit subject from every finding/u)
  const view = await trace.store.viewTrace({ trace_id: trace.traceId })
  assert.equal('spans' in view, true)
  if (!('spans' in view)) return

  assert.equal(view.spans.length, 4)
  const requested = view.spans.find((span) => span.name === 'braid.run.requested')
  const finished = view.spans.find((span) => span.name === 'braid.run.finished')
  const tool = view.spans.find((span) => span.tool_name === 'shell')
  assert.ok(requested)
  assert.ok(finished)
  assert.ok(tool)
  assert.equal(requested.agent_name, 'Braid starter')
  assert.equal(requested.model_name, 'fixture/deterministic')
  assert.equal(requested.attributes['braid.runner'], 'pi')
  assert.equal(requested.attributes['braid.provider'], 'fixture-analysis-provider')
  assert.equal(requested.attributes['input.value'], 'Analyze trace-projection.')
  assert.equal(finished.attributes['output.value'], 'Observed safe output for trace-projection.')
  assert.equal(finished.attributes['llm.token_count.prompt'], 100)
  assert.equal(finished.attributes['llm.token_count.completion'], 50)
  assert.equal(tool.attributes['output.value'], 'safe trace-projection')

  const toolReference = trace.spans.find((span) => span.toolName === 'shell')
  assert.ok(toolReference)
  const finding: AnalystFinding = {
    schema_version: '1.0.0',
    finding_id: 'finding-tool-result-source',
    analyst_id: 'efficiency-behavioral',
    produced_at: NOW,
    severity: 'info',
    area: 'tool-use',
    claim: 'The tool result is present.',
    confidence: 1,
    evidence_refs: [
      {
        kind: 'span',
        uri: `trace://${trace.traceId}/span/${toolReference.spanId}`,
        excerpt: 'safe trace-projection',
      },
    ],
  }
  const mapped = mapAnalystFinding(evidence, trace, finding)
  const resultEvent = evidence.events.find((event) => event.event.kind === 'run.tool.result')
  assert.equal(mapped.citations[0]?.eventId, resultEvent?.id)
})

test('trace text projection redacts credentials and enforces its byte limit', () => {
  const credential = `sk-${'a'.repeat(32)}`
  const projected = safeAnalysisText(`${credential}\n${'x'.repeat(32 * 1024)}`)
  assert.equal(projected.includes(credential), false)
  assert.equal(Buffer.byteLength(projected, 'utf8') <= 16 * 1024, true)
})

test('eval adapter routes exact streaming and reports missing named analysts', async () => {
  const first = history()
  const evidence = freezeAnalysisSource({
    state: first.state,
    events: first.events,
    runId: 'run-analysis',
  })
  const received: { options?: unknown; inputs?: unknown } = {}
  const adapter = new AgentEvalAnalystAdapter(fakeRegistry({ received }))
  const trace = buildAnalysisTraceStore(evidence)
  const events: unknown[] = []
  for await (const item of adapter.stream({
    runId: 'analysis-run-test',
    sourceDigest: String(evidence.source.digest),
    trace,
    recipe: 'cost',
  }))
    events.push(item.event.type)
  assert.deepEqual(events, ['run-started', 'analyst-started', 'analyst-completed', 'run-completed'])
  assert.deepEqual((received.options as { analystIds: string[] }).analystIds, [
    'efficiency-behavioral',
  ])
  assert.throws(
    () => new AgentEvalAnalystAdapter().resolveAnalystIds({ recipe: 'failure' }),
    (error: unknown) => error instanceof Error && 'issue' in error,
  )
})

test('/ask routes one question analyst and forwards the exact operator question', async () => {
  const first = history()
  const evidence = freezeAnalysisSource({
    state: first.state,
    events: first.events,
    runId: 'run-analysis',
  })
  const received: { options?: unknown; inputs?: unknown } = {}
  const adapter = new AgentEvalAnalystAdapter(fakeRegistry({ received }))
  const question = 'What changed, what was verified, and what should I review?'

  for await (const _item of adapter.stream({
    runId: 'analysis-run-question',
    sourceDigest: String(evidence.source.digest),
    trace: buildAnalysisTraceStore(evidence),
    recipe: 'ask',
    question,
  })) {
    // Drain the exact stream so the captured options are final.
  }

  const options = received.options as {
    analystIds: readonly string[]
    tags: Readonly<Record<string, string>>
  }
  assert.deepEqual(options.analystIds, [BRAID_QUESTION_ANALYST_ID])
  assert.equal(options.tags.focus, question)
})

test('analysis usage preserves uncaptured cost as an unknown lower bound', async () => {
  const first = history()
  const evidence = freezeAnalysisSource({
    state: first.state,
    events: first.events,
    runId: 'run-analysis',
  })
  const request = { runId: 'run-analysis', recipe: 'cost' } as AnalysisRequest
  const identity = analysisIdentity({
    kind: 'analysis',
    sourceDigests: [String(evidence.source.digest)],
    request,
  })
  const applicationHost = host(first.state, first.events)
  const base = initialAnalysisRecord({
    host: applicationHost,
    evidence,
    request,
    identity,
    at: NOW,
  })
  const result = {
    run_id: String(identity.analysisRunId),
    correlation_id: 'correlation-test',
    started_at: NOW,
    ended_at: NOW,
    findings: [],
    per_analyst: [
      {
        analyst_id: 'efficiency-behavioral',
        usage: {
          calls: 1,
          tokens: null,
          cost: { kind: 'uncaptured', usd: null },
          knownCostUsd: 0.123,
        },
      },
    ],
    total_cost_usd: 0.123,
    total_cost_provenance: { kind: 'uncaptured', usd: null },
    execution_plan: {},
    completion: { status: 'complete' },
  } as unknown as ExactAnalystRunResult
  const record = await completedAnalysisRecord({
    host: applicationHost,
    base,
    evidence,
    request,
    identity,
    analystIds: [],
    descriptors: [],
    modelExecutions: [],
    result,
    at: NOW,
  })

  assert.deepEqual(record.usage, {
    input: 0,
    output: 0,
    tokensKnown: false,
    costUsd: 0.123,
    usdKnown: false,
  })
  assert.equal(record.costUsd, undefined)
})

test('analysis usage and presentation preserve estimated cost provenance', async () => {
  const first = history()
  const evidence = freezeAnalysisSource({
    state: first.state,
    events: first.events,
    runId: 'run-analysis',
  })
  const request = { runId: 'run-analysis', recipe: 'cost' } as AnalysisRequest
  const identity = analysisIdentity({
    kind: 'analysis',
    sourceDigests: [String(evidence.source.digest)],
    request,
  })
  const applicationHost = host(first.state, first.events)
  const base = initialAnalysisRecord({
    host: applicationHost,
    evidence,
    request,
    identity,
    at: NOW,
  })
  const result = {
    run_id: String(identity.analysisRunId),
    correlation_id: 'correlation-test',
    started_at: NOW,
    ended_at: NOW,
    findings: [],
    per_analyst: [
      {
        analyst_id: 'efficiency-behavioral',
        usage: {
          calls: 1,
          tokens: { input: 10, output: 2 },
          cost: { kind: 'estimated', usd: 0.123 },
        },
      },
    ],
    total_cost_usd: 0.123,
    total_cost_provenance: { kind: 'estimated', usd: 0.123 },
    execution_plan: {},
    completion: { status: 'complete' },
  } as unknown as ExactAnalystRunResult
  const record = await completedAnalysisRecord({
    host: applicationHost,
    base,
    evidence,
    request,
    identity,
    analystIds: [],
    descriptors: [],
    modelExecutions: [],
    result,
    at: NOW,
  })

  assert.deepEqual(record.usage, {
    input: 10,
    output: 2,
    estimatedCostUsd: 0.123,
    usdKnown: false,
  })
  assert.equal(record.costUsd, undefined)
  assert.deepEqual(
    analysisViewForRecord(record).footer.find((field) => field.label.includes('cost')),
    { label: 'analysis cost estimate', value: '~$0.1230' },
  )
})

test('analysis service persists only analysis events, emits progress, and preserves citations', async () => {
  const first = history()
  const evidence = freezeAnalysisSource({
    state: first.state,
    events: first.events,
    runId: 'run-analysis',
  })
  const finding = findingFor(evidence)
  const applicationHost = host(first.state, first.events)
  const service = new AnalysisService(
    applicationHost,
    new AgentEvalAnalystAdapter(fakeRegistry({ findings: [finding] })),
  )
  const result = await service.run({ runId: 'run-analysis', recipe: 'cost' })
  assert.equal(result.status, 'completed')
  assert.equal(result.analysis.findings[0]?.supported, true)
  assert.equal(result.analysis.findings[0]?.citations.length, 1)
  assert.deepEqual(
    applicationHost.committed
      .filter((event) => event.kind.startsWith('analysis.'))
      .map((event) => event.kind),
    ['analysis.created', 'analysis.updated', 'analysis.completed'],
  )
  const analyzed = applicationHost.committed.find((event) => event.kind === 'graph.edge.upserted')
  assert.equal(analyzed?.kind, 'graph.edge.upserted')
  if (analyzed?.kind === 'graph.edge.upserted') {
    assert.equal(analyzed.edge.kind, 'analyzed')
    assert.equal(analyzed.edge.provenance.sourceDigest, evidence.source.digest)
  }
  assert.equal(
    applicationHost.committed.some((event) => event.kind === 'run.text.delta'),
    false,
  )
})

test('analysis service fails when one exact analyst reports a failed summary', async () => {
  const first = history()
  const applicationHost = host(first.state, first.events)
  const service = new AnalysisService(
    applicationHost,
    new AgentEvalAnalystAdapter(
      fakeRegistry({ failure: 'question analyst returned no cited answer' }),
    ),
  )

  const result = await service.run({ runId: 'run-analysis', recipe: 'cost' })

  assert.equal(result.status, 'failed')
  assert.match(result.error?.message ?? '', /question analyst returned no cited answer/u)
  assert.equal(
    applicationHost.committed.some((event) => event.kind === 'analysis.completed'),
    false,
  )
})

test('analysis cancellation aborts the analyst stream without cancelling the source run', async () => {
  const first = history()
  const applicationHost = host(first.state, first.events)
  const service = new AnalysisService(
    applicationHost,
    new AgentEvalAnalystAdapter(fakeRegistry({ waitForAbort: true })),
  )
  const iterator = service.stream({ runId: 'run-analysis', recipe: 'cost' })
  const started = (await iterator.next()).value
  assert.equal(started?.type, 'started')
  await iterator.next()
  await iterator.next()
  const analysisId =
    started?.type === 'started' ? started.analysis.id : createAnalysisId('analysis-test')
  const pending = iterator.next()
  assert.equal(service.cancel(analysisId), true)
  const terminal = (await pending).value
  assert.equal(terminal?.type, 'cancelled')
  assert.equal(
    applicationHost.committed.some((event) => event.kind === 'run.cancel.requested'),
    false,
  )
})

test('paired comparison delegates facts to agent-eval and exposes missing semantic judging', async () => {
  const baseline = history('run-baseline', 'turn-paired')
  const candidate = history('run-candidate', 'turn-paired')
  const baselineEvidence = freezeAnalysisSource({
    state: baseline.state,
    events: baseline.events,
    runId: 'run-baseline',
  })
  const candidateEvidence = freezeAnalysisSource({
    state: candidate.state,
    events: candidate.events,
    runId: 'run-candidate',
  })
  const result = compareFrozenRuns({
    baseline: baselineEvidence,
    candidate: candidateEvidence,
    bootstrapSeed: 7,
  })
  assert.equal(result.paired.nPairs, 1)
  assert.equal(result.paired.nUnpairedBaseline, 0)
  assert.equal(result.paired.nUnpairedTreatment, 0)
  assert.equal(result.semantic.status, 'unavailable')
  const combinedState = {
    ...baseline.state,
    runs: [...baseline.state.runs, ...candidate.state.runs],
  }
  const combinedEvents = [
    ...baseline.events,
    ...candidate.events.map((event) => ({
      ...event,
      sequence: event.sequence + 10,
      revision: event.revision + 10,
    })),
  ]
  const comparison = await new AnalysisComparisonService(
    host(combinedState, combinedEvents),
  ).compare({
    baseline: { runId: 'run-baseline' },
    candidate: { runId: 'run-candidate' },
  })
  assert.equal(comparison.paired.nPairs, 1)
})

test('saved comparisons restore without changing their measured facts', () => {
  const baseline = history('run-baseline-restored', 'turn-paired-restored')
  const candidate = history('run-candidate-restored', 'turn-paired-restored')
  const baselineEvidence = freezeAnalysisSource({
    state: baseline.state,
    events: baseline.events,
    runId: 'run-baseline-restored',
  })
  const candidateEvidence = freezeAnalysisSource({
    state: candidate.state,
    events: candidate.events,
    runId: 'run-candidate-restored',
  })
  const result = compareFrozenRuns({ baseline: baselineEvidence, candidate: candidateEvidence })
  const record = {
    id: createAnalysisId('analysis-comparison-restored'),
    kind: 'comparison',
    source: baselineEvidence.source,
    status: 'completed',
    findings: [],
    comparison: comparisonSnapshot(baselineEvidence, candidateEvidence, result),
    createdAt: NOW,
    updatedAt: NOW,
  } satisfies AnalysisRecord

  const restored = resultFromComparisonRecord(record)
  assert.equal(restored.replayed, true)
  assert.deepEqual(restored.rows, result.rows)
  assert.deepEqual(restored.paired, result.paired)
  assert.deepEqual(restored.fields, result.fields)
})

test('promotion records selected finding provenance as a graph attachment', async () => {
  const first = history()
  const evidence = freezeAnalysisSource({
    state: first.state,
    events: first.events,
    runId: 'run-analysis',
  })
  const finding = mapAnalystFinding(
    evidence,
    buildAnalysisTraceStore(evidence),
    findingFor(evidence),
  )
  const analysis: AnalysisRecord = {
    id: createAnalysisId('analysis-promotion-test'),
    analysisRunId: 'analysis-run-promotion',
    source: evidence.source,
    status: 'completed',
    findings: [finding],
    createdAt: NOW,
    updatedAt: NOW,
  }
  const applicationHost = host({ ...first.state, analyses: [analysis] }, first.events)
  const attachment = await new AnalysisPromotionService(applicationHost).promote({
    analysis,
    selectedFindingIds: [finding.id],
    destinationConversationId: first.state.conversationId,
    destinationBranchId: first.state.branchId,
  })
  assert.equal(attachment.sourceDigest, String(evidence.source.digest))
  assert.equal(attachment.selectedFindings.length, 1)
  const edge = applicationHost.committed.find((event) => event.kind === 'graph.edge.upserted')
  assert.equal(edge?.kind, 'graph.edge.upserted')
  if (edge?.kind === 'graph.edge.upserted')
    assert.equal(edge.edge.provenance.sourceDigest, evidence.source.digest)
})

test('runtime supervisor adapter reads snapshots, persists projections, and leaves worker cancel unavailable', async () => {
  const spend = { iterations: 1, tokensInput: 2, tokensOutput: 3, usd: 0.01, ms: 4 }
  const raw = {
    root: '/tmp/braid',
    generatedAt: Date.parse(NOW),
    supervisors: [
      {
        id: 'runtime-supervisor-1',
        status: 'running',
        task: 'inspect',
        workspaceDir: '/tmp/braid',
        budget: 1,
        stateDir: '/tmp/braid/.agent',
        workers: [
          {
            id: 'runtime-worker-1',
            label: 'worker-one',
            status: 'running',
            latencyMs: 4,
            spend,
            metered: spend,
            liveTail: ['safe progress'],
          },
        ],
        progressTail: [],
        journalTail: [],
        driverSpend: spend,
        totals: {
          workers: 1,
          running: 1,
          done: 0,
          down: 0,
          cancelled: 0,
          inFlight: 1,
          settled: 0,
          tokensInput: 2,
          tokensOutput: 3,
          tokensTotal: 5,
          usd: 0.01,
          latencyMs: 4,
          workerLatency: { n: 1, min: 4, median: 4, p90: 4, max: 4 },
        },
      },
    ],
  } as unknown as TopSnapshot
  const watcher = new RuntimeSupervisorWatcher(() => raw)
  const controller = new RuntimeSupervisorController({
    watcher,
    write: (_rootDir, supervisorId, workerLabel, message, source) => ({
      worker: workerLabel,
      file: '/tmp/braid/.agent/inbox/request.json',
      request: {
        id: 'request-1',
        at: NOW,
        supervisorId,
        worker: workerLabel,
        message,
        source: source ?? 'braid',
      },
    }),
  })
  const first = history()
  const applicationHost = host(first.state, first.events)
  const service = new SupervisorService(applicationHost, { watcher, controller })
  const projection = await service.snapshot({
    rootDir: '/tmp/braid',
    bindings: [{ runtimeSupervisorId: 'runtime-supervisor-1', rootRunId: 'run-analysis' }],
  })
  assert.equal(projection.supervisors.length, 1)
  assert.equal(projection.workers[0]?.status, 'running')
  assert.equal(
    applicationHost.committed.some((event) => event.kind === 'supervisor.upserted'),
    true,
  )
  assert.equal(
    applicationHost.committed.some((event) => event.kind === 'worker.upserted'),
    true,
  )
  const queued = await service.steerWorker(
    '/tmp/braid',
    'runtime-supervisor-1',
    'worker-one',
    'inspect this',
  )
  assert.equal(queued.status, 'queued')
  if (queued.status === 'queued') assert.equal(queued.requestId, 'request-1')
  const unavailable = await service.cancelWorker('runtime-worker-1')
  assert.equal(unavailable.status, 'unavailable')
  assert.equal(unavailable.issue.capability, 'supervisor.worker.cancel')
})
