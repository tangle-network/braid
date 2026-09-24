import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import { openSqliteStorage } from '../src/adapters/storage/sqlite.js'
import { buildBraidViewModel } from '../src/adapters/tui/ui-view-model.js'
import {
  commitApplicationEvent,
  commitApplicationEventAsync,
} from '../src/app/application-support.js'
import { createBraidApplication, DETERMINISTIC_PROFILE } from '../src/app/composition.js'
import { importAnalysisModelCalls } from '../src/app/conversation-import-analyses.js'
import { MemoryJournal } from '../src/app/journal.js'
import { StorageJournal } from '../src/app/storage-journal.js'
import { canonicalDigest } from '../src/domain/canonical.js'
import type { AnalysisRecord } from '../src/domain/entities.js'
import type { BraidEventEnvelope } from '../src/domain/events.js'
import { createAnalysisId, createEventId } from '../src/domain/ids.js'
import { redactBraidEvent } from '../src/domain/redaction.js'
import { replayEvents } from '../src/domain/reducer.js'
import { initialState } from '../src/domain/state.js'
import { FixedClock } from '../src/ports/clock.js'
import { credentialRef } from '../src/ports/credentials.js'
import {
  analysisMeasuredModelCallLine,
  analysisMeasuredModelCallSummary,
  analysisModelCallSummary,
} from '../src/views/shared/analysis-model-call-presentation.js'
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
    usage: {
      input: 165,
      output: 53,
      tokensKnown: false,
      estimatedCostUsd: 0.014,
      usdKnown: false,
    },
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
      '#2 glm-5.2 · tokens unknown · cost unknown · latency unknown',
  )
  assert.deepEqual(details.data.usage, {
    input: 165,
    output: 53,
    tokensKnown: false,
    estimatedCostUsd: 0.014,
    usdKnown: false,
  })
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

test('large analysis source ranges retain valid event IDs through encrypted commit and replay', async (t) => {
  const initial = initialState(DETERMINISTIC_PROFILE)
  const sourceEventIds = Array.from({ length: 2_500 }, (_, index) =>
    createEventId(`event-source-${index}-${'a'.repeat(16)}`),
  )
  const analysis: AnalysisRecord = {
    id: createAnalysisId('analysis-large-source-range'),
    source: {
      conversationId: initial.conversationId,
      branchId: initial.branchId,
      digest: canonicalDigest({ source: 'large-source-range' }),
      complete: true,
    },
    sourceRange: {
      eventIds: sourceEventIds,
      messageIds: [],
      messagePartIds: [],
      firstSequence: 1,
      lastSequence: sourceEventIds.length,
    },
    status: 'preparing',
    findings: [],
    createdAt: startedAt,
    updatedAt: startedAt,
  }
  const journal = new MemoryJournal(new FixedClock(startedAt))
  const sanitizedSensitive = redactBraidEvent({
    kind: 'analysis.created',
    analysis: { ...analysis, request: { apiKey: 'secret-canary' } },
  })
  assert.equal(JSON.stringify(sanitizedSensitive).includes('secret-canary'), false)
  const providerEventIds = new Set<string>()
  const committed = commitApplicationEvent({
    state: initial,
    event: { kind: 'analysis.created', analysis },
    journal,
    clock: new FixedClock(startedAt),
    providerEventKeys: {
      hasProviderEvent: (key) => providerEventIds.has(key),
      addProviderEvent: (key) => {
        providerEventIds.add(key)
      },
    },
    subscribers: new Set(),
  })
  assert.deepEqual(committed.analyses[0]?.sourceRange?.eventIds, sourceEventIds)
  assert.deepEqual(
    replayEvents(initial, journal.all()).analyses[0]?.sourceRange?.eventIds,
    sourceEventIds,
  )

  const root = await mkdtemp(join(tmpdir(), 'braid-analysis-range-'))
  const databasePath = join(root, 'braid.sqlite')
  const credentials = new MemoryCredentialStore()
  const databaseKeyRef = credentialRef('cred:v1:analysis-range-test')
  let storage = await openSqliteStorage({
    path: databasePath,
    workspaceRoot: root,
    credentialStore: credentials,
    databaseKeyRef,
  })
  t.after(async () => {
    await storage.close()
    await rm(root, { force: true, recursive: true })
  })
  const durableJournal = await StorageJournal.fromStorage(storage, new FixedClock(startedAt))
  const durable = await commitApplicationEventAsync({
    state: initial,
    event: { kind: 'analysis.created', analysis },
    journal: durableJournal,
    clock: new FixedClock(startedAt),
    providerEventKeys: {
      hasProviderEvent: (key) => providerEventIds.has(key),
      addProviderEvent: (key) => {
        providerEventIds.add(key)
      },
    },
    subscribers: new Set(),
  })
  assert.deepEqual(durable.analyses[0]?.sourceRange?.eventIds, sourceEventIds)
  const firstSourceEventId = sourceEventIds[0]
  assert.ok(firstSourceEventId)
  assert.equal((await readFile(databasePath)).includes(Buffer.from(firstSourceEventId)), false)
  await storage.close()
  storage = await openSqliteStorage({
    path: databasePath,
    workspaceRoot: root,
    credentialStore: credentials,
    databaseKeyRef,
  })
  const reopenedJournal = await StorageJournal.fromStorage(storage, new FixedClock(startedAt))
  const restored = replayEvents(initial, reopenedJournal.replay())
  assert.deepEqual(restored.analyses[0]?.sourceRange?.eventIds, sourceEventIds)
  const replayed = replayEvents(restored, reopenedJournal.replay())
  assert.equal(replayed.sequence, restored.sequence)
  assert.deepEqual(replayed.analyses[0]?.sourceRange?.eventIds, sourceEventIds)

  const oversizedIds = Array.from({ length: 13_000 }, (_, index) =>
    createEventId(`event-over-${index}-${'a'.repeat(230)}`),
  )
  const oversizedJournal = new MemoryJournal(new FixedClock(startedAt))
  assert.throws(
    () =>
      commitApplicationEvent({
        state: initial,
        event: {
          kind: 'analysis.created',
          analysis: {
            ...analysis,
            id: createAnalysisId('analysis-oversized-source-range'),
            sourceRange: {
              eventIds: oversizedIds,
              messageIds: [],
              messagePartIds: [],
              firstSequence: 1,
              lastSequence: oversizedIds.length,
            },
          },
        },
        journal: oversizedJournal,
        clock: new FixedClock(startedAt),
        providerEventKeys: {
          hasProviderEvent: (key) => providerEventIds.has(key),
          addProviderEvent: (key) => {
            providerEventIds.add(key)
          },
        },
        subscribers: new Set(),
      }),
    /bounded event payload/u,
  )
  assert.equal(oversizedJournal.all().length, 0)
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
    '2 calls · tokens ≥120 in / ≥45 out (+1 unknown) · cost ≥$0.0123 (+1 unknown) · latency ≥88ms (+1 unknown) · 1 failed',
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
    '1 call · tokens 20 in / 8 out · cost ~$0.0042 · latency 40ms',
  )
})

test('compact analysis surfaces omit unmeasured usage and latency', () => {
  const partial = {
    sequence: 2,
    model: 'glm-5.2',
    tokensKnown: false,
    costStatus: 'unknown' as const,
    outcome: 'failed' as const,
  }
  assert.equal(analysisMeasuredModelCallLine(partial), '#2 glm-5.2')
  assert.equal(
    analysisMeasuredModelCallSummary([
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
      partial,
    ]),
    '2 calls · tokens ≥120 in / ≥45 out · cost $0.0123 · latency ≥88ms · 1 failed',
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
