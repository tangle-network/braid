import type { AnalystFinding, ExactAnalystRunResult } from '@tangle-network/agent-eval'
import type { ExternalOptimizerModelExecutionObservation } from '@tangle-network/agent-eval/campaign'
import { AGENT_EVAL_VERSION } from '../adapters/analysis/agent-eval-version.js'
import { mapAnalystFinding } from '../adapters/analysis/citations.js'
import type { AnalystDescriptor } from '../adapters/analysis/eval-analyst.js'
import type {
  AnalysisCheck,
  AnalysisFinding,
  AnalysisProvenance,
  AnalysisRecord,
  AnalysisSourceRange,
  TurnUsage,
} from '../domain/entities.js'
import { analysisModelCallRecords } from './analysis-model-call-records.js'
import type { JsonValue } from '../domain/entities-base.js'
import type { AnalysisIdentity } from './analysis-operation.js'
import type {
  AnalysisApplicationHost,
  AnalysisRequest,
  FrozenAnalysisEvidence,
} from './analysis-types.js'

export function sourceRange(evidence: FrozenAnalysisEvidence): AnalysisSourceRange {
  const sequences = evidence.events.map((event) => event.sequence)
  const firstSequence = sequences.at(0)
  const lastSequence = sequences.at(-1)
  return {
    eventIds: evidence.events.map((event) => event.id),
    messageIds: evidence.messages.map((message) => message.id),
    messagePartIds: evidence.messageParts.map((part) => part.id),
    ...(firstSequence === undefined ? {} : { firstSequence }),
    ...(lastSequence === undefined ? {} : { lastSequence }),
  }
}

function toolNames(evidence: FrozenAnalysisEvidence): readonly string[] {
  const names = new Set<string>()
  for (const frozen of evidence.events) {
    if (frozen.event.kind !== 'run.tool.call') continue
    const value = frozen.event as unknown as Readonly<Record<string, unknown>>
    const name = value.toolName ?? value.name
    if (typeof name === 'string' && name.length > 0) names.add(name)
  }
  return [...names].sort()
}

export function initialAnalysisChecks(evidence: FrozenAnalysisEvidence): readonly AnalysisCheck[] {
  return [
    {
      id: 'source-frozen',
      status: 'passed',
      detail: `digest ${String(evidence.source.digest)}`,
    },
    {
      id: 'source-completeness',
      status: evidence.source.complete ? 'passed' : 'unavailable',
      ...(evidence.source.complete
        ? {}
        : { detail: 'The frozen source contains a declared missing-history range.' }),
    },
  ]
}

export function persistedAnalysisRequest(request: AnalysisRequest): JsonValue {
  return {
    ...(request.conversationId === undefined ? {} : { conversationId: request.conversationId }),
    ...(request.branchId === undefined ? {} : { branchId: request.branchId }),
    ...(request.runId === undefined ? {} : { runId: request.runId }),
    ...(request.throughMessageId === undefined
      ? {}
      : { throughMessageId: request.throughMessageId }),
    ...(request.question === undefined ? {} : { question: request.question }),
    recipe: request.recipe ?? 'ask',
    ...(request.analystIds === undefined ? {} : { analystIds: [...request.analystIds] }),
    ...(request.analystProfileId === undefined
      ? {}
      : { analystProfileId: request.analystProfileId }),
    ...(request.analystProfileDigest === undefined
      ? {}
      : { analystProfileDigest: request.analystProfileDigest }),
    ...(request.budgetUsd === undefined ? {} : { budgetUsd: request.budgetUsd }),
    ...(request.totalTimeoutMs === undefined ? {} : { totalTimeoutMs: request.totalTimeoutMs }),
  }
}

function provenance(
  host: AnalysisApplicationHost,
  evidence: FrozenAnalysisEvidence,
  request: AnalysisRequest,
  identity: AnalysisIdentity,
  analystIds: readonly string[],
  analystVersions: readonly { readonly id: string; readonly version: string }[],
  checks: readonly AnalysisCheck[],
): AnalysisProvenance {
  const state = host.currentState()
  const selectedConnectionId = state.selectedConnectionId
  const model = state.profile.model?.default
  const runner = state.profile.harness
  return {
    operationId: identity.operationId,
    requestDigest: identity.requestDigest,
    analystIds,
    analystVersions,
    agentEvalVersion: AGENT_EVAL_VERSION,
    ...(request.analystProfileId === undefined ? {} : { profileId: request.analystProfileId }),
    ...(request.analystProfileDigest === undefined
      ? {}
      : { profileDigest: request.analystProfileDigest }),
    ...(model === undefined ? {} : { model }),
    ...(runner === undefined ? {} : { runner }),
    ...(selectedConnectionId === null ? {} : { connectionId: selectedConnectionId }),
    tools: toolNames(evidence),
    completeness: evidence.source.complete ? 'complete' : 'incomplete',
    checks,
  }
}

export function initialAnalysisRecord(input: {
  readonly host: AnalysisApplicationHost
  readonly evidence: FrozenAnalysisEvidence
  readonly request: AnalysisRequest
  readonly identity: AnalysisIdentity
  readonly at: string
}): AnalysisRecord {
  const checks = initialAnalysisChecks(input.evidence)
  return {
    id: input.identity.analysisId,
    analysisRunId: input.identity.analysisRunId,
    kind: 'analysis',
    operationId: input.identity.operationId,
    requestDigest: input.identity.requestDigest,
    source: input.evidence.source,
    sourceRange: sourceRange(input.evidence),
    request: persistedAnalysisRequest(input.request),
    ...(input.request.question === undefined ? {} : { question: input.request.question }),
    ...(input.request.recipe === undefined ? {} : { recipe: input.request.recipe }),
    ...(input.request.analystProfileId === undefined
      ? {}
      : { analystProfileId: input.request.analystProfileId }),
    ...(input.request.analystProfileDigest === undefined
      ? {}
      : { analystProfileDigest: input.request.analystProfileDigest }),
    status: 'preparing',
    findings: [],
    modelCalls: analysisModelCallRecords([]),
    checks,
    provenance: provenance(
      input.host,
      input.evidence,
      input.request,
      input.identity,
      input.request.analystIds ?? [],
      [],
      checks,
    ),
    createdAt: input.at,
    updatedAt: input.at,
  }
}

function usageFromResult(result: ExactAnalystRunResult): TurnUsage | undefined {
  let input = 0
  let output = 0
  let reasoning = 0
  let hasTokens = false
  let tokensComplete = true
  for (const summary of result.per_analyst) {
    const tokens = summary.usage.tokens
    if (tokens === null) {
      tokensComplete = false
      continue
    }
    hasTokens = true
    input += tokens.input
    output += tokens.output
    reasoning += tokens.reasoning ?? 0
  }
  const totalCost =
    Number.isFinite(result.total_cost_usd) && result.total_cost_usd >= 0
      ? result.total_cost_usd
      : undefined
  const costUncaptured = result.total_cost_provenance?.kind === 'uncaptured'
  if (!hasTokens && totalCost === 0 && !costUncaptured) return undefined
  return {
    input,
    output,
    ...(!hasTokens || !tokensComplete ? { tokensKnown: false as const } : {}),
    ...(reasoning === 0 ? {} : { reasoning }),
    ...(totalCost === undefined ? {} : { costUsd: totalCost }),
    ...(costUncaptured ? { usdKnown: false as const } : {}),
  }
}

function wallTimeMs(result: ExactAnalystRunResult): number | undefined {
  const started = Date.parse(result.started_at)
  const ended = Date.parse(result.ended_at)
  return Number.isFinite(started) && Number.isFinite(ended)
    ? Math.max(0, ended - started)
    : undefined
}

function unsupportedFinding(finding: AnalystFinding, error: unknown): AnalysisFinding {
  return {
    id: finding.finding_id,
    text: finding.claim,
    ...(finding.severity === undefined ? {} : { severity: finding.severity }),
    ...(finding.confidence === undefined ? {} : { confidence: finding.confidence }),
    citations: [],
    supported: false,
    supportError: error instanceof Error ? error.message : String(error),
  }
}

async function mapFindings(
  evidence: FrozenAnalysisEvidence,
  findings: readonly AnalystFinding[],
): Promise<{ readonly findings: readonly AnalysisFinding[]; readonly supported: boolean }> {
  const { buildAnalysisTraceStore } = await import('../adapters/analysis/trace-store.js')
  const trace = buildAnalysisTraceStore(evidence)
  let supported = true
  const mapped = findings.map((finding) => {
    try {
      const result = mapAnalystFinding(evidence, trace, finding)
      if (!result.supported) supported = false
      return result.supported
        ? result
        : { ...result, supportError: 'Finding did not include a complete supported citation set.' }
    } catch (error) {
      supported = false
      return unsupportedFinding(finding, error)
    }
  })
  return { findings: mapped, supported }
}

export async function completedAnalysisRecord(input: {
  readonly host: AnalysisApplicationHost
  readonly base: AnalysisRecord
  readonly evidence: FrozenAnalysisEvidence
  readonly request: AnalysisRequest
  readonly identity: AnalysisIdentity
  readonly analystIds: readonly string[]
  readonly descriptors: readonly AnalystDescriptor[]
  readonly modelExecutions: readonly ExternalOptimizerModelExecutionObservation[]
  readonly result: ExactAnalystRunResult
  readonly at: string
}): Promise<AnalysisRecord> {
  const mapped = await mapFindings(input.evidence, input.result.findings)
  const checks: readonly AnalysisCheck[] = [
    ...initialAnalysisChecks(input.evidence),
    {
      id: 'citation-support',
      status: mapped.supported ? 'passed' : 'failed',
      ...(mapped.supported
        ? {}
        : { detail: 'One or more findings failed frozen-source citation checks.' }),
    },
    { id: 'agent-eval-completion', status: 'passed' },
  ]
  const descriptorVersions = new Map(
    input.descriptors.map((descriptor) => [descriptor.id, descriptor.version]),
  )
  const analystVersions = input.analystIds.map((id) => ({
    id,
    version: descriptorVersions.get(id) ?? 'unknown',
  }))
  const usage = usageFromResult(input.result)
  const latency = wallTimeMs(input.result)
  return {
    ...input.base,
    status: 'completed',
    findings: mapped.findings,
    checks,
    modelCalls: analysisModelCallRecords(input.modelExecutions),
    provenance: provenance(
      input.host,
      input.evidence,
      input.request,
      input.identity,
      input.analystIds,
      analystVersions,
      checks,
    ),
    ...(usage === undefined ? {} : { usage }),
    ...(input.result.total_cost_provenance?.kind === 'uncaptured'
      ? {}
      : Number.isFinite(input.result.total_cost_usd) && input.result.total_cost_usd >= 0
        ? { costUsd: input.result.total_cost_usd }
        : {}),
    ...(latency === undefined ? {} : { wallTimeMs: latency }),
    updatedAt: input.at,
  }
}
