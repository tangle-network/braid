import assert from 'node:assert/strict'
import test from 'node:test'
import { createBraidApplication, DETERMINISTIC_PROFILE } from '../src/app/composition.js'
import { importAnalysisModelCalls } from '../src/app/conversation-import-analyses.js'
import { MemoryJournal } from '../src/app/journal.js'
import { buildBraidViewModel } from '../src/adapters/tui/ui-view-model.js'
import { canonicalDigest } from '../src/domain/canonical.js'
import type { AnalysisRecord } from '../src/domain/entities.js'
import type { BraidEventEnvelope } from '../src/domain/events.js'
import { createAnalysisId, createEventId } from '../src/domain/ids.js'
import { replayEvents } from '../src/domain/reducer.js'
import { initialState } from '../src/domain/state.js'
import { FixedClock } from '../src/ports/clock.js'
import { analysisModelCallSummary } from '../src/views/shared/analysis-model-call-presentation.js'
import { queryDetails } from '../src/views/shared/semantic-details.js'

const startedAt = '2026-08-10T00:00:00.000Z'
const endedAt = '2026-08-10T00:00:00.088Z'

interface MutableExportDocument {
  content: Record<string, unknown>
  contentDigest: string
  [key: string]: unknown
}

function exportDocument(content: string): MutableExportDocument {
  return JSON.parse(content) as MutableExportDocument
}

function modelCallExport(): readonly Record<string, unknown>[] {
  return [
    {
      sequence: 1,
      callId: 'call-analysis-1',
      callRef: 'analysis-call-1',
      path: '/v1/responses',
      model: 'gpt-5.6-luna',
      provider: 'openai',
      route: 'cli-bridge',
      inputTokens: 120,
      outputTokens: 45,
      cachedTokens: '[redacted]',
      cacheWriteTokens: '[redacted]',
      tokensKnown: true,
      cost: { status: 'observed', usd: 0.0123 },
      latencyMs: 88,
      outcome: 'succeeded',
      responseStatus: 200,
      startedAt,
      endedAt,
    },
    {
      sequence: 2,
      callId: 'call-analysis-2',
      callRef: 'analysis-call-2',
      path: 'unknown-path',
      model: 'glm-5.2',
      tokensKnown: false,
      cost: { status: 'unknown' },
      outcome: 'failed',
    },
  ]
}

test('analysis model-call import preserves public facts and rejects payloads or secrets', () => {
  const calls = importAnalysisModelCalls(modelCallExport(), 'analyses[0].modelCalls')
  assert.ok(calls)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], {
    sequence: 1,
    callId: 'call-analysis-1',
    callRef: 'analysis-call-1',
    path: '/v1/responses',
    model: 'gpt-5.6-luna',
    provider: 'openai',
    route: 'cli-bridge',
    inputTokens: 120,
    outputTokens: 45,
    tokensKnown: true,
    cost: { status: 'observed', usd: 0.0123 },
    latencyMs: 88,
    outcome: 'succeeded',
    responseStatus: 200,
    startedAt,
    endedAt,
  })
  assert.equal(calls[1]?.cost.status, 'unknown')
  assert.equal(calls[1]?.path, 'unknown-path')
  assert.equal('cachedTokens' in (calls[0] ?? {}), false)

  assert.throws(
    () =>
      importAnalysisModelCalls(
        [{ ...modelCallExport()[0], prompt: 'do not retain this' }],
        'analyses[0].modelCalls',
      ),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'IMPORT_INVALID' &&
      !error.message.includes('do not retain this'),
  )
  assert.throws(
    () =>
      importAnalysisModelCalls(
        [{ ...modelCallExport()[0], provider: 'api_key=secret-value' }],
        'analyses[0].modelCalls',
      ),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'IMPORT_INVALID',
  )
  for (const path of [
    '/v1/chat/completions?api_key=secret',
    '/v1/chat/completions#fragment',
    '/v1/chat/completions/api_key',
  ]) {
    assert.throws(
      () => importAnalysisModelCalls([{ ...modelCallExport()[0], path }], 'analyses[0].modelCalls'),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'IMPORT_INVALID',
    )
  }
  for (const invalidCall of [
    { ...modelCallExport()[0], outputTokens: undefined },
    { ...modelCallExport()[0], responseStatus: 99 },
    { ...modelCallExport()[0], responseStatus: 200.5 },
  ]) {
    assert.throws(
      () => importAnalysisModelCalls([invalidCall], 'analyses[0].modelCalls'),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'IMPORT_INVALID',
    )
  }
})

test('analysis model calls survive event replay and appear as concise detail lines', () => {
  const calls = importAnalysisModelCalls(modelCallExport(), 'analyses[0].modelCalls')
  assert.ok(calls)
  const initial = initialState(DETERMINISTIC_PROFILE)
  const analysis: AnalysisRecord = {
    id: createAnalysisId('analysis-roundtrip'),
    source: {
      conversationId: initial.conversationId,
      branchId: initial.branchId,
      digest: canonicalDigest({ source: 'roundtrip-analysis' }),
      complete: true,
    },
    status: 'completed',
    findings: [],
    modelCalls: calls,
    wallTimeMs: 88,
    createdAt: startedAt,
    updatedAt: endedAt,
  }
  const event: BraidEventEnvelope = {
    eventId: createEventId('event-roundtrip-analysis'),
    sequence: 1,
    revision: 1,
    occurredAt: endedAt,
    event: { kind: 'analysis.created', analysis },
  }
  const restarted = replayEvents(initial, [event])
  const restored = restarted.analyses[0]
  assert.deepEqual(restored?.modelCalls, calls)

  const details = queryDetails(restarted, {
    entityType: 'analysis',
    entityId: analysis.id,
  })
  const modelCallField = details.fields.find((field) => field.label === 'modelCalls')
  assert.equal(
    modelCallField?.value,
    '#1 openai/gpt-5.6-luna · tokens 120 in / 45 out · cost $0.0123 · latency 88ms\n' +
      '#2 provider unknown/glm-5.2 · tokens unknown · cost unknown · latency unknown',
  )
  assert.equal(JSON.stringify(details).includes('secret-value'), false)

  const terminalView = buildBraidViewModel(restarted)
  const terminalDetail = terminalView.entityDetails?.find(
    (detail) => detail.entityType === 'analysis' && detail.entityId === analysis.id,
  )
  assert.deepEqual(terminalDetail?.analysisExecution, {
    observedModels: ['glm-5.2', 'gpt-5.6-luna'],
    modelCalls: calls.map((call) => ({
      sequence: call.sequence,
      ...(call.provider === undefined ? {} : { provider: call.provider }),
      model: call.model,
      ...(call.inputTokens === undefined ? {} : { inputTokens: call.inputTokens }),
      ...(call.outputTokens === undefined ? {} : { outputTokens: call.outputTokens }),
      tokensKnown: call.tokensKnown,
      ...(call.cost.usd === undefined ? {} : { costUsd: call.cost.usd }),
      costStatus: call.cost.status,
      ...(call.latencyMs === undefined ? {} : { latencyMs: call.latencyMs }),
      outcome: call.outcome,
    })),
    wallTimeMs: 88,
  })
  assert.match(terminalDetail?.lines.join('\n') ?? '', /model call #1 openai\/gpt-5\.6-luna/u)
})

test('analysis model-call summary keeps partial telemetry explicit', () => {
  assert.equal(
    analysisModelCallSummary([
      {
        sequence: 1,
        provider: 'openai',
        model: 'gpt-5.6-luna',
        inputTokens: 120,
        outputTokens: 45,
        tokensKnown: true,
        costUsd: 0.0123,
        costStatus: 'observed',
        latencyMs: 88,
        outcome: 'succeeded',
      },
      {
        sequence: 2,
        model: 'glm-5.2',
        tokensKnown: false,
        costStatus: 'unknown',
        outcome: 'failed',
      },
    ]),
    '2 calls · tokens ≥120 in / ≥45 out (+1 unknown) · cost ≥$0.0123 (+1 unknown) · model ≥88ms (+1 unknown) · 1 failed',
  )
})

test('analysis model-call summary distinguishes estimates from exact charges', () => {
  assert.equal(
    analysisModelCallSummary([
      {
        sequence: 1,
        model: 'gpt-5.6-luna',
        inputTokens: 20,
        outputTokens: 8,
        tokensKnown: true,
        costUsd: 0.0042,
        costStatus: 'estimated',
        latencyMs: 40,
        outcome: 'succeeded',
      },
    ]),
    '1 call · tokens 20 in / 8 out · cost ~$0.0042 · model 40ms',
  )
})

test('conversation export, import, re-export, and restart retain model calls', async () => {
  const source = createBraidApplication({ fixture: 'deterministic' })
  source.initialize('/source-workspace')
  const exported = await source.conversations.exports.export({
    operationId: 'op-model-call-source-export',
    format: 'json',
  })
  assert.ok(exported.content)
  const document = exportDocument(exported.content)
  const content = document.content
  const conversation = content.conversation as Record<string, unknown>
  const branches = content.branches as readonly Record<string, unknown>[]
  const branchId = branches[0]?.id
  assert.equal(typeof conversation.id, 'string')
  assert.equal(typeof branchId, 'string')
  const importedCalls = modelCallExport()
  content.analyses = [
    {
      id: 'analysis-model-call-export',
      source: {
        conversationId: conversation.id,
        branchId,
        digest: canonicalDigest({ source: 'model-call-export' }),
        complete: true,
      },
      status: 'completed',
      findings: [],
      modelCalls: importedCalls,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    },
  ]
  document.contentDigest = canonicalDigest(content)

  const journal = new MemoryJournal(new FixedClock())
  const app = createBraidApplication({ fixture: 'deterministic', journal })
  app.initialize('/target-workspace')
  const imported = await app.conversations.imports.import({
    operationId: 'op-model-call-import',
    content: JSON.stringify(document),
  })
  const analysis = app
    .state()
    .analyses.find((candidate) => candidate.source.conversationId === imported.conversationId)
  assert.ok(analysis)
  const expectedCalls = importAnalysisModelCalls(importedCalls, 'analyses[0].modelCalls')
  assert.deepEqual(analysis.modelCalls, expectedCalls)

  const reexported = await app.conversations.exports.export({
    operationId: 'op-model-call-reexport',
    conversationId: imported.conversationId,
    format: 'json',
  })
  assert.ok(reexported.content)
  const reexportDocument = exportDocument(reexported.content)
  const reexportAnalyses = reexportDocument.content.analyses as readonly Record<string, unknown>[]
  const reexportAnalysis = reexportAnalyses[0]
  assert.deepEqual(reexportAnalysis?.modelCalls, expectedCalls)

  const restarted = createBraidApplication({ fixture: 'deterministic', journal })
  const restored = restarted
    .state()
    .analyses.find((candidate) => candidate.source.conversationId === imported.conversationId)
  assert.deepEqual(restored?.modelCalls, expectedCalls)
})
