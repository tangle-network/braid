import {
  closeSession,
  configEvidence,
  prepareProductionWorkspace,
  resolveBinary,
  rpcRequest,
  rpcState,
  runHeadlessTurn,
} from './headless.mjs'
import {
  PROOF_OPERATIONS,
  classifyExternalFailure,
  proofInvocation,
  proofReceipt,
  scalarMeasurement,
} from './contracts.mjs'
import { connectionConfiguration } from './configuration.mjs'

function sourceSnapshot(state) {
  return JSON.stringify({
    messages: state.messages,
    runs: state.runs,
  })
}

function analysisRecord(state, analysisId) {
  const analyses = Array.isArray(state.analyses) ? state.analyses : []
  return analyses.find((candidate) => String(candidate.id) === analysisId)
}

function supportedFindings(analysis) {
  if (!Array.isArray(analysis?.findings) || analysis.findings.length === 0) return false
  return analysis.findings.every(
    (finding) =>
      finding.supported === true &&
      Array.isArray(finding.citations) &&
      finding.citations.length > 0,
  )
}

export async function runTraceAnalysis({ repository, environment }) {
  const binary = await resolveBinary(repository, environment)
  const invocationId = proofInvocation('live-analysis')
  const startedAt = new Date().toISOString()
  const values = connectionConfiguration(environment, {
    prefix: 'BRAID_ANALYSIS',
    kind: 'trace analysis',
    endpointNames: ['BRAID_TANGLE_ENDPOINT'],
    modelNames: ['BRAID_TANGLE_MODEL'],
    runnerNames: ['BRAID_TANGLE_RUNNER'],
    providerNames: ['BRAID_TANGLE_PROVIDER'],
    fallbackRunner: 'cli-base',
    credentialFallbacks: ['BRAID_TANGLE_CREDENTIAL_REF'],
  })
  const config = await prepareProductionWorkspace({
    repository,
    environment,
    ...values,
  })
  let source
  try {
    source = await runHeadlessTurn({
      binary,
      config,
      marker: 'LIVE_BRAID_ANALYSIS_SOURCE_OK',
      prompt: 'Reply with exactly LIVE_BRAID_ANALYSIS_SOURCE_OK.',
    })
    const before = sourceSnapshot(source.terminal.state)
    const result = await rpcRequest(
      source.session,
      'ask',
      {
        source: `run:${source.run.id}`,
        question:
          'Identify one concrete, cited fact from this run and explain why it is supported.',
      },
      `op-live-required-analysis-${source.run.id}`,
    )
    const afterResponse = await rpcState(source.session)
    const data = result.result
    const analysis = data?.analysis
    if (data?.status !== 'completed' || typeof analysis?.id !== 'string') {
      throw new Error('trace analysis did not return a completed analysis record')
    }
    if (!supportedFindings(analysis)) {
      throw new Error('trace analysis returned no finding with supported citations')
    }
    const persisted = analysisRecord(afterResponse.state, analysis.id)
    if (persisted?.status !== 'completed' || !supportedFindings(persisted)) {
      throw new Error('trace analysis result was not durably persisted with supported citations')
    }
    if (JSON.stringify(persisted.source?.digest) !== JSON.stringify(data.source?.digest)) {
      throw new Error('trace analysis persisted a different frozen source digest')
    }
    if (sourceSnapshot(afterResponse.state) !== before) {
      throw new Error('trace analysis changed the frozen source run')
    }
    if (
      !Number.isFinite(persisted.costUsd) ||
      !persisted.usage ||
      !Number.isFinite(persisted.usage.input) ||
      !Number.isFinite(persisted.usage.output)
    ) {
      throw new Error('trace analysis did not settle usage and cost receipts')
    }
    const findingIds = analysis.findings.map((finding) => finding.id)
    const promotion = await rpcRequest(
      source.session,
      'promote_analysis',
      {
        analysisId: analysis.id,
        findingIds,
        conversationId: source.initial.state.conversationId,
        branchId: source.initial.state.branchId,
      },
      `op-live-required-analysis-promotion-${analysis.id}`,
    )
    if (
      promotion.result?.analysisId !== analysis.id ||
      promotion.result?.sourceDigest !== data.source?.digest
    ) {
      throw new Error('trace analysis promotion did not preserve analysis provenance')
    }
    await closeSession(source.session)
    return {
      status: 'passed',
      measurement: scalarMeasurement('LIVE-12'),
      evidence: proofReceipt({
        invocationId,
        operation: PROOF_OPERATIONS.traceAnalysis,
        startedAt,
        completedAt: new Date().toISOString(),
        config: configEvidence(config),
        runIds: [source.run.id],
        facts: {
          analysisId: analysis.id,
          findingCount: findingIds.length,
          promoted: true,
        },
        checks: ['source-frozen', 'cited-finding', 'persisted', 'promoted'],
      }),
    }
  } catch (error) {
    const classified = classifyExternalFailure(error, 'Trace analysis', environment)
    throw classified
  } finally {
    if (source?.session) await closeSession(source.session).catch(() => undefined)
    await config.cleanup()
  }
}
