import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  AnalystFinding,
  ExactAnalystRunEvent,
  ExactAnalystRunResult,
} from '@tangle-network/agent-eval'
import type { AgentProfile } from '@tangle-network/agent-interface'
import {
  AgentEvalAnalystAdapter,
  type AnalystRegistryPort,
} from '../src/adapters/analysis/eval-analyst.js'
import { AnalysisComparisonService } from '../src/app/analysis-comparison.js'
import { AnalysisPromotionService } from '../src/app/analysis-promotion.js'
import { AnalysisService } from '../src/app/analysis-service.js'
import { freezeAnalysisSource } from '../src/app/analysis-source.js'
import type { AnalysisApplicationHost, FrozenAnalysisEvidence } from '../src/app/analysis-types.js'
import { AnalysisPersistenceError } from '../src/app/analysis-types.js'
import { createBraidApplication } from '../src/app/composition.js'
import { portablePlanForState } from '../src/app/conversation-context.js'
import { MemoryJournal } from '../src/app/journal.js'
import type { BraidEvent, JournalEventEnvelope } from '../src/domain/events.js'
import {
  createAnalysisId,
  createBranchId,
  createConversationId,
  createEventId,
} from '../src/domain/ids-values.js'
import { replayEvents } from '../src/domain/reducer.js'
import { type BraidState, initialState } from '../src/domain/state.js'
import { FixedClock } from '../src/ports/clock.js'

const NOW = '2026-08-03T20:00:00.000Z'
const PROFILE = {} as Readonly<AgentProfile>

function eventEnvelope(
  event: BraidEvent,
  sequence: number,
  prefix = 'event',
): JournalEventEnvelope {
  return {
    eventId: createEventId(`event-${prefix}-${sequence}`),
    sequence,
    revision: sequence,
    occurredAt: new Date(Date.parse(NOW) + sequence).toISOString(),
    event,
  }
}

function runHistory(runId: string, turnId: string): readonly JournalEventEnvelope[] {
  return [
    eventEnvelope({ kind: 'workspace.opened', workspace: '/tmp/braid' }, 1),
    eventEnvelope({ kind: 'draft.changed', text: 'inspect the run' }, 2),
    eventEnvelope(
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
    eventEnvelope(
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
    eventEnvelope(
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
    eventEnvelope(
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
    eventEnvelope(
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
}

class MemoryHost implements AnalysisApplicationHost {
  state: BraidState
  readonly committed: BraidEvent[] = []
  #events: JournalEventEnvelope[]
  #failureKind: string | undefined
  #failed = false

  constructor(events: readonly JournalEventEnvelope[]) {
    this.#events = [...events]
    this.state = replayEvents(initialState(PROFILE), this.#events)
  }

  eventHistory = (): readonly JournalEventEnvelope[] => this.#events

  currentState = (): BraidState => this.state

  commit = (event: BraidEvent): void => {
    this.append(event)
  }

  commitAndWait = async (event: BraidEvent): Promise<void> => {
    this.append(event)
  }

  now = (): string => NOW

  failNext(kind: string): void {
    this.#failureKind = kind
    this.#failed = false
  }

  private append(event: BraidEvent): void {
    if (event.kind === this.#failureKind && !this.#failed) {
      this.#failed = true
      throw new Error(`simulated crash at ${event.kind}`)
    }
    const envelope = eventEnvelope(event, this.state.sequence + 1, 'journal-event')
    this.#events = [...this.#events, envelope]
    this.committed.push(event)
    this.state = replayEvents(this.state, [envelope])
  }
}

class CrashJournal extends MemoryJournal {
  #failureKind: string | undefined
  #failed = false

  failNext(kind: string): void {
    this.#failureKind = kind
    this.#failed = false
  }

  override append(envelope: JournalEventEnvelope) {
    if (envelope.event.kind === this.#failureKind && !this.#failed) {
      this.#failed = true
      throw new Error(`simulated crash at ${envelope.event.kind}`)
    }
    return super.append(envelope)
  }
}

function publicApplication(
  journal: CrashJournal,
  calls: { count: number },
): ReturnType<typeof createBraidApplication> {
  return createBraidApplication({
    fixture: 'deterministic',
    clock: new FixedClock(NOW),
    journal,
    intelligence: { analyst: new AgentEvalAnalystAdapter(registry({ calls })) },
  })
}

async function publicSourceRun(
  app: ReturnType<typeof createBraidApplication>,
  text: string,
): Promise<string> {
  app.initialize('/tmp/braid-public')
  const receipt = app.send({
    operationId: `op-source-${String(app.state().runs.length + 1)}`,
    text,
  })
  await receipt.completion
  const runId = app.state().runs.at(-1)?.id
  assert.ok(runId)
  return String(runId)
}

function findingFor(evidence: FrozenAnalysisEvidence, id = 'finding-supported'): AnalystFinding {
  const event = evidence.events.find((candidate) => candidate.event.kind === 'run.text.delta')
  assert.ok(event)
  return {
    schema_version: '1.0.0',
    finding_id: id,
    analyst_id: 'efficiency-behavioral',
    produced_at: NOW,
    severity: 'medium',
    area: 'tool-use',
    claim: 'The frozen run is supported',
    confidence: 0.9,
    evidence_refs: [{ kind: 'event', uri: `event://${event.id}`, excerpt: 'completed' }],
  }
}

function unsupportedFinding(): AnalystFinding {
  return {
    schema_version: '1.0.0',
    finding_id: 'finding-unsupported',
    analyst_id: 'efficiency-behavioral',
    produced_at: NOW,
    severity: 'low',
    area: 'tool-use',
    claim: 'This finding has no frozen support',
    confidence: 0.2,
    evidence_refs: [{ kind: 'event', uri: 'event://missing-event', excerpt: 'missing' }],
  }
}

function registry(
  options: {
    readonly findings?: readonly AnalystFinding[]
    readonly calls?: { count: number }
  } = {},
): AnalystRegistryPort {
  const runExactStream: AnalystRegistryPort['runExactStream'] = async function* (
    runId,
    _inputs,
    runOptions,
  ): AsyncGenerator<ExactAnalystRunEvent, void, void> {
    if (options.calls !== undefined) options.calls.count += 1
    yield {
      type: 'run-started',
      run_id: runId,
      correlation_id: 'correlation-durable',
      started_at: NOW,
      analyst_ids: runOptions.analystIds,
      execution_plan: {},
    } as unknown as ExactAnalystRunEvent
    const findings = [...(options.findings ?? [])]
    yield {
      type: 'analyst-completed',
      analyst_id: runOptions.analystIds[0] ?? 'efficiency-behavioral',
      started_at: NOW,
      findings,
      summary: {},
    } as unknown as ExactAnalystRunEvent
    const result: ExactAnalystRunResult = {
      run_id: runId,
      correlation_id: 'correlation-durable',
      started_at: NOW,
      ended_at: NOW,
      findings,
      per_analyst: [],
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
        description: 'durable test analyst',
        version: '2.0.0',
        cost: { kind: 'deterministic' },
      },
    ],
    runExactStream,
  }
}

function singleHost(): MemoryHost {
  return new MemoryHost(runHistory('run-analysis', 'turn-analysis'))
}

function combinedHost(): MemoryHost {
  const baseline = runHistory('run-baseline', 'turn-paired')
  const candidate = runHistory('run-candidate', 'turn-candidate').map((event) => ({
    ...event,
    eventId: createEventId(`event-candidate-${event.sequence + 10}`),
    sequence: event.sequence + 7,
    revision: event.revision + 7,
  }))
  return new MemoryHost([...baseline, ...candidate])
}

test('stable operation identity replays exactly and rejects digest conflicts', async () => {
  const calls = { count: 0 }
  const host = singleHost()
  const service = new AnalysisService(host, new AgentEvalAnalystAdapter(registry({ calls })))
  const request = {
    runId: 'run-analysis',
    recipe: 'cost' as const,
    operationId: 'operation-stable',
  }
  const first = await service.run(request)
  const second = await service.run(request)
  assert.equal(first.analysis.id, second.analysis.id)
  assert.equal(second.replayed, true)
  assert.equal(calls.count, 1)
  await assert.rejects(
    () =>
      new AnalysisService(host, new AgentEvalAnalystAdapter(registry({ calls }))).run({
        ...request,
        question: 'different request',
      }),
    /different request|conflicting request digest|already reserved/u,
  )
  assert.equal(calls.count, 1)
})

test('a reservation crash leaves no external call and retries once after restart', async () => {
  const calls = { count: 0 }
  const crashed = singleHost()
  crashed.failNext('operation.requested')
  await assert.rejects(
    () =>
      new AnalysisService(crashed, new AgentEvalAnalystAdapter(registry({ calls }))).run({
        runId: 'run-analysis',
        recipe: 'cost',
        operationId: 'operation-reservation-crash',
      }),
    AnalysisPersistenceError,
  )
  assert.equal(calls.count, 0)
  const restarted = new MemoryHost(crashed.eventHistory())
  const result = await new AnalysisService(
    restarted,
    new AgentEvalAnalystAdapter(registry({ calls })),
  ).run({ runId: 'run-analysis', recipe: 'cost', operationId: 'operation-reservation-crash' })
  assert.equal(result.status, 'completed')
  assert.equal(calls.count, 1)
})

test('result commit crash reconciles to a safe replay without rerunning the analyst', async () => {
  const calls = { count: 0 }
  const crashed = singleHost()
  crashed.failNext('analysis.completed')
  await assert.rejects(
    () =>
      new AnalysisService(crashed, new AgentEvalAnalystAdapter(registry({ calls }))).run({
        runId: 'run-analysis',
        recipe: 'cost',
        operationId: 'operation-result-crash',
      }),
    AnalysisPersistenceError,
  )
  assert.equal(calls.count, 1)
  const restarted = new MemoryHost(crashed.eventHistory())
  const result = await new AnalysisService(
    restarted,
    new AgentEvalAnalystAdapter(registry({ calls })),
  ).run({ runId: 'run-analysis', recipe: 'cost', operationId: 'operation-result-crash' })
  assert.equal(result.status, 'failed')
  assert.equal(result.replayed, true)
  assert.equal(calls.count, 1)
  assert.equal(restarted.state.runs[0]?.status, 'completed')
})

test('graph edge crash replays the committed result and repairs graph without external work', async () => {
  const calls = { count: 0 }
  const crashed = singleHost()
  crashed.failNext('graph.edge.upserted')
  await assert.rejects(
    () =>
      new AnalysisService(crashed, new AgentEvalAnalystAdapter(registry({ calls }))).run({
        runId: 'run-analysis',
        recipe: 'cost',
        operationId: 'operation-graph-crash',
      }),
    AnalysisPersistenceError,
  )
  const restarted = new MemoryHost(crashed.eventHistory())
  const result = await new AnalysisService(
    restarted,
    new AgentEvalAnalystAdapter(registry({ calls })),
  ).run({ runId: 'run-analysis', recipe: 'cost', operationId: 'operation-graph-crash' })
  assert.equal(result.status, 'completed')
  assert.equal(result.replayed, true)
  assert.equal(calls.count, 1)
  assert.equal(
    restarted.state.graphEdges.some((edge) => edge.kind === 'analyzed'),
    true,
  )
})

test('comparison persists all captured fields and both explicit source edges', async () => {
  const host = combinedHost()
  const service = new AnalysisComparisonService(host)
  const input = {
    operationId: 'operation-comparison-durable',
    baseline: { runId: 'run-baseline' },
    candidate: { runId: 'run-candidate' },
  }
  const first = await service.compareAndStore(input)
  const second = await service.compareAndStore(input)
  assert.equal(second.replayed, true)
  assert.equal(
    first.fields.some((field) => field.asymmetry !== 'none'),
    true,
  )
  assert.equal(host.state.analyses.filter((analysis) => analysis.kind === 'comparison').length, 1)
  assert.equal(host.state.graphEdges.filter((edge) => edge.kind === 'compared_left').length, 1)
  assert.equal(host.state.graphEdges.filter((edge) => edge.kind === 'compared_right').length, 1)
  assert.equal(first.paired.nPairs, 1)
  assert.equal(first.paired.nUnpairedBaseline, 0)
  assert.equal(first.paired.nUnpairedTreatment, 0)
  assert.equal(new Set(first.rows.map((row) => row.pairKey)).size, 1)
  assert.deepEqual([...first.rows].map((row) => row.arm).sort(), ['baseline', 'candidate'])
  assert.deepEqual(host.state.analyses[0]?.request, {
    baseline: { runId: 'run-baseline' },
    candidate: { runId: 'run-candidate' },
  })
  assert.equal(first.semantic.status, 'unavailable')
})

test('public ask path retries an uncommitted reservation and replays a committed result', async () => {
  const calls = { count: 0 }
  const journal = new CrashJournal(new FixedClock(NOW))
  const first = publicApplication(journal, calls)
  const runId = await publicSourceRun(first, 'public ask source')
  const request = {
    runId,
    recipe: 'cost' as const,
    operationId: 'operation-public-ask-retry',
  }

  journal.failNext('operation.requested')
  await assert.rejects(() => first.intelligence.analysis.run(request), AnalysisPersistenceError)
  assert.equal(calls.count, 0)
  await first.close().catch(() => undefined)

  const restarted = publicApplication(journal, calls)
  const completed = await restarted.intelligence.analysis.run(request)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.replayed, undefined)
  assert.equal(calls.count, 1)
  assert.deepEqual(restarted.state().analyses[0]?.request, { runId, recipe: 'cost' })

  const replay = await restarted.intelligence.analysis.run(request)
  assert.equal(replay.status, 'completed')
  assert.equal(replay.replayed, true)
  assert.equal(calls.count, 1)
  await restarted.close()
})

test('public ask path does not rerun after the result commit crashes', async () => {
  const calls = { count: 0 }
  const journal = new CrashJournal(new FixedClock(NOW))
  const first = publicApplication(journal, calls)
  const runId = await publicSourceRun(first, 'public ask result crash')
  const request = {
    runId,
    recipe: 'tools' as const,
    operationId: 'operation-public-ask-result-crash',
  }

  journal.failNext('analysis.completed')
  await assert.rejects(() => first.intelligence.analysis.run(request), AnalysisPersistenceError)
  assert.equal(calls.count, 1)
  await first.close().catch(() => undefined)

  const restarted = publicApplication(journal, calls)
  const replay = await restarted.intelligence.analysis.run(request)
  assert.equal(replay.status, 'failed')
  assert.equal(replay.replayed, true)
  assert.equal(calls.count, 1)
  await restarted.close()
})

test('public compare path completes the persisted comparison after a result commit crash', async () => {
  const journal = new CrashJournal(new FixedClock(NOW))
  const calls = { count: 0 }
  const first = publicApplication(journal, calls)
  const baselineRunId = await publicSourceRun(first, 'public baseline')
  const candidateRunId = await publicSourceRun(first, 'public candidate')
  const input = {
    operationId: 'operation-public-compare-result-crash',
    baseline: { runId: baselineRunId },
    candidate: { runId: candidateRunId },
  }

  journal.failNext('analysis.completed')
  await assert.rejects(
    () => first.intelligence.comparison.compareAndStore(input),
    AnalysisPersistenceError,
  )
  await first.close().catch(() => undefined)

  const restarted = publicApplication(journal, calls)
  const replay = await restarted.intelligence.comparison.compareAndStore(input)
  assert.equal(replay.replayed, true)
  assert.equal(replay.paired.nPairs, 1)
  assert.equal(replay.paired.nUnpairedBaseline, 0)
  assert.equal(replay.paired.nUnpairedTreatment, 0)
  assert.equal(
    restarted.state().analyses.filter((analysis) => analysis.kind === 'comparison').length,
    1,
  )
  assert.equal(
    restarted.state().operations.find((operation) => operation.id === input.operationId)?.status,
    'terminal',
  )
  await restarted.close()
})

test('public promotion requires the persisted analysis and a matching destination branch', async () => {
  const journal = new CrashJournal(new FixedClock(NOW))
  const calls = { count: 0 }
  const app = publicApplication(journal, calls)
  const runId = await publicSourceRun(app, 'public promotion source')
  const analysisResult = await app.intelligence.analysis.run({
    runId,
    recipe: 'cost',
    operationId: 'operation-public-promotion-source',
  })
  const persisted = app
    .state()
    .analyses.find((candidate) => candidate.id === analysisResult.analysis.id)
  assert.ok(persisted)
  const destinationConversationId = app.state().conversationId
  const destinationBranchId = app.state().branchId

  await assert.rejects(
    () =>
      app.intelligence.promotion.promote({
        operationId: 'operation-public-promotion-unpersisted',
        analysis: { ...persisted, id: createAnalysisId('analysis-unpersisted') },
        selectedFindingIds: [],
        destinationConversationId,
        destinationBranchId,
      }),
    /not durably persisted/u,
  )
  await assert.rejects(
    () =>
      app.intelligence.promotion.promote({
        operationId: 'operation-public-promotion-fabricated',
        analysis: { ...persisted, question: 'tampered caller bytes' },
        selectedFindingIds: [],
        destinationConversationId,
        destinationBranchId,
      }),
    /does not match its persisted record/u,
  )
  await assert.rejects(
    () =>
      app.intelligence.promotion.promote({
        operationId: 'operation-public-promotion-missing-branch',
        analysis: persisted,
        selectedFindingIds: [],
        destinationConversationId,
        destinationBranchId: createBranchId('branch-missing-destination'),
      }),
    /does not exist/u,
  )
  await assert.rejects(
    () =>
      app.intelligence.promotion.promote({
        operationId: 'operation-public-promotion-wrong-conversation',
        analysis: persisted,
        selectedFindingIds: [],
        destinationConversationId: createConversationId('conversation-other'),
        destinationBranchId,
      }),
    /does not belong to conversation/u,
  )
  assert.equal(app.state().analysisAttachments.length, 0)
  await app.close()
})

test('promotion persists only selected supported findings and portable forks carry external analysis', async () => {
  const calls = { count: 0 }
  const sourceHost = singleHost()
  const evidence = freezeAnalysisSource({
    state: sourceHost.state,
    events: sourceHost.eventHistory(),
    runId: 'run-analysis',
  })
  const supported = findingFor(evidence)
  const unsupported = unsupportedFinding()
  const analyzed = await new AnalysisService(
    sourceHost,
    new AgentEvalAnalystAdapter(registry({ calls, findings: [supported, unsupported] })),
  ).run({ runId: 'run-analysis', recipe: 'cost', operationId: 'operation-promotion-source-2' })
  assert.equal(analyzed.analysis.findings.length, 2)
  const analysis = analyzed.analysis
  const crashed = new MemoryHost(sourceHost.eventHistory())
  crashed.failNext('analysis.attachment.created')
  await assert.rejects(
    () =>
      new AnalysisPromotionService(crashed).promote({
        operationId: 'operation-promotion-crash',
        analysis,
        selectedFindingIds: [supported.finding_id],
        destinationConversationId: sourceHost.state.conversationId,
        destinationBranchId: sourceHost.state.branchId,
      }),
    AnalysisPersistenceError,
  )
  const restarted = new MemoryHost(crashed.eventHistory())
  const attachment = await new AnalysisPromotionService(restarted).promote({
    operationId: 'operation-promotion-retry',
    analysis,
    selectedFindingIds: [supported.finding_id],
    destinationConversationId: sourceHost.state.conversationId,
    destinationBranchId: sourceHost.state.branchId,
  })
  assert.equal(attachment.selectedFindings.length, 1)
  assert.equal(attachment.selectedFindings[0]?.id, supported.finding_id)
  assert.equal(restarted.state.analysisAttachments.length, 1)
  const plan = portablePlanForState(restarted.state, { branchId: sourceHost.state.branchId })
  assert.equal(plan.analysisAttachments?.length, 1)
  assert.equal(plan.analysisAttachments?.[0]?.findings.length, 1)
  assert.equal(plan.analysisAttachments?.[0]?.analysisId, String(analysis.id))
})
