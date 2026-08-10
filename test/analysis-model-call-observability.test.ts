import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExternalOptimizerModelExecutionObservation } from '@tangle-network/agent-eval/campaign'
import { ModelExecutionScope } from '../src/adapters/analysis/model-execution-scope.js'
import { analysisModelCallRecords } from '../src/app/analysis-model-call-records.js'

const startedAt = '2026-08-10T12:00:00.000Z'
const endedAt = '2026-08-10T12:00:00.123Z'

test('projects one analysis observation into sanitized per-call facts', () => {
  const observation: ExternalOptimizerModelExecutionObservation = {
    sequence: 9,
    callId: 'call-analysis-1',
    callRef: 'profile-digest-1',
    path: '/v1/chat/completions',
    model: 'glm-5.2',
    succeeded: true,
    responseStatus: 200,
    execution: {
      provider: 'tangle-router',
      route: 'cli-bridge/chat-completions',
      startedAt,
      endedAt,
      durationMs: 123,
      usage: {
        captured: true,
        inputTokens: 120,
        outputTokens: 40,
        cachedTokens: 30,
        cacheWriteTokens: 5,
      },
      billing: { status: 'observed', usd: 0.0042 },
      prompt: 'do not retain this prompt',
      response: 'do not retain this response',
      credential: 'do not retain this credential',
    },
  }

  const [record] = analysisModelCallRecords([observation])
  assert.deepEqual(record, {
    sequence: 9,
    callId: 'call-analysis-1',
    callRef: 'profile-digest-1',
    path: '/v1/chat/completions',
    model: 'glm-5.2',
    provider: 'tangle-router',
    route: 'cli-bridge/chat-completions',
    inputTokens: 120,
    outputTokens: 40,
    cachedTokens: 30,
    cacheWriteTokens: 5,
    tokensKnown: true,
    cost: { status: 'observed', usd: 0.0042 },
    latencyMs: 123,
    outcome: 'succeeded',
    responseStatus: 200,
    startedAt,
    endedAt,
  })
  assert.doesNotMatch(JSON.stringify(record), /do not retain/u)
})

test('rejects unsafe identifiers and malformed timestamps instead of persisting them', () => {
  const observation: ExternalOptimizerModelExecutionObservation = {
    sequence: 0,
    callId: 'call\u0000secret',
    callRef: 'Bearer super-secret',
    path: '/v1/chat/completions?api_key=secret' as unknown as ExternalOptimizerModelExecutionObservation['path'],
    model: 'api-key',
    succeeded: false,
    error: 'do not retain this error',
    execution: {
      provider: 'provider\u0001',
      route: 'authorization',
      endpointFormat: 'chat-completions',
      startedAt: '2026-08-10T12:00:00Z',
      endedAt: 'not-a-date',
      terminal: { errorStatus: 500, errorKind: 'token' },
      credential: 'do not retain this credential',
    },
  }

  const [record] = analysisModelCallRecords([observation])
  assert.deepEqual(record, {
    sequence: 1,
    callId: 'unknown-call',
    callRef: 'unknown-call-ref',
    path: 'unknown-path',
    model: 'unknown-model',
    route: 'chat-completions',
    tokensKnown: false,
    cost: { status: 'unknown' },
    outcome: 'failed',
    responseStatus: 500,
  })
  assert.equal(record?.provider, undefined)
  assert.equal(record?.failureCode, undefined)
  assert.doesNotMatch(
    JSON.stringify(record),
    /Bearer super-secret|api-key|authorization|do not retain/iu,
  )
  for (const path of ['/v1/responses#token', '/v1/\u0000responses', '/v1/authorization']) {
    const [pathRecord] = analysisModelCallRecords([
      {
        ...observation,
        path: path as unknown as ExternalOptimizerModelExecutionObservation['path'],
      },
    ])
    assert.equal(pathRecord?.path, 'unknown-path')
  }

  const [invalidUsage] = analysisModelCallRecords([
    {
      ...observation,
      execution: {
        usage: { captured: true, inputTokens: 10, outputTokens: Number.NaN },
        terminal: { errorStatus: 99 },
      },
    },
  ])
  assert.equal(invalidUsage?.tokensKnown, false)
  assert.equal(invalidUsage?.inputTokens, undefined)
  assert.equal(invalidUsage?.outputTokens, undefined)
  assert.equal(invalidUsage?.responseStatus, undefined)
})

test('consumes completed observations after the first per-run read', async () => {
  const scope = new ModelExecutionScope()
  const observation: ExternalOptimizerModelExecutionObservation = {
    sequence: 3,
    callId: 'call-3',
    callRef: 'ref-3',
    path: '/v1/chat/completions',
    model: 'glm-5.2',
    succeeded: true,
    responseStatus: 200,
    execution: { usage: { captured: false } },
  }
  const source = (async function* () {
    scope.record(observation)
    yield 'completed'
  })()
  const values: string[] = []
  for await (const value of scope.stream('analysis-run-3', source)) values.push(value)

  assert.deepEqual(values, ['completed'])
  assert.deepEqual(scope.modelExecutions('analysis-run-3'), [observation])
  assert.deepEqual(scope.modelExecutions('analysis-run-3'), [])
})

test('bounds unread completed runs and refreshes duplicate run ids', async () => {
  const scope = new ModelExecutionScope()

  async function complete(runId: string, sequence: number): Promise<void> {
    const source = (async function* () {
      scope.record({
        sequence,
        callId: `call-${runId}`,
        callRef: `ref-${runId}`,
        path: '/v1/chat/completions',
        model: 'glm-5.2',
        succeeded: true,
        responseStatus: 200,
        execution: {},
      })
      yield undefined
    })()
    for await (const _value of scope.stream(runId, source)) {
      // The completed entry is stored only after the stream is drained.
    }
  }

  for (let index = 0; index < 256; index += 1) {
    await complete(`run-${index}`, index + 1)
  }
  await complete('run-0', 10_000)
  await complete('run-256', 257)

  assert.equal(scope.modelExecutions('run-0')[0]?.sequence, 10_000)
  assert.deepEqual(scope.modelExecutions('run-1'), [])
  assert.equal(scope.modelExecutions('run-256')[0]?.sequence, 257)
})
