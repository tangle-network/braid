import assert from 'node:assert/strict'
import test from 'node:test'
import type { BraidState } from '../src/domain/state.js'
import { sessionUsageFor } from '../src/views/shared/usage-projection.js'

const conversationId = 'conversation-usage-projection'

test('usage totals keep missing calls and latency unknown instead of converting them to zero', () => {
  const usage = sessionUsageFor(
    stateFor({
      runs: [runFor({ llmCalls: 2, llmLatencyMs: 120 }), runFor({})],
    }),
  ).turns

  assert.equal(usage.llmCalls, 2)
  assert.equal(usage.llmLatencyMs, 120)
  assert.equal(usage.callStatus, 'partial')
  assert.equal(usage.latencyStatus, 'partial')
  assert.equal(usage.unknownCallSources, 1)
  assert.equal(usage.unknownLatencySources, 1)
})

test('known zero calls and latency remain complete measurements', () => {
  const usage = sessionUsageFor(
    stateFor({
      runs: [runFor({ llmCalls: 0, llmLatencyMs: 0 })],
    }),
  ).turns

  assert.equal(usage.llmCalls, 0)
  assert.equal(usage.llmLatencyMs, 0)
  assert.equal(usage.callStatus, 'complete')
  assert.equal(usage.latencyStatus, 'complete')
  assert.equal(usage.unknownCallSources, 0)
  assert.equal(usage.unknownLatencySources, 0)
})

test('worker totals report unavailable call counts and partial latency', () => {
  const usage = sessionUsageFor(
    stateFor({
      runs: [runFor({ llmCalls: 1, llmLatencyMs: 40 })],
      supervisors: [{ id: 'supervisor-usage', rootRunId: 'run-usage' }],
      workers: [
        { supervisorId: 'supervisor-usage', latencyMs: 80 },
        { supervisorId: 'supervisor-usage' },
      ],
    }),
  ).delegated

  assert.equal(usage.llmCalls, undefined)
  assert.equal(usage.callStatus, 'unknown')
  assert.equal(usage.unknownCallSources, 2)
  assert.equal(usage.llmLatencyMs, 80)
  assert.equal(usage.latencyStatus, 'partial')
  assert.equal(usage.unknownLatencySources, 1)
})

test('analysis totals use durable model calls and remain separate from turns and workers', () => {
  const usage = sessionUsageFor(
    stateFor({
      runs: [runFor({ llmCalls: 7, llmLatencyMs: 700 })],
      analyses: [
        analysisFor({
          modelCalls: [{ latencyMs: 40 }, { latencyMs: 60 }],
          wallTimeMs: 125,
        }),
      ],
      supervisors: [{ id: 'supervisor-usage', rootRunId: 'run-usage' }],
      workers: [{ supervisorId: 'supervisor-usage', latencyMs: 80 }],
    }),
  )

  assert.equal(usage.turns.llmCalls, 7)
  assert.equal(usage.turns.llmLatencyMs, 700)
  assert.equal(usage.analyses.llmCalls, 2)
  assert.equal(usage.analyses.llmLatencyMs, 100)
  assert.equal(usage.analyses.callStatus, 'complete')
  assert.equal(usage.analyses.latencyStatus, 'complete')
  assert.equal(usage.delegated.llmCalls, undefined)
  assert.equal(usage.delegated.llmLatencyMs, 80)
})

test('analysis latency stays unknown for missing retained calls and partial across sources', () => {
  const usage = sessionUsageFor(
    stateFor({
      analyses: [
        analysisFor({ modelCalls: [{ latencyMs: 40 }, {}] }),
        analysisFor({ modelCalls: [{ latencyMs: 60 }] }),
      ],
    }),
  ).analyses

  assert.equal(usage.llmCalls, 3)
  assert.equal(usage.callStatus, 'complete')
  assert.equal(usage.llmLatencyMs, 60)
  assert.equal(usage.latencyStatus, 'partial')
  assert.equal(usage.unknownLatencySources, 1)
})

test('failed analyses retain complete token and observed cost facts from model calls', () => {
  const usage = sessionUsageFor(
    stateFor({
      analyses: [
        analysisFor({
          status: 'failed',
          modelCalls: [
            modelCallFor({
              tokensKnown: true,
              inputTokens: 120,
              outputTokens: 30,
              cost: { status: 'observed', usd: 0.12 },
            }),
            modelCallFor({
              tokensKnown: true,
              inputTokens: 80,
              outputTokens: 20,
              cost: { status: 'observed', usd: 0.08 },
            }),
          ],
        }),
      ],
    }),
  ).analyses

  assert.equal(usage.input, 200)
  assert.equal(usage.output, 50)
  assert.equal(usage.tokenStatus, 'complete')
  assert.equal(usage.costUsd, 0.2)
  assert.equal(usage.costStatus, 'reported')
  assert.equal(usage.unknownTokenSources, 0)
  assert.equal(usage.unknownCostSources, 0)
})

test('complete analysis usage remains authoritative over conflicting model calls', () => {
  const usage = sessionUsageFor(
    stateFor({
      analyses: [
        analysisFor({
          usage: { input: 5, output: 6, costUsd: 0.05 },
          modelCalls: [
            modelCallFor({
              tokensKnown: true,
              inputTokens: 100,
              outputTokens: 10,
              cost: { status: 'observed', usd: 0.1 },
            }),
          ],
        }),
      ],
    }),
  ).analyses

  assert.equal(usage.input, 5)
  assert.equal(usage.output, 6)
  assert.equal(usage.tokenStatus, 'complete')
  assert.equal(usage.costUsd, 0.05)
  assert.equal(usage.costStatus, 'reported')
})

test('partial analysis cost preserves the observed floor and separate estimate', () => {
  const usage = sessionUsageFor(
    stateFor({
      analyses: [
        analysisFor({
          usage: {
            input: 5,
            output: 6,
            costUsd: 0.12,
            usdKnown: false,
            estimatedCostUsd: 0.15,
          },
        }),
      ],
    }),
  ).analyses

  assert.equal(usage.costUsd, 0.12)
  assert.equal(usage.estimatedCostUsd, 0.15)
  assert.equal(usage.costStatus, 'observed-floor')
  assert.notEqual(usage.costStatus, 'reported')
})

test('fully known analysis cost remains reported alongside its estimate', () => {
  const usage = sessionUsageFor(
    stateFor({
      analyses: [
        analysisFor({
          usage: {
            input: 5,
            output: 6,
            costUsd: 0.12,
            estimatedCostUsd: 0.15,
          },
        }),
      ],
    }),
  ).analyses

  assert.equal(usage.costUsd, 0.12)
  assert.equal(usage.estimatedCostUsd, 0.15)
  assert.equal(usage.costStatus, 'reported')
})

test('estimate-only analysis cost remains estimated when reported cost is unknown', () => {
  const usage = sessionUsageFor(
    stateFor({
      analyses: [
        analysisFor({
          usage: {
            input: 5,
            output: 6,
            usdKnown: false,
            estimatedCostUsd: 0.15,
          },
        }),
      ],
    }),
  ).analyses

  assert.equal(usage.costUsd, undefined)
  assert.equal(usage.estimatedCostUsd, 0.15)
  assert.equal(usage.costStatus, 'estimated')
})

test('incomplete usage and complete calls merge lower bounds without upgrading completeness', () => {
  const usage = sessionUsageFor(
    stateFor({
      analyses: [
        analysisFor({
          usage: {
            input: 300,
            output: 10,
            tokensKnown: false,
            costUsd: 0.15,
            usdKnown: false,
          },
          modelCalls: [
            modelCallFor({
              tokensKnown: true,
              inputTokens: 100,
              outputTokens: 10,
              cost: { status: 'observed', usd: 0.1 },
            }),
            modelCallFor({
              tokensKnown: true,
              inputTokens: 100,
              outputTokens: 10,
              cost: { status: 'observed', usd: 0.1 },
            }),
          ],
        }),
      ],
    }),
  ).analyses

  assert.equal(usage.input, 300)
  assert.equal(usage.output, 20)
  assert.equal(usage.tokenStatus, 'observed-floor')
  assert.equal(usage.costUsd, 0.2)
  assert.equal(usage.costStatus, 'observed-floor')
  assert.notEqual(usage.tokenStatus, 'complete')
  assert.notEqual(usage.costStatus, 'reported')
})

test('all known mixed call costs publish an estimate for the complete known total', () => {
  const usage = sessionUsageFor(
    stateFor({
      analyses: [
        analysisFor({
          modelCalls: [
            modelCallFor({ cost: { status: 'observed', usd: 0.1 } }),
            modelCallFor({ cost: { status: 'estimated', usd: 0.05 } }),
          ],
        }),
      ],
    }),
  ).analyses

  assert.equal(usage.costUsd, 0.1)
  assert.ok(Math.abs((usage.estimatedCostUsd ?? Number.NaN) - 0.15) < 1e-9)
  assert.equal(usage.costStatus, 'estimated')
})

test('cancelled analyses expose partial calls as token floors and non-exact cost', () => {
  const usage = sessionUsageFor(
    stateFor({
      analyses: [
        analysisFor({
          status: 'cancelled',
          modelCalls: [
            modelCallFor({
              tokensKnown: true,
              inputTokens: 100,
              outputTokens: 10,
              cost: { status: 'observed', usd: 0.1 },
            }),
            modelCallFor({
              cost: { status: 'estimated', usd: 0.05 },
            }),
            modelCallFor({ cost: { status: 'unknown' } }),
          ],
        }),
      ],
    }),
  ).analyses

  assert.equal(usage.input, 100)
  assert.equal(usage.output, 10)
  assert.equal(usage.tokenStatus, 'observed-floor')
  assert.equal(usage.costUsd, 0.1)
  assert.equal(usage.estimatedCostUsd, undefined)
  assert.equal(usage.costStatus, 'observed-floor')
  assert.notEqual(usage.costStatus, 'reported')
})

test('incomplete model calls retain their observed token floors', () => {
  const usage = sessionUsageFor(
    stateFor({
      analyses: [
        analysisFor({
          modelCalls: [
            modelCallFor({ inputTokens: 80, outputTokens: 12 }),
            modelCallFor({ inputTokens: 20 }),
          ],
        }),
      ],
    }),
  ).analyses

  assert.equal(usage.input, 100)
  assert.equal(usage.output, 12)
  assert.equal(usage.tokenStatus, 'observed-floor')
})

test('unknown calls do not expose a partial estimate without an observed floor', () => {
  const usage = sessionUsageFor(
    stateFor({
      analyses: [
        analysisFor({
          status: 'failed',
          modelCalls: [
            modelCallFor({ cost: { status: 'estimated', usd: 0.05 } }),
            modelCallFor({ cost: { status: 'unknown' } }),
          ],
        }),
      ],
    }),
  ).analyses

  assert.equal(usage.input, 0)
  assert.equal(usage.output, 0)
  assert.equal(usage.tokenStatus, 'unknown')
  assert.equal(usage.costUsd, undefined)
  assert.equal(usage.estimatedCostUsd, undefined)
  assert.equal(usage.costStatus, 'unknown')
})

test('analysis model call presence proves zero calls without inventing zero latency', () => {
  const usage = sessionUsageFor(stateFor({ analyses: [analysisFor({ modelCalls: [] })] })).analyses

  assert.equal(usage.llmCalls, 0)
  assert.equal(usage.llmLatencyMs, undefined)
  assert.equal(usage.callStatus, 'complete')
  assert.equal(usage.latencyStatus, 'unknown')
  assert.equal(usage.unknownCallSources, 0)
  assert.equal(usage.unknownLatencySources, 1)
})

test('empty totals are explicitly unknown without inventing sources', () => {
  const usage = sessionUsageFor(stateFor({})).turns

  assert.equal(usage.llmCalls, undefined)
  assert.equal(usage.llmLatencyMs, undefined)
  assert.equal(usage.callStatus, 'unknown')
  assert.equal(usage.latencyStatus, 'unknown')
  assert.equal(usage.unknownCallSources, 0)
  assert.equal(usage.unknownLatencySources, 0)
})

test('unchanged application state reuses one immutable session usage projection', () => {
  const state = stateFor({
    runs: [runFor({ llmCalls: 1 })],
    supervisors: [{ id: 'supervisor-usage', rootRunId: 'run-usage' }],
    workers: [{ supervisorId: 'supervisor-usage', inputTokens: 4, outputTokens: 2 }],
  })
  const usage = sessionUsageFor(state)

  assert.equal(sessionUsageFor(state), usage)
  assert.equal(Object.isFrozen(usage), true)
  assert.equal(Object.isFrozen(usage.delegated), true)
  assert.notEqual(sessionUsageFor({ ...state }), usage)
})

function stateFor(input: {
  readonly runs?: readonly Record<string, unknown>[]
  readonly analyses?: readonly Record<string, unknown>[]
  readonly supervisors?: readonly Record<string, unknown>[]
  readonly workers?: readonly Record<string, unknown>[]
}): BraidState {
  return {
    conversationId,
    runs: input.runs ?? [],
    analyses: input.analyses ?? [],
    supervisors: input.supervisors ?? [],
    workers: input.workers ?? [],
  } as unknown as BraidState
}

function analysisFor(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'analysis-usage',
    source: { conversationId },
    ...overrides,
  }
}

function modelCallFor(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    tokensKnown: false,
    cost: { status: 'unknown' },
    ...overrides,
  }
}

function runFor(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'run-usage',
    conversationId,
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  }
}
