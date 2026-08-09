import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import type { CostLedger, CostReceipt } from '@tangle-network/agent-eval'
import type { CampaignResult } from '@tangle-network/agent-eval/contract'
import { canonicalJson } from '../domain/canonical.js'
import type {
  CalibrationSummary,
  EvalProviderIdentity,
  ProductOutput,
  RecordedJudgeCall,
  SemanticCaseEvidence,
  SemanticCellEvidence,
  SemanticEvalArtifact,
  SemanticEvalScenario,
} from './types.js'
import { SEMANTIC_EVAL_CASE_IDS } from './types.js'

const SECRET_KEY =
  /(api[_-]?key|authorization|bearer|cookie|credential|password|passphrase|private[_-]?key|secret|token)/iu
const SECRET_ASSIGNMENT =
  /(api[_-]?key|authorization|bearer|cookie|credential|password|passphrase|private[_-]?key|secret|token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/giu

/** Deliberate values used by tests and live-record redaction checks. */
export const EVAL_SECRET_CANARIES = Object.freeze([
  'BRAID_EVAL_SECRET_CANARY',
  'braid-eval-secret-canary',
  'BRAID_EVAL_SECRET',
  'CANARY',
])

export const SEMANTIC_EVAL_RECORD_SCHEMA_VERSION = 2 as const

export interface EvalArtifactReference {
  readonly artifactId: string
  readonly sha256: string
  readonly path: string
}

export interface PilotInspection {
  readonly passed: boolean
  readonly productAvailable: boolean
  readonly parseableJudgeScore: boolean
  readonly rawJudgeCallCaptured: boolean
  readonly usageCaptured: boolean
  readonly costCaptured: boolean
  readonly wallTimeCaptured: boolean
  readonly failures: readonly string[]
}

export interface EvalPackageProvenance {
  readonly packageRoot: string | null
  readonly tarballPath: string | null
  readonly tarballSha256: string | null
  readonly installedPackageJsonSha256: string | null
  readonly status: 'ready' | 'unavailable'
  readonly reason: string | null
}

export interface SemanticEvalRecord {
  readonly schemaVersion: typeof SEMANTIC_EVAL_RECORD_SCHEMA_VERSION
  readonly recordId: string
  readonly status: 'passed' | 'failed' | 'unavailable'
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly command: string
  readonly packageVersions: Readonly<Record<string, string>>
  readonly packageProvenance: EvalPackageProvenance
  readonly provider: EvalProviderIdentity
  readonly routeProbe: unknown
  readonly calibration: CalibrationSummary
  readonly pilot: {
    readonly status: 'passed' | 'failed' | 'unavailable'
    readonly caseId: 'EVAL-01'
    readonly fixtureId: string | null
    readonly score: number | null
    readonly campaign: unknown | null
    readonly rawJudgeCallIds: readonly string[]
    readonly inspection: PilotInspection
    readonly cost: {
      readonly usd: number
      readonly inputTokens: number
      readonly outputTokens: number
      readonly reasoningTokens: number | null
      readonly cachedTokens: number
      readonly wallTimeMs: number
      readonly provenance: unknown
    }
  }
  readonly cases: readonly SemanticCaseEvidence[]
  readonly rawJudgeCalls: readonly RecordedJudgeCall[]
  readonly receipts: readonly unknown[]
  readonly artifacts: readonly EvalArtifactReference[]
  readonly streams: {
    readonly stdout: { readonly captured: false; readonly sha256: null; readonly reason: string }
    readonly stderr: { readonly captured: false; readonly sha256: null; readonly reason: string }
  }
  readonly releaseAdmissible: boolean
  readonly releaseFailureReasons: readonly string[]
  readonly unavailableReason: string | null
  readonly artifactHash: string
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function redactString(value: string): string {
  let output = value.replace(SECRET_ASSIGNMENT, '$1=[REDACTED]')
  for (const canary of EVAL_SECRET_CANARIES) {
    output = output.replace(new RegExp(escapeRegExp(canary), 'giu'), '[REDACTED_SECRET]')
  }
  return output
}

export function containsEvalSecretCanary(value: unknown): boolean {
  const serialized = typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
  return EVAL_SECRET_CANARIES.some((canary) =>
    serialized.toLocaleLowerCase().includes(canary.toLocaleLowerCase()),
  )
}

export function redactEvalValue(value: unknown, _key?: string): unknown {
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map((entry) => redactEvalValue(entry))
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      SECRET_KEY.test(entryKey) ? '[REDACTED]' : redactEvalValue(entryValue, entryKey),
    ]),
  )
}

export function evalCanonicalJson(value: unknown): string {
  return canonicalJson(redactEvalValue(value))
}

export function evalSha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(evalCanonicalJson(value)).digest('hex')}`
}

export function hashText(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export function hashArtifact(value: unknown): string {
  return evalSha256(value)
}

export function receiptView(receipt: CostReceipt): unknown {
  return redactEvalValue({
    callId: receipt.callId,
    channel: receipt.channel,
    phase: receipt.phase,
    actor: receipt.actor,
    model: receipt.model,
    maximumCostUsd: receipt.maximumCostUsd ?? null,
    tags: receipt.tags ?? null,
    timestamp: receipt.timestamp,
    status: receipt.status,
    inputTokens: receipt.inputTokens,
    outputTokens: receipt.outputTokens,
    reasoningTokens: receipt.reasoningTokens ?? null,
    cachedTokens: receipt.cachedTokens ?? 0,
    cacheWriteTokens: receipt.cacheWriteTokens ?? 0,
    costUsd: receipt.costUsd,
    costUnknown: receipt.costUnknown,
    usageUnknown: receipt.usageUnknown ?? false,
    actualCostUsd: receipt.actualCostUsd ?? null,
    estimatedCostUsd: receipt.estimatedCostUsd ?? null,
    pricing: receipt.pricing ?? null,
    error: receipt.error ?? null,
  })
}

export function receiptsView(ledger: CostLedger): readonly unknown[] {
  return ledger.list().map(receiptView)
}

export function cellEvidence(
  cell: CampaignResult<SemanticEvalArtifact, SemanticEvalScenario>['cells'][number],
  rawCalls: readonly RecordedJudgeCall[],
  criteriaThreshold: number,
  ledger: CostLedger,
): SemanticCellEvidence {
  const callIds = cell.costCallIds ?? []
  const judgeScores = Object.fromEntries(
    Object.entries(cell.judgeScores).map(([key, score]) => [
      key,
      redactEvalValue(score) as typeof score,
    ]),
  )
  const compositeValues = Object.values(cell.judgeScores)
    .filter((score) => score.failed !== true)
    .map((score) => score.composite)
  const composite = compositeValues.length === 0 ? 0 : Math.min(...compositeValues)
  const calls = rawCalls.filter((call) => call.callId !== null && callIds.includes(call.callId))
  const productPath =
    cell.artifact.productPath === undefined
      ? null
      : (redactEvalValue(cell.artifact.productPath) as ProductOutput)
  return {
    cellId: cell.cellId,
    scenarioId: cell.scenarioId,
    fixtureId: cell.artifact.fixtureId,
    semanticOutput: redactEvalValue(cell.artifact.semanticOutput),
    candidateOutput: redactString(cell.artifact.candidateOutput),
    productPath,
    judgeScores,
    pass:
      cell.error === undefined &&
      productPath?.available !== false &&
      compositeValues.length > 0 &&
      composite >= criteriaThreshold,
    rawJudgeCallIds: calls.flatMap((call) => (call.callId === null ? [] : [call.callId])),
    cost: cellCostEvidence(cell, rawCalls, ledger),
  }
}

export function cellCostReceipts(
  cell: CampaignResult<SemanticEvalArtifact, SemanticEvalScenario>['cells'][number],
  ledger: CostLedger,
): readonly CostReceipt[] {
  const callIds = new Set(cell.costCallIds ?? [])
  return ledger.list().filter((receipt) => callIds.has(receipt.callId))
}

export function cellCostEvidence(
  cell: CampaignResult<SemanticEvalArtifact, SemanticEvalScenario>['cells'][number],
  rawCalls: readonly RecordedJudgeCall[],
  ledger: CostLedger,
): SemanticCellEvidence['cost'] {
  const callIds = new Set(cell.costCallIds ?? [])
  const receipts = cellCostReceipts(cell, ledger)
  const calls = rawCalls.filter((call) => call.callId !== null && callIds.has(call.callId))
  const reasoning = receipts.flatMap((receipt) =>
    receipt.reasoningTokens === undefined ? [] : [receipt.reasoningTokens],
  )
  return {
    usd: receipts.reduce((sum, receipt) => sum + receipt.costUsd, 0),
    provenance: receipts.length === 0 ? null : receipts.map(receiptView),
    inputTokens: receipts.reduce((sum, receipt) => sum + receipt.inputTokens, 0),
    outputTokens: receipts.reduce((sum, receipt) => sum + receipt.outputTokens, 0),
    reasoningTokens:
      reasoning.length === 0 ? null : reasoning.reduce((sum, value) => sum + value, 0),
    cachedTokens: receipts.reduce((sum, receipt) => sum + (receipt.cachedTokens ?? 0), 0),
    wallTimeMs: Math.max(cell.durationMs, ...calls.map((call) => call.wallTimeMs)),
  }
}

export function recordHashMaterial(record: Omit<SemanticEvalRecord, 'artifactHash'>): unknown {
  return redactEvalValue(record)
}

export function withArtifactHash(
  record: Omit<SemanticEvalRecord, 'artifactHash'>,
): SemanticEvalRecord {
  return { ...record, artifactHash: evalSha256(recordHashMaterial(record)) }
}

function requiredNumber(value: unknown, label: string, errors: string[]): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    errors.push(`${label} must be a finite non-negative number`)
}

export function validateSemanticEvalRecord(record: unknown): readonly string[] {
  const errors: string[] = []
  if (record === null || typeof record !== 'object') return ['record must be an object']
  const candidate = record as Partial<SemanticEvalRecord>
  if (candidate.schemaVersion !== SEMANTIC_EVAL_RECORD_SCHEMA_VERSION)
    errors.push(`schemaVersion must be ${SEMANTIC_EVAL_RECORD_SCHEMA_VERSION}`)
  if (typeof candidate.recordId !== 'string' || candidate.recordId.length === 0)
    errors.push('recordId is required')
  if (!['passed', 'failed', 'unavailable'].includes(candidate.status ?? ''))
    errors.push('status is invalid')
  if (typeof candidate.startedAt !== 'string' || typeof candidate.finishedAt !== 'string')
    errors.push('timestamps are required')
  requiredNumber(candidate.durationMs, 'durationMs', errors)
  if (candidate.cases === undefined || !Array.isArray(candidate.cases))
    errors.push('cases are required')
  else {
    const ids = candidate.cases.map((item) => item.id)
    for (const id of SEMANTIC_EVAL_CASE_IDS) {
      if (ids.filter((value) => value === id).length !== 1)
        errors.push(`${id} must occur exactly once`)
    }
    if (candidate.status === 'passed') {
      for (const evidence of candidate.cases) {
        if (evidence.result !== 'passed') errors.push(`${evidence.id} must pass in a passed record`)
        if (evidence.fixtureCount < 3)
          errors.push(`${evidence.id} requires at least three release fixtures`)
        if (
          evidence.passedFixtures !== evidence.fixtureCount ||
          evidence.failedFixtures !== 0 ||
          evidence.cells.length !== evidence.fixtureCount
        ) {
          errors.push(`${evidence.id} fixture results are incomplete`)
        }
        if (evidence.productFailures.length > 0 || evidence.campaign === null) {
          errors.push(`${evidence.id} product or campaign evidence is incomplete`)
        }
      }
    }
  }
  if (candidate.calibration === undefined) errors.push('calibration is required')
  else {
    if (!Array.isArray(candidate.calibration.pairOutcomes))
      errors.push('calibration pair outcomes are required')
    if (
      !Array.isArray(candidate.calibration.perCategory) ||
      candidate.calibration.perCategory.length !== 6
    )
      errors.push('calibration must record six category outcomes')
    if (candidate.status === 'passed' && candidate.calibration.passed !== true)
      errors.push('passed record requires passed calibration')
  }
  if (candidate.pilot === undefined || candidate.pilot.caseId !== 'EVAL-01')
    errors.push('pilot must be EVAL-01')
  else if (
    candidate.status === 'passed' &&
    (candidate.pilot.status !== 'passed' || candidate.pilot.inspection.passed !== true)
  ) {
    errors.push('passed record requires a passed pilot')
  }
  if (candidate.rawJudgeCalls === undefined || !Array.isArray(candidate.rawJudgeCalls))
    errors.push('raw judge calls are required')
  else {
    for (const call of candidate.rawJudgeCalls) {
      if (call.response === null && call.error === null)
        errors.push('judge call must have response or error')
      if (call.response !== null && call.error !== null)
        errors.push('judge call cannot have response and error')
      requiredNumber(call.wallTimeMs, 'judge call wall time', errors)
    }
  }
  if (candidate.streams?.stdout.captured !== false || candidate.streams.stderr.captured !== false)
    errors.push('stream capture posture must be explicit')
  if (candidate.status === 'passed') {
    if (candidate.releaseAdmissible !== true)
      errors.push('passed record must be release-admissible')
    if (candidate.packageProvenance?.status !== 'ready') {
      errors.push('passed record requires ready installed-package provenance')
    }
    if (
      !Array.isArray(candidate.releaseFailureReasons) ||
      candidate.releaseFailureReasons.length > 0
    ) {
      errors.push('passed record cannot contain release failure reasons')
    }
    if (candidate.unavailableReason !== null) errors.push('passed record cannot be unavailable')
  } else if (candidate.releaseAdmissible === true) {
    errors.push('only a passed record can be release-admissible')
  }
  if (candidate.artifactHash !== undefined) {
    const material = { ...candidate }
    delete (material as { artifactHash?: string }).artifactHash
    const expected = evalSha256(material)
    if (candidate.artifactHash !== expected)
      errors.push('artifactHash does not match canonical record')
  } else errors.push('artifactHash is required')
  if (containsEvalSecretCanary(record))
    errors.push('record contains an unredacted seeded secret canary')
  return errors
}

export function assertSemanticEvalRecord(record: unknown): asserts record is SemanticEvalRecord {
  const errors = validateSemanticEvalRecord(record)
  if (errors.length > 0) throw new Error(`Invalid semantic evaluation record: ${errors.join('; ')}`)
}

export async function writeJsonArtifact(
  path: string,
  artifactId: string,
  value: unknown,
): Promise<EvalArtifactReference> {
  const content = `${evalCanonicalJson(value)}\n`
  await writeFile(path, content, { encoding: 'utf8', mode: 0o600 })
  return { artifactId, sha256: hashText(content), path }
}
