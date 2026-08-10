import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { type ChatClient, CostLedger } from '@tangle-network/agent-eval'
import {
  SEMANTIC_JUDGE_EVIDENCE_CONTRACT,
  semanticJudge,
  summarizeCalibration,
} from '../src/eval/calibration.js'
import {
  assertHeldOutInputs,
  inspectPilot,
  runPilotCampaign,
  runReleaseCampaign,
} from '../src/eval/campaigns.js'
import { artifactForScenario, SEMANTIC_CASES, scenariosForCalibration } from '../src/eval/cases.js'
import {
  createEvalChatClient,
  DEFAULT_EVAL_BASE_URL,
  DEFAULT_EVAL_MODEL,
  EVAL_TOTAL_COMPLETION_TOKENS,
  evalJudgeProfile,
  probeEvalRoute,
  readEvalRouteConfig,
} from '../src/eval/execution.js'
import { analysisEvidence, SEMANTIC_RELEASE_FIXTURES } from '../src/eval/fixtures.js'
import { baseCalibration, basePilot, packageProvenance } from '../src/eval/record-builder.js'
import {
  cellCostEvidence,
  cellEvidence,
  redactEvalValue,
  type SemanticEvalRecord,
} from '../src/eval/records.js'
import { semanticReleaseDecision } from '../src/eval/release-decision.js'
import { semanticEvalMeasurements } from '../src/eval/release-markers.js'
import type {
  CalibrationCellRecord,
  RecordedJudgeCall,
  SemanticCaseEvidence,
  SemanticCellEvidence,
} from '../src/eval/types.js'
import { SEMANTIC_EVAL_CASE_IDS } from '../src/eval/types.js'

function passingCalibration(): SemanticEvalRecord['calibration'] {
  return {
    ...baseCalibration(null),
    passed: true,
    pairedExamples: 18,
    minimumPairedExamples: 12,
    goodExamples: 18,
    goodAccepted: 18,
    minimumGoodAccepted: 18,
    goodPreferred: 18,
    minimumGoodPreferred: 17,
    pairPreferenceRate: 1,
    strongMean: 0.95,
    weakMean: 0.2,
    trivialMean: 0.1,
    strongWeakMargin: 0.75,
    trivialStrongRatio: 0.105,
    perCategory: SEMANTIC_EVAL_CASE_IDS.map((id) => ({
      caseId: id,
      category: id,
      pairCount: 3,
      goodExamples: 3,
      goodAccepted: 3,
      goodAcceptancePassed: true,
      goodPreferred: 3,
      ties: 0,
      reversals: 0,
      trivialComparisons: 3,
      trivialRejected: true,
      goodMean: 0.95,
      badMean: 0.2,
      trivialMean: 0.1,
    })),
    failures: [],
  }
}

function passingPilot(): SemanticEvalRecord['pilot'] {
  return {
    ...basePilot('passed', 'passed'),
    status: 'passed',
    score: 0.95,
    inspection: {
      passed: true,
      productAvailable: true,
      parseableJudgeScore: true,
      rawJudgeCallCaptured: true,
      usageCaptured: true,
      costCaptured: true,
      wallTimeCaptured: true,
      failures: [],
    },
  }
}

function passingCell(caseId: string, index: number): SemanticCellEvidence {
  return {
    cellId: `${caseId}-cell-${index}`,
    scenarioId: `${caseId}-scenario-${index}`,
    fixtureId: `${caseId}-fixture-${index}`,
    semanticOutput: { caseId, index },
    candidateOutput: 'A supported product answer.',
    productPath: {
      text: 'A supported product answer.',
      path: 'plain',
      available: true,
      missingReason: null,
      sourceDigest: `digest-${caseId}-${index}`,
    },
    judgeScores: {},
    pass: true,
    rawJudgeCallIds: [`call-${caseId}-${index}`],
    cost: {
      usd: 0,
      provenance: { source: 'reported' },
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: null,
      cachedTokens: 0,
      wallTimeMs: 1,
    },
  }
}

function passingCases(): readonly SemanticCaseEvidence[] {
  return SEMANTIC_EVAL_CASE_IDS.map((id) => {
    const cells = [1, 2, 3].map((index) => passingCell(id, index))
    return {
      id,
      category: 'eval',
      command: 'pnpm test:eval',
      question: id,
      referenceCriteria: { requiredSignals: [], forbiddenSignals: [], passThreshold: 0.7 },
      fixtureCount: 3,
      passedFixtures: 3,
      failedFixtures: 0,
      artifacts: [],
      productFailures: [],
      result: 'passed',
      campaign: { cells } as unknown as SemanticCaseEvidence['campaign'],
      cells,
      disagreements: [],
    }
  })
}

function successfulCalls(cases: readonly SemanticCaseEvidence[]): RecordedJudgeCall[] {
  return cases.flatMap((evidence) =>
    evidence.cells.map((cell) => ({
      callId: cell.rawJudgeCallIds[0] ?? null,
      request: {},
      response: {},
      error: null,
      startedAt: '2026-08-03T00:00:00.000Z',
      finishedAt: '2026-08-03T00:00:00.001Z',
      wallTimeMs: 1,
    })),
  )
}

test('semantic judge execution is one exact AgentProfile owned by Runtime', async () => {
  const config = readEvalRouteConfig({ BRAID_EVAL_API_KEY: 'test-router-key' })
  assert.deepEqual(config, {
    baseUrl: DEFAULT_EVAL_BASE_URL,
    model: DEFAULT_EVAL_MODEL,
    apiKey: 'test-router-key',
    timeoutMs: 120_000,
    totalTimeoutMs: 900_000,
  })
  assert.deepEqual(evalJudgeProfile(config), {
    name: 'Braid semantic release judge',
    description: 'Scores installed Braid output against held-out release criteria.',
    version: '0.1.0',
    harness: 'cli-base',
    model: {
      provider: 'tangle-router',
      default: DEFAULT_EVAL_MODEL,
      reasoningEffort: 'none',
      metadata: {
        temperature: 0,
        maxTokens: EVAL_TOTAL_COMPLETION_TOKENS,
        retry: {
          maxAttempts: 3,
          initialBackoffMs: 1_000,
          maxBackoffMs: 2_000,
          jitter: 0,
          requestTimeoutMs: 120_000,
        },
        extraBody: {
          max_completion_tokens: EVAL_TOTAL_COMPLETION_TOKENS,
          thinking: { type: 'disabled' },
        },
      },
    },
  })

  const requests: Array<{
    readonly body: Record<string, unknown>
    readonly headers: Readonly<Record<string, string>>
  }> = []
  const client = createEvalChatClient(config, async (body, request) => {
    requests.push({ body, headers: request?.headers ?? {} })
    return {
      model: DEFAULT_EVAL_MODEL,
      choices: [{ message: { content: '{"dimensions":{}}' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 17,
        completion_tokens: 119,
        completion_tokens_details: { reasoning_tokens: 116 },
        cost: 0.000_3,
      },
    }
  })
  const response = await client.chat(
    {
      model: DEFAULT_EVAL_MODEL,
      messages: [
        { role: 'system', content: 'Judge this output.' },
        { role: 'user', content: 'candidate' },
      ],
      temperature: 0,
      maxTokens: EVAL_TOTAL_COMPLETION_TOKENS,
    },
    { idempotencyKey: 'eval-call-1', correlationId: 'eval-correlation-1' },
  )

  assert.equal(client.transport, 'custom')
  assert.equal(client.defaultModel, DEFAULT_EVAL_MODEL)
  assert.equal(client.maximumAttempts, 3)
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0]?.body, {
    max_completion_tokens: EVAL_TOTAL_COMPLETION_TOKENS,
    thinking: { type: 'disabled' },
    model: DEFAULT_EVAL_MODEL,
    messages: [
      { role: 'system', content: 'Judge this output.' },
      { role: 'user', content: 'candidate' },
    ],
    temperature: 0,
    max_tokens: EVAL_TOTAL_COMPLETION_TOKENS,
    reasoning_effort: 'none',
  })
  assert.deepEqual(requests[0]?.headers, {
    authorization: 'Bearer test-router-key',
    'content-type': 'application/json',
    'idempotency-key': 'eval-call-1',
    'x-correlation-id': 'eval-correlation-1',
  })
  assert.deepEqual(response.usage, {
    promptTokens: 17,
    completionTokens: 119,
    totalTokens: 136,
    reasoningTokens: 116,
  })

  const nonGlm = evalJudgeProfile({ ...config, model: 'openai-codex/gpt-5.6-luna' })
  assert.deepEqual(nonGlm.model?.metadata?.extraBody, {
    max_completion_tokens: EVAL_TOTAL_COMPLETION_TOKENS,
  })
})

test('semantic judge retries transient Router failures with the same operation identity', async (context) => {
  const config = readEvalRouteConfig({ BRAID_EVAL_API_KEY: 'test-router-key' })
  const requests: Array<{
    readonly body: Record<string, unknown>
    readonly headers: Readonly<Record<string, string>>
  }> = []
  context.mock.method(
    globalThis,
    'fetch',
    async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push({
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      })
      if (requests.length <= 2) {
        return new Response(JSON.stringify({ error: 'upstream capacity unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(
        JSON.stringify({
          model: DEFAULT_EVAL_MODEL,
          choices: [{ message: { content: '{"dimensions":{}}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 17, completion_tokens: 3, cost: 0.000_1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  )
  const client = createEvalChatClient(config)

  const response = await client.chat(
    {
      model: DEFAULT_EVAL_MODEL,
      messages: [{ role: 'user', content: 'candidate' }],
      temperature: 0,
      maxTokens: EVAL_TOTAL_COMPLETION_TOKENS,
    },
    { idempotencyKey: 'eval-retry-1', correlationId: 'eval-retry-correlation-1' },
  )

  assert.equal(response.content, '{"dimensions":{}}')
  assert.equal(requests.length, 3)
  assert.deepEqual(requests[1]?.body, requests[0]?.body)
  assert.deepEqual(requests[1]?.headers, requests[0]?.headers)
  assert.deepEqual(requests[2]?.body, requests[0]?.body)
  assert.deepEqual(requests[2]?.headers, requests[0]?.headers)
  assert.equal(requests[0]?.headers['idempotency-key'], 'eval-retry-1')
})

test('semantic release preserves successful cells when one judge call fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-eval-release-'))
  const definition = SEMANTIC_CASES[0]
  assert.ok(definition !== undefined)
  const fixtures = SEMANTIC_RELEASE_FIXTURES[definition.id]
  const originals = fixtures.map((fixture) => fixture.productOutput)
  for (const [index, fixture] of fixtures.entries()) {
    const mutable = fixture as { productOutput: typeof fixture.productOutput }
    mutable.productOutput = {
      text: `Installed Braid output ${index + 1}`,
      path: 'plain',
      available: true,
      missingReason: null,
      sourceDigest: `test-source-${index + 1}`,
    }
  }
  let calls = 0
  const chat: ChatClient = {
    transport: 'mock',
    defaultModel: 'test/semantic-judge',
    maximumAttempts: 1,
    chat: async () => {
      calls += 1
      if (calls === 2) throw new Error('transient judge outage')
      return {
        content: JSON.stringify({
          dimensions: Object.fromEntries(
            definition.dimensions.map((dimension) => [dimension.key, 0.9]),
          ),
          notes: 'The installed output satisfies the release criteria.',
        }),
        usage: {
          promptTokens: 20,
          completionTokens: 5,
          totalTokens: 25,
          captured: true,
        },
        costUsd: 0,
        model: 'test/semantic-judge',
        finishReason: 'stop',
        durationMs: 1,
        raw: {},
      }
    },
  }

  try {
    const execution = await runReleaseCampaign({
      definition,
      chat,
      ledger: new CostLedger(),
      runDir: root,
    })
    assert.ok(execution.campaign !== null)
    assert.equal(calls, 3)
    assert.equal(execution.campaign.cells.length, 3)
    assert.equal(execution.campaign.aggregates.cellsFailed, 1)
    assert.equal(execution.campaign.cells.filter((cell) => cell.errorStage === 'judge').length, 1)
    assert.equal(
      execution.campaign.cells.filter((cell) => Object.keys(cell.judgeScores).length === 1).length,
      2,
    )
  } finally {
    for (const [index, fixture] of fixtures.entries()) {
      const original = originals[index]
      assert.ok(original !== undefined)
      const mutable = fixture as { productOutput: typeof fixture.productOutput }
      mutable.productOutput = original
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('semantic judge does not retry a deterministic Router rejection', async (context) => {
  let attempts = 0
  context.mock.method(globalThis, 'fetch', async () => {
    attempts += 1
    return new Response(JSON.stringify({ error: 'invalid request' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  })
  const client = createEvalChatClient(
    readEvalRouteConfig({ BRAID_EVAL_API_KEY: 'test-router-key' }),
  )

  await assert.rejects(
    client.chat(
      {
        model: DEFAULT_EVAL_MODEL,
        messages: [{ role: 'user', content: 'candidate' }],
        temperature: 0,
        maxTokens: EVAL_TOTAL_COMPLETION_TOKENS,
      },
      { idempotencyKey: 'eval-no-retry-1' },
    ),
    /router 400/u,
  )
  assert.equal(attempts, 1)
})

test('semantic judge makes hidden reference evidence ineligible for candidate credit', async () => {
  const definition = SEMANTIC_CASES[0]
  assert.ok(definition !== undefined)
  const scenario = scenariosForCalibration(definition, 'trivial')[0]
  assert.ok(scenario !== undefined)
  const requests: Parameters<ChatClient['chat']>[0][] = []
  const chat: ChatClient = {
    transport: 'mock',
    defaultModel: 'test/semantic-judge',
    maximumAttempts: 1,
    chat: async (request) => {
      requests.push(request)
      return {
        content: JSON.stringify({
          dimensions: Object.fromEntries(
            definition.dimensions.map((dimension) => [dimension.key, 0]),
          ),
          notes: 'The generic answer omits every required detail.',
        }),
        usage: {
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
          captured: true,
        },
        costUsd: 0,
        model: 'test/semantic-judge',
        finishReason: 'stop',
        durationMs: 1,
        raw: {},
      }
    },
  }

  const judge = semanticJudge(definition, chat)
  await judge.score({
    artifact: artifactForScenario(scenario),
    scenario,
    signal: new AbortController().signal,
  })

  assert.equal(judge.judgeVersion, 'braid-semantic-quality-v3-EVAL-01')
  const request = requests[0]
  assert.ok(request !== undefined)
  assert.match(String(request.messages[0]?.content), /hidden ground truth/u)
  assert.match(String(request.messages[0]?.content), /earns zero/u)
  assert.equal(
    String(request.messages[0]?.content).includes(SEMANTIC_JUDGE_EVIDENCE_CONTRACT),
    true,
  )
  const payload = JSON.parse(String(request.messages.at(-1)?.content)) as Record<string, unknown>
  assert.deepEqual(Object.keys(payload), ['candidate', 'referenceOnly'])
  assert.deepEqual(Object.keys(payload.candidate as Record<string, unknown>), [
    'userFacingAnswer',
    'candidateLabel',
    'productPath',
  ])
  assert.deepEqual(Object.keys(payload.referenceOnly as Record<string, unknown>), [
    'semanticOutput',
  ])
})

test('semantic judge refuses an ambiguous smaller request cap before provider spend', async () => {
  let calls = 0
  const client = createEvalChatClient(
    readEvalRouteConfig({ BRAID_EVAL_API_KEY: 'test-router-key' }),
    async () => {
      calls += 1
      throw new Error('must not run')
    },
  )
  await assert.rejects(
    client.chat({
      messages: [{ role: 'user', content: 'candidate' }],
      maxTokens: 320,
    }),
    /request maxTokens conflicts with AgentProfile model metadata/u,
  )
  assert.equal(calls, 0)
})

test('semantic route requires its explicit key and exact advertised model', async () => {
  let calls = 0
  const missing = await probeEvalRoute(readEvalRouteConfig({}), async () => {
    calls += 1
    throw new Error('must not fetch')
  })
  assert.equal(missing.status, 'unavailable')
  assert.match(missing.reason, /BRAID_EVAL_API_KEY is required/u)
  assert.equal(calls, 0)

  const ready = await probeEvalRoute(
    readEvalRouteConfig({ BRAID_EVAL_API_KEY: 'test-router-key' }),
    (async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1
      assert.equal(init?.headers && 'authorization' in init.headers, true)
      return new Response(JSON.stringify({ data: [{ id: DEFAULT_EVAL_MODEL }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch,
  )
  assert.equal(ready.status, 'ready')
  assert.deepEqual(ready.models, [DEFAULT_EVAL_MODEL])
  assert.equal(ready.provider.transport, 'custom')
  assert.equal(ready.provider.bearerPresent, true)
  assert.equal(calls, 1)
})

test('analysis fixtures replay a valid product run before freezing evidence', () => {
  const { evidence } = analysisEvidence('fixture-replay-regression')
  assert.equal(evidence.events[0]?.event.kind, 'run.requested')
  assert.equal(evidence.events.at(-1)?.event.kind, 'run.finished')
})

test('a stopped semantic run preserves all six category outcomes', () => {
  const stopped = baseCalibration('candidate package unavailable')
  assert.deepEqual(
    stopped.perCategory.map(({ caseId, pairCount, trivialRejected }) => ({
      caseId,
      pairCount,
      trivialRejected,
    })),
    SEMANTIC_EVAL_CASE_IDS.map((caseId) => ({
      caseId,
      pairCount: 0,
      trivialRejected: false,
    })),
  )
})

test('calibration requires every seeded good answer to meet its release threshold', () => {
  const score = (composite: number): NonNullable<CalibrationCellRecord['score']> => ({
    dimensions: { quality: composite },
    composite,
    notes: 'deterministic calibration score',
  })
  const cells: CalibrationCellRecord[] = SEMANTIC_CASES.flatMap((definition) =>
    definition.calibrationFixtures.flatMap((fixture, index) =>
      (['good', 'bad', 'trivial'] as const).map((label) => ({
        scenarioId: `${definition.id}-calibration-${index + 1}`,
        pairId: `${definition.id}-pair-${index + 1}`,
        caseId: definition.id,
        fixtureId: fixture.id,
        semanticOutput: fixture.semanticOutput,
        label,
        output:
          label === 'good'
            ? fixture.goodOutput
            : label === 'bad'
              ? fixture.badOutput
              : fixture.trivialOutput,
        score: score(label === 'good' ? 0.9 : 0.1),
        campaignCell: `${definition.id}-${label}-${index + 1}`,
      })),
    ),
  )
  const accepted = summarizeCalibration(SEMANTIC_CASES, cells)
  assert.equal(accepted.passed, true)
  assert.equal(accepted.goodAccepted, 18)
  assert.equal(accepted.minimumGoodAccepted, 18)

  const rejected = summarizeCalibration(
    SEMANTIC_CASES,
    cells.map((cell) =>
      cell.caseId === 'EVAL-01' && cell.label === 'good' && cell.pairId.endsWith('-1')
        ? { ...cell, score: score(0.69) }
        : cell,
    ),
  )
  assert.equal(rejected.passed, false)
  assert.equal(rejected.goodAccepted, 17)
  assert.match(rejected.failures.join('; '), /EVAL-01 accepted 2\/3 good baselines/u)
})

test('every semantic release fixture differs from every calibration input', () => {
  assert.doesNotThrow(() => assertHeldOutInputs(SEMANTIC_CASES))
})

test('semantic pilot keeps deterministic presentation free and records paid judge usage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-eval-pilot-'))
  const fixture = SEMANTIC_RELEASE_FIXTURES['EVAL-01'][0]
  assert.ok(fixture !== undefined)
  const originalProductOutput = fixture.productOutput
  const mutableFixture = fixture as { productOutput: typeof fixture.productOutput }
  mutableFixture.productOutput = {
    ...originalProductOutput,
    text: 'Copied conversation context; new provider session; no environment or checkpoint.',
    path: 'tui',
    available: true,
    missingReason: null,
  }
  const rawCalls: RecordedJudgeCall[] = []
  const chat: ChatClient = {
    transport: 'mock',
    defaultModel: 'test/semantic-judge',
    maximumAttempts: 1,
    chat: async (_request, options) => {
      const callId = options?.idempotencyKey ?? null
      rawCalls.push({
        callId,
        request: {},
        response: { status: 'ok' },
        error: null,
        startedAt: '2026-08-03T00:00:00.000Z',
        finishedAt: '2026-08-03T00:00:00.002Z',
        wallTimeMs: 2,
      })
      return {
        content: JSON.stringify({
          dimensions: {
            copied_state: 0.95,
            runtime_boundaries: 0.95,
            omissions: 0.95,
            decision_clarity: 0.95,
          },
          notes: 'The answer describes the copied state and the new execution boundaries.',
        }),
        usage: {
          promptTokens: 41,
          completionTokens: 7,
          totalTokens: 48,
          captured: true,
          reasoningTokens: 3,
          cachedPromptTokens: 5,
        },
        costUsd: 0.012,
        model: 'test/semantic-judge',
        durationMs: 2,
        finishReason: 'stop',
        contentEmpty: false,
        raw: {},
      }
    },
  }
  const ledger = new CostLedger()
  const definition = SEMANTIC_CASES[0]
  assert.ok(definition !== undefined)
  try {
    const execution = await runPilotCampaign({
      definition,
      chat,
      ledger,
      runDir: root,
    })
    const cell = execution.campaign?.cells[0]
    assert.ok(cell !== undefined)
    assert.equal(cell.costUsd, 0)
    assert.deepEqual(cell.tokenUsage, { input: 0, output: 0 })
    const inspection = inspectPilot(execution, rawCalls, 0.7)
    assert.deepEqual(inspection, {
      passed: true,
      productAvailable: true,
      parseableJudgeScore: true,
      rawJudgeCallCaptured: true,
      usageCaptured: true,
      costCaptured: true,
      wallTimeCaptured: true,
      failures: [],
    })
    const cost = cellCostEvidence(cell, rawCalls, ledger)
    assert.equal(cost.usd, 0.012)
    assert.equal(cost.inputTokens, 36)
    assert.equal(cost.outputTokens, 7)
    assert.equal(cost.reasoningTokens, 3)
    assert.equal(cost.cachedTokens, 5)
    assert.equal(cost.wallTimeMs >= 2, true)
    const evidence = cellEvidence(cell, rawCalls, 0.7, ledger)
    assert.deepEqual(evidence.rawJudgeCallIds, [rawCalls[0]?.callId])
    assert.equal(Array.isArray(evidence.cost.provenance), true)
  } finally {
    mutableFixture.productOutput = originalProductOutput
    await rm(root, { recursive: true, force: true })
  }
})

test('semantic release requires every case, fixture, product path, and raw judge call', () => {
  const cases = passingCases()
  const input = {
    packageReady: true,
    calibration: passingCalibration(),
    pilot: passingPilot(),
    cases,
    rawJudgeCalls: successfulCalls(cases),
  }
  assert.deepEqual(semanticReleaseDecision(input), {
    status: 'passed',
    releaseAdmissible: true,
    reasons: [],
  })

  const missingRawCall = semanticReleaseDecision({ ...input, rawJudgeCalls: [] })
  assert.equal(missingRawCall.status, 'failed')
  assert.equal(missingRawCall.releaseAdmissible, false)
  assert.match(missingRawCall.reasons.join('\n'), /judge call .* missing or failed/u)

  const unavailableProduct = structuredClone(cases) as SemanticCaseEvidence[]
  const firstCell = unavailableProduct[0]?.cells[0]
  assert.ok(firstCell !== undefined)
  assert.ok(firstCell.productPath !== null)
  ;(firstCell as { productPath: SemanticCellEvidence['productPath'] }).productPath = {
    ...firstCell.productPath,
    available: false,
  }
  assert.match(
    semanticReleaseDecision({ ...input, cases: unavailableProduct }).reasons.join('\n'),
    /did not use an available product presenter/u,
  )
})

test('semantic release measurements expose one exact row for every case', () => {
  const cases = passingCases()
  const record = {
    status: 'passed',
    releaseAdmissible: true,
    cases,
    rawJudgeCalls: successfulCalls(cases),
    calibration: passingCalibration(),
    pilot: passingPilot(),
    receipts: [
      {
        inputTokens: 100,
        outputTokens: 25,
        reasoningTokens: 7,
        cachedTokens: 40,
        costUsd: 0.012,
      },
      {
        inputTokens: 80,
        outputTokens: 20,
        reasoningTokens: 0,
        cachedTokens: 10,
        costUsd: 0.008,
      },
    ],
    durationMs: 12,
  } as unknown as SemanticEvalRecord
  const measurements = semanticEvalMeasurements(record)
  for (const caseId of SEMANTIC_EVAL_CASE_IDS) {
    const exact = measurements.filter(({ name }) => name === caseId)
    assert.equal(exact.length, 1, caseId)
    assert.equal(exact[0]?.value, 3, caseId)
  }
  const value = (name: string) => measurements.find((entry) => entry.name === name)?.value
  assert.equal(value('input-tokens'), 180)
  assert.equal(value('output-tokens'), 45)
  assert.equal(value('reasoning-tokens'), 7)
  assert.equal(value('reasoning-token-receipts'), 1)
  assert.equal(value('cached-tokens'), 50)
  assert.equal(value('evaluation-cost'), 0.02)
})

test('evaluation redaction preserves numeric usage but masks token-shaped strings', () => {
  const redacted = redactEvalValue({
    inputTokens: 100,
    prompt_tokens: 90,
    cachedPromptTokens: 40,
    tokenUsage: { input: 100, output: 25 },
    accessToken: 'secret-canary',
    poisoned: { inputTokens: 'secret-canary' },
  }) as Record<string, unknown>
  assert.equal(redacted.inputTokens, 100)
  assert.equal(redacted.prompt_tokens, 90)
  assert.equal(redacted.cachedPromptTokens, 40)
  assert.deepEqual(redacted.tokenUsage, { input: 100, output: 25 })
  assert.equal(redacted.accessToken, '[REDACTED]')
  assert.deepEqual(redacted.poisoned, { inputTokens: '[REDACTED]' })
})

test('package provenance hashes arbitrary tarball bytes without text transcoding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-eval-package-'))
  try {
    const packageJson = Buffer.from('{"name":"@tangle-network/braid","version":"0.1.0"}\n')
    const tarball = Buffer.from([0, 255, 254, 253, 128, 1, 2, 3, 244])
    const tarballPath = join(root, 'braid.tgz')
    await writeFile(join(root, 'package.json'), packageJson)
    await writeFile(tarballPath, tarball)
    const proof = await packageProvenance({
      BRAID_EVAL_PACKAGE_ROOT: root,
      BRAID_EVAL_TARBALL_PATH: tarballPath,
    })
    assert.equal(proof.status, 'ready')
    assert.equal(
      proof.tarballSha256,
      `sha256:${createHash('sha256').update(tarball).digest('hex')}`,
    )
    assert.equal(
      proof.installedPackageJsonSha256,
      `sha256:${createHash('sha256').update(packageJson).digest('hex')}`,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
