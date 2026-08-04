import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CostLedger } from '@tangle-network/agent-eval'
import { type CalibrationRun, runCalibration } from './calibration.js'
import {
  assertHeldOutInputs,
  caseEvidence,
  inspectPilot,
  runPilotCampaign,
  runReleaseCampaign,
  unavailableCaseEvidence,
} from './campaigns.js'
import { definitionForCase, SEMANTIC_CASES, scenariosForRelease } from './cases.js'
import {
  createEvalChatClient,
  type EvalRouteConfig,
  probeCliBridge,
  readEvalRouteConfig,
  recordingChatClient,
} from './execution.js'
import { prepareReleaseProductOutputs, releaseFixtureProductReady } from './fixtures.js'
import {
  baseCalibration,
  basePilot,
  ensureOutputDirectory,
  makeRecord,
  packageProvenance,
  packageVersions,
  writeRecord,
} from './record-builder.js'
import {
  cellEvidence,
  type EvalArtifactReference,
  type SemanticEvalRecord,
  writeJsonArtifact,
} from './records.js'
import { semanticReleaseDecision } from './release-decision.js'
import type { RecordedJudgeCall, SemanticCaseEvidence } from './types.js'

export interface SemanticEvalRunOptions {
  readonly rootDir?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly fetchImpl?: typeof fetch
  readonly outputDir?: string
  readonly costCeilingUsd?: number
}

export interface SemanticEvalRunResult {
  readonly record: SemanticEvalRecord
  readonly outputDir: string
}

function now(): string {
  return new Date().toISOString()
}

async function outputDirectory(requested: string | undefined): Promise<string> {
  if (requested !== undefined) return ensureOutputDirectory(requested)
  return mkdtemp(join(tmpdir(), 'braid-semantic-eval-'))
}

function stopCases(reason: string): readonly SemanticCaseEvidence[] {
  return SEMANTIC_CASES.map((definition) => unavailableCaseEvidence(definition, reason))
}

async function stoppedRun(input: {
  readonly outputDir: string
  readonly startedAt: string
  readonly route: EvalRouteConfig
  readonly routeProbe: unknown
  readonly packageProvenance: Awaited<ReturnType<typeof packageProvenance>>
  readonly packageVersionMap: Readonly<Record<string, string>>
  readonly ledger: CostLedger
  readonly rawJudgeCalls: readonly RecordedJudgeCall[]
  readonly artifacts: readonly EvalArtifactReference[]
  readonly calibration: SemanticEvalRecord['calibration']
  readonly pilot: SemanticEvalRecord['pilot']
  readonly status: SemanticEvalRecord['status']
  readonly reason: string
}): Promise<SemanticEvalRunResult> {
  const record = makeRecord({
    startedAt: input.startedAt,
    finishedAt: now(),
    route: input.route,
    packageProvenance: input.packageProvenance,
    routeProbe: input.routeProbe,
    packageVersions: input.packageVersionMap,
    calibration: input.calibration,
    pilot: input.pilot,
    cases: stopCases(input.reason),
    rawJudgeCalls: input.rawJudgeCalls,
    ledger: input.ledger,
    artifacts: input.artifacts,
    status: input.status,
    releaseAdmissible: false,
    releaseFailureReasons: [input.reason],
    unavailableReason: input.status === 'unavailable' ? input.reason : null,
  })
  await writeRecord(input.outputDir, record)
  return { record, outputDir: input.outputDir }
}

function pilotRecord(
  execution: Awaited<ReturnType<typeof runPilotCampaign>>,
  inspection: ReturnType<typeof inspectPilot>,
  rawCalls: readonly RecordedJudgeCall[],
  threshold: number,
): SemanticEvalRecord['pilot'] {
  const cell = execution.campaign?.cells[0]
  const evidence =
    cell === undefined || execution.campaign === null
      ? null
      : cellEvidence(cell, rawCalls, threshold, execution.ledger)
  return {
    status: inspection.passed ? 'passed' : 'failed',
    caseId: 'EVAL-01',
    fixtureId: execution.scenarios[0]?.fixtureId ?? null,
    score: evidence === null ? null : (Object.values(evidence.judgeScores)[0]?.composite ?? null),
    campaign: execution.campaign,
    rawJudgeCallIds: evidence?.rawJudgeCallIds ?? [],
    inspection,
    cost: evidence?.cost ?? {
      usd: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: null,
      cachedTokens: 0,
      wallTimeMs: 0,
      provenance: null,
    },
  }
}

export async function runSemanticEvaluation(
  options: SemanticEvalRunOptions = {},
): Promise<SemanticEvalRunResult> {
  const startedAt = now()
  const rootDir = options.rootDir ?? process.cwd()
  const outputDir = await outputDirectory(options.outputDir ?? options.env?.BRAID_EVAL_OUTPUT_DIR)
  const route = readEvalRouteConfig(options.env)
  const packageVersionMap = await packageVersions(rootDir)
  const packageProof = await packageProvenance(options.env)
  const costCeilingUsd =
    options.costCeilingUsd ?? Number(options.env?.BRAID_EVAL_MAX_COST_USD ?? '1')
  if (!Number.isFinite(costCeilingUsd) || costCeilingUsd <= 0)
    throw new Error('BRAID_EVAL_MAX_COST_USD must be positive')
  const ledger = new CostLedger(costCeilingUsd)
  const rawJudgeCalls: RecordedJudgeCall[] = []
  const artifacts: EvalArtifactReference[] = []

  artifacts.push(
    await writeJsonArtifact(
      join(outputDir, 'package-provenance.json'),
      'package-provenance',
      packageProof,
    ),
  )
  if (packageProof.status === 'unavailable' || packageProof.packageRoot === null) {
    const reason = packageProof.reason ?? 'installed candidate package root unavailable'
    return stoppedRun({
      outputDir,
      startedAt,
      route,
      routeProbe: null,
      packageProvenance: packageProof,
      packageVersionMap,
      ledger,
      rawJudgeCalls,
      artifacts,
      calibration: baseCalibration(reason),
      pilot: basePilot('failed', reason),
      status: 'failed',
      reason,
    })
  }
  try {
    await prepareReleaseProductOutputs(packageProof.packageRoot)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    artifacts.push(
      await writeJsonArtifact(join(outputDir, 'presenter-failure.json'), 'presenter-failure', {
        reason,
      }),
    )
    return stoppedRun({
      outputDir,
      startedAt,
      route,
      routeProbe: null,
      packageProvenance: packageProof,
      packageVersionMap,
      ledger,
      rawJudgeCalls,
      artifacts,
      calibration: baseCalibration(reason),
      pilot: basePilot('failed', reason),
      status: 'failed',
      reason,
    })
  }
  if (!releaseFixtureProductReady()) {
    const reason =
      'Installed Braid presenters did not produce source-matched output for every release fixture'
    artifacts.push(
      await writeJsonArtifact(join(outputDir, 'presenter-failure.json'), 'presenter-failure', {
        reason,
      }),
    )
    return stoppedRun({
      outputDir,
      startedAt,
      route,
      routeProbe: null,
      packageProvenance: packageProof,
      packageVersionMap,
      ledger,
      rawJudgeCalls,
      artifacts,
      calibration: baseCalibration(reason),
      pilot: basePilot('failed', reason),
      status: 'failed',
      reason,
    })
  }

  try {
    assertHeldOutInputs(SEMANTIC_CASES)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    artifacts.push(
      await writeJsonArtifact(join(outputDir, 'fixture-failure.json'), 'fixture-failure', {
        reason,
      }),
    )
    return stoppedRun({
      outputDir,
      startedAt,
      route,
      routeProbe: null,
      packageProvenance: packageProof,
      packageVersionMap,
      ledger,
      rawJudgeCalls,
      artifacts,
      calibration: baseCalibration(reason),
      pilot: basePilot('failed', reason),
      status: 'failed',
      reason,
    })
  }

  const probe = await probeCliBridge(route, options.fetchImpl)
  artifacts.push(await writeJsonArtifact(join(outputDir, 'route-probe.json'), 'route-probe', probe))
  if (probe.status === 'unavailable') {
    return stoppedRun({
      outputDir,
      startedAt,
      route,
      routeProbe: probe,
      packageProvenance: packageProof,
      packageVersionMap,
      ledger,
      rawJudgeCalls,
      artifacts,
      calibration: baseCalibration(probe.reason),
      pilot: basePilot('unavailable', probe.reason),
      status: 'unavailable',
      reason: probe.reason,
    })
  }

  const chat = recordingChatClient(createEvalChatClient(route), rawJudgeCalls, {
    callTimeoutMs: route.timeoutMs,
    totalTimeoutMs: route.totalTimeoutMs,
  })
  const pilotDefinition = definitionForCase('EVAL-01')
  let pilotExecution: Awaited<ReturnType<typeof runPilotCampaign>>
  try {
    pilotExecution = await runPilotCampaign({
      definition: pilotDefinition,
      chat,
      ledger,
      runDir: join(outputDir, 'campaigns', 'pilot'),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    artifacts.push(
      await writeJsonArtifact(join(outputDir, 'pilot-failure.json'), 'pilot-failure', { reason }),
    )
    return stoppedRun({
      outputDir,
      startedAt,
      route,
      routeProbe: probe,
      packageProvenance: packageProof,
      packageVersionMap,
      ledger,
      rawJudgeCalls,
      artifacts,
      calibration: baseCalibration(reason),
      pilot: basePilot('failed', reason),
      status: 'failed',
      reason,
    })
  }

  const pilotInspection = inspectPilot(
    pilotExecution,
    rawJudgeCalls,
    pilotDefinition.criteria.passThreshold,
  )
  const pilot = pilotRecord(
    pilotExecution,
    pilotInspection,
    rawJudgeCalls,
    pilotDefinition.criteria.passThreshold,
  )
  artifacts.push(await writeJsonArtifact(join(outputDir, 'pilot.json'), 'pilot', pilot))
  if (!pilotInspection.passed) {
    return stoppedRun({
      outputDir,
      startedAt,
      route,
      routeProbe: probe,
      packageProvenance: packageProof,
      packageVersionMap,
      ledger,
      rawJudgeCalls,
      artifacts,
      calibration: baseCalibration(`pilot rejected: ${pilotInspection.failures.join('; ')}`),
      pilot,
      status: 'failed',
      reason: `pilot rejected: ${pilotInspection.failures.join('; ')}`,
    })
  }

  let calibration: CalibrationRun
  try {
    calibration = await runCalibration({
      definitions: SEMANTIC_CASES,
      chat,
      runDir: join(outputDir, 'campaigns', 'calibration'),
      ledger,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    artifacts.push(
      await writeJsonArtifact(join(outputDir, 'calibration-failure.json'), 'calibration-failure', {
        reason,
      }),
    )
    return stoppedRun({
      outputDir,
      startedAt,
      route,
      routeProbe: probe,
      packageProvenance: packageProof,
      packageVersionMap,
      ledger,
      rawJudgeCalls,
      artifacts,
      calibration: baseCalibration(reason),
      pilot,
      status: 'failed',
      reason,
    })
  }
  artifacts.push(
    await writeJsonArtifact(join(outputDir, 'calibration.json'), 'calibration', {
      summary: calibration.summary,
      campaigns: calibration.campaigns,
    }),
  )
  if (!calibration.summary.passed) {
    const reason = `calibration rejected: ${calibration.summary.failures.join('; ')}`
    return stoppedRun({
      outputDir,
      startedAt,
      route,
      routeProbe: probe,
      packageProvenance: packageProof,
      packageVersionMap,
      ledger,
      rawJudgeCalls,
      artifacts,
      calibration: calibration.summary,
      pilot,
      status: 'failed',
      reason,
    })
  }

  const cases: SemanticCaseEvidence[] = []
  const releaseFailureReasons: string[] = []
  for (const definition of SEMANTIC_CASES) {
    try {
      const execution = await runReleaseCampaign({
        definition,
        chat,
        ledger,
        runDir: join(outputDir, 'campaigns', definition.id),
      })
      const evidence = caseEvidence(definition, execution, rawJudgeCalls)
      cases.push(evidence)
      releaseFailureReasons.push(...evidence.disagreements)
      artifacts.push(
        await writeJsonArtifact(join(outputDir, `${definition.id}.json`), definition.id, evidence),
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const execution = {
        scenarios: scenariosForRelease(definition),
        productFailures: scenariosForRelease(definition).map((scenario) => ({
          fixtureId: scenario.fixtureId,
          reason,
        })),
        campaign: null,
        ledger,
      }
      const evidence = caseEvidence(definition, execution, rawJudgeCalls)
      cases.push(evidence)
      releaseFailureReasons.push(`${definition.id}: ${reason}`)
      artifacts.push(
        await writeJsonArtifact(
          join(outputDir, `${definition.id}-failure.json`),
          definition.id,
          evidence,
        ),
      )
    }
  }

  const decision = semanticReleaseDecision({
    packageReady: packageProof.status === 'ready',
    calibration: calibration.summary,
    pilot,
    cases,
    rawJudgeCalls,
  })
  const record = makeRecord({
    startedAt,
    finishedAt: now(),
    route,
    packageProvenance: packageProof,
    routeProbe: probe,
    packageVersions: packageVersionMap,
    calibration: calibration.summary,
    pilot,
    cases,
    rawJudgeCalls,
    ledger,
    artifacts,
    status: decision.status,
    releaseAdmissible: decision.releaseAdmissible,
    releaseFailureReasons: [...releaseFailureReasons, ...decision.reasons],
    unavailableReason: null,
  })
  await writeRecord(outputDir, record)
  return { record, outputDir }
}
