import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { type ChatClient, CostLedger } from '@tangle-network/agent-eval'
import { assertHeldOutInputs, inspectPilot, runPilotCampaign } from '../src/eval/campaigns.js'
import { SEMANTIC_CASES } from '../src/eval/cases.js'
import { analysisEvidence, SEMANTIC_RELEASE_FIXTURES } from '../src/eval/fixtures.js'
import { baseCalibration, basePilot, packageProvenance } from '../src/eval/record-builder.js'
import { cellCostEvidence, cellEvidence, type SemanticEvalRecord } from '../src/eval/records.js'
import { semanticReleaseDecision } from '../src/eval/release-decision.js'
import type {
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
