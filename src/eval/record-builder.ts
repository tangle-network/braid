import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { CostLedger } from '@tangle-network/agent-eval'
import type { EvalRouteConfig } from './execution.js'
import { providerIdentity } from './execution.js'
import {
  assertSemanticEvalRecord,
  type EvalArtifactReference,
  type EvalPackageProvenance,
  type PilotInspection,
  receiptsView,
  redactEvalValue,
  type SemanticEvalRecord,
  withArtifactHash,
  writeJsonArtifact,
} from './records.js'
import type {
  CalibrationSummary,
  EvalProviderIdentity,
  RecordedJudgeCall,
  SemanticCaseEvidence,
} from './types.js'
import { SEMANTIC_EVAL_CASE_IDS, SEMANTIC_EVAL_CATEGORIES } from './types.js'

interface PackageJsonShape {
  readonly version?: unknown
  readonly dependencies?: Readonly<Record<string, unknown>>
}

function hashBytes(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export async function packageVersions(rootDir: string): Promise<Readonly<Record<string, string>>> {
  const packageJson = JSON.parse(
    await readFile(join(rootDir, 'package.json'), 'utf8'),
  ) as PackageJsonShape
  const dependencies = packageJson.dependencies ?? {}
  const names = [
    '@tangle-network/braid',
    '@tangle-network/agent-eval',
    '@tangle-network/agent-interface',
    '@tangle-network/agent-runtime',
    '@tangle-network/agent-provider-cli-bridge',
  ]
  return Object.fromEntries(
    names.map((name) => [
      name,
      name === '@tangle-network/braid'
        ? String(packageJson.version ?? 'unknown')
        : String(dependencies[name] ?? 'unknown'),
    ]),
  )
}

export async function packageProvenance(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<EvalPackageProvenance> {
  const packageRootValue = env.BRAID_EVAL_PACKAGE_ROOT?.trim()
  const tarballPathValue = env.BRAID_EVAL_TARBALL_PATH?.trim()
  const packageRoot =
    packageRootValue === undefined || packageRootValue.length === 0
      ? null
      : resolve(packageRootValue)
  const tarballPath =
    tarballPathValue === undefined || tarballPathValue.length === 0
      ? null
      : resolve(tarballPathValue)
  if (packageRoot === null) {
    return {
      packageRoot: null,
      tarballPath,
      tarballSha256: null,
      installedPackageJsonSha256: null,
      status: 'unavailable',
      reason:
        'BRAID_EVAL_PACKAGE_ROOT is required; source modules are not admissible release presenters',
    }
  }
  try {
    const packageJson = await readFile(join(packageRoot, 'package.json'))
    const tarball = tarballPath === null ? null : await readFile(tarballPath)
    return {
      packageRoot,
      tarballPath,
      tarballSha256: tarball === null ? null : hashBytes(tarball),
      installedPackageJsonSha256: hashBytes(packageJson),
      status: tarball === null ? 'unavailable' : 'ready',
      reason:
        tarball === null ? 'BRAID_EVAL_TARBALL_PATH is required for release provenance' : null,
    }
  } catch (error) {
    return {
      packageRoot,
      tarballPath,
      tarballSha256: null,
      installedPackageJsonSha256: null,
      status: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

export function baseCalibration(reason: string | null): CalibrationSummary {
  return {
    passed: false,
    pairedExamples: 0,
    minimumPairedExamples: 12,
    goodExamples: 0,
    goodAccepted: 0,
    minimumGoodAccepted: 0,
    goodPreferred: 0,
    minimumGoodPreferred: 0,
    ties: 0,
    reversals: 0,
    pairPreferenceRate: 0,
    strongMean: 0,
    weakMean: 0,
    trivialMean: 0,
    strongWeakMargin: 0,
    trivialStrongRatio: 1,
    minimumMargin: 0.2,
    maximumTrivialRatio: 0.8,
    perCategory: SEMANTIC_EVAL_CASE_IDS.map((caseId) => ({
      caseId,
      category: SEMANTIC_EVAL_CATEGORIES[caseId],
      pairCount: 0,
      goodExamples: 0,
      goodAccepted: 0,
      goodAcceptancePassed: false,
      goodPreferred: 0,
      ties: 0,
      reversals: 0,
      trivialComparisons: 0,
      trivialRejected: false,
      goodMean: 0,
      badMean: 0,
      trivialMean: 0,
    })),
    pairOutcomes: [],
    failures: reason === null ? ['calibration did not run'] : [reason],
    cells: [],
  }
}

export function emptyPilotInspection(reason: string): PilotInspection {
  return {
    passed: false,
    productAvailable: false,
    parseableJudgeScore: false,
    rawJudgeCallCaptured: false,
    usageCaptured: false,
    costCaptured: false,
    wallTimeCaptured: false,
    failures: [reason],
  }
}

export function basePilot(
  status: 'passed' | 'failed' | 'unavailable',
  reason: string,
): SemanticEvalRecord['pilot'] {
  return {
    status,
    caseId: 'EVAL-01',
    fixtureId: null,
    score: null,
    campaign: null,
    rawJudgeCallIds: [],
    inspection: emptyPilotInspection(reason),
    cost: {
      usd: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: null,
      cachedTokens: 0,
      wallTimeMs: 0,
      provenance: reason,
    },
  }
}

export function makeRecord(input: {
  readonly startedAt: string
  readonly finishedAt: string
  readonly route: EvalRouteConfig
  readonly packageProvenance: EvalPackageProvenance
  readonly provider?: EvalProviderIdentity
  readonly routeProbe: unknown
  readonly packageVersions: Readonly<Record<string, string>>
  readonly calibration: CalibrationSummary
  readonly pilot: SemanticEvalRecord['pilot']
  readonly cases: readonly SemanticCaseEvidence[]
  readonly rawJudgeCalls: readonly RecordedJudgeCall[]
  readonly ledger: CostLedger
  readonly artifacts: readonly EvalArtifactReference[]
  readonly status: SemanticEvalRecord['status']
  readonly releaseAdmissible: boolean
  readonly releaseFailureReasons: readonly string[]
  readonly unavailableReason: string | null
}): SemanticEvalRecord {
  if (input.releaseAdmissible !== (input.status === 'passed')) {
    throw new Error('Semantic release admissibility must match the final evaluation status')
  }
  if (input.releaseAdmissible && input.releaseFailureReasons.length > 0) {
    throw new Error('An admissible semantic evaluation cannot contain release failure reasons')
  }
  const material: Omit<SemanticEvalRecord, 'artifactHash'> = {
    schemaVersion: 2,
    recordId: `braid-semantic-eval-${input.startedAt.replace(/[^0-9]/gu, '')}`,
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: Math.max(0, Date.parse(input.finishedAt) - Date.parse(input.startedAt)),
    command: 'pnpm test:eval',
    packageVersions: input.packageVersions,
    packageProvenance: input.packageProvenance,
    provider: input.provider ?? providerIdentity(input.route),
    routeProbe: redactEvalValue(input.routeProbe),
    calibration: redactEvalValue(input.calibration) as CalibrationSummary,
    pilot: redactEvalValue(input.pilot) as SemanticEvalRecord['pilot'],
    cases: redactEvalValue(input.cases) as readonly SemanticCaseEvidence[],
    rawJudgeCalls: redactEvalValue(input.rawJudgeCalls) as readonly RecordedJudgeCall[],
    receipts: receiptsView(input.ledger),
    artifacts: input.artifacts,
    streams: {
      stdout: {
        captured: false,
        sha256: null,
        reason: 'The outer release collector captures and signs this command stream.',
      },
      stderr: {
        captured: false,
        sha256: null,
        reason: 'The outer release collector captures and signs this command stream.',
      },
    },
    releaseAdmissible: input.releaseAdmissible,
    releaseFailureReasons: input.releaseFailureReasons,
    unavailableReason: input.unavailableReason,
  }
  return withArtifactHash(material)
}

export async function writeRecord(outputDir: string, record: SemanticEvalRecord): Promise<string> {
  assertSemanticEvalRecord(record)
  const path = join(outputDir, 'semantic-evaluation-record.json')
  await writeJsonArtifact(path, 'semantic-evaluation-record', record)
  return path
}

export async function ensureOutputDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  return path
}
