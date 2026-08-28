import { connectionConfiguration } from './configuration.mjs'
import {
  classifyExternalFailure,
  PROOF_OPERATIONS,
  proofInvocation,
  proofReceipt,
  scalarMeasurement,
} from './contracts.mjs'
import {
  closeSession,
  configEvidence,
  initializedSession,
  prepareProductionWorkspace,
  resolveBinary,
  rpcRequest,
  rpcState,
  runHeadlessTurn,
} from './headless.mjs'

function sourceSnapshot(state) {
  return JSON.stringify({
    messages: state.messages,
    runs: state.runs,
  })
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

function analysisSummary(analysis) {
  if (analysis === undefined) return null
  return {
    id: analysis.id,
    status: analysis.status,
    findings: Array.isArray(analysis.findings)
      ? analysis.findings.map((finding) => ({
          id: finding.id,
          supported: finding.supported,
          citations: Array.isArray(finding.citations) ? finding.citations.length : null,
        }))
      : null,
    checks: Array.isArray(analysis.checks)
      ? analysis.checks.map((check) => ({ id: check.id, status: check.status }))
      : null,
    modelCalls: Array.isArray(analysis.modelCalls)
      ? analysis.modelCalls.map((call) => ({
          id: call.id,
          model: call.model,
          status: call.status,
          errorKind: call.errorKind,
          errorStatus: call.errorStatus,
          inputTokens: call.inputTokens,
          outputTokens: call.outputTokens,
          cost: call.cost,
        }))
      : null,
  }
}

export async function runTraceAnalysis({ repository, environment }) {
  const binary = await resolveBinary(repository, environment)
  const invocationId = proofInvocation('live-analysis')
  const startedAt = new Date().toISOString()
  const values = connectionConfiguration(environment, {
    prefix: 'BRAID_ANALYSIS',
    kind: 'tangle-inference',
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
  let restored
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
      const detail = typeof data?.error === 'string' ? `: ${data.error}` : ''
      const failedAnalysis =
        analysis ??
        (Array.isArray(afterResponse.state?.analyses)
          ? afterResponse.state.analyses.at(-1)
          : undefined)
      throw new Error(
        `trace analysis returned ${String(data?.status ?? 'no status')} instead of completed; evidence=${JSON.stringify(analysisSummary(failedAnalysis))}${detail}`,
      )
    }
    if (!supportedFindings(analysis)) {
      throw new Error('trace analysis returned no finding with supported citations')
    }
    await closeSession(source.session)
    restored = await initializedSession(binary, config)
    const persistedResponse = await rpcRequest(restored.session, 'get_details', {
      entityType: 'analysis',
      entityId: analysis.id,
    })
    const persisted = persistedResponse.result?.data
    if (persisted?.status !== 'completed' || !supportedFindings(persisted)) {
      throw new Error(
        `trace analysis result was not durably persisted with supported citations: ${JSON.stringify({ returned: analysisSummary(analysis), persisted: analysisSummary(persisted) })}`,
      )
    }
    if (JSON.stringify(persisted.source?.digest) !== JSON.stringify(data.source?.digest)) {
      throw new Error('trace analysis persisted a different frozen source digest')
    }
    if (sourceSnapshot(afterResponse.state) !== before) {
      throw new Error('trace analysis changed the frozen source run')
    }
    if (
      !persisted.usage ||
      persisted.usage.tokensKnown === false ||
      !Number.isFinite(persisted.usage.input) ||
      !Number.isFinite(persisted.usage.output) ||
      (!Number.isFinite(persisted.usage.costUsd) &&
        !Number.isFinite(persisted.usage.estimatedCostUsd))
    ) {
      throw new Error(
        `trace analysis did not settle usage and cost receipts: ${JSON.stringify({ usage: persisted.usage ?? null, costUsd: persisted.costUsd ?? null, modelCalls: persisted.modelCalls ?? null })}`,
      )
    }
    if (!Array.isArray(persisted.modelCalls) || persisted.modelCalls.length === 0) {
      throw new Error('trace analysis did not persist any model-call records')
    }
    const findingIds = analysis.findings.map((finding) => finding.id)
    const promotion = await rpcRequest(
      restored.session,
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
    await closeSession(restored.session)
    return {
      status: 'passed',
      measurements: [scalarMeasurement('LIVE-12')],
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
          modelCallCount: persisted.modelCalls.length,
          promoted: true,
          usage: {
            inputTokens: persisted.usage.input,
            outputTokens: persisted.usage.output,
            tokensKnown: persisted.usage.tokensKnown !== false,
            costKind:
              persisted.usage.usdKnown !== false && Number.isFinite(persisted.usage.costUsd)
                ? 'observed'
                : 'estimated',
            costUsd:
              persisted.usage.usdKnown !== false && Number.isFinite(persisted.usage.costUsd)
                ? persisted.usage.costUsd
                : persisted.usage.estimatedCostUsd,
            usdKnown:
              persisted.usage.usdKnown !== false && Number.isFinite(persisted.usage.costUsd),
          },
        },
        checks: ['source-frozen', 'cited-finding', 'restart-restored', 'promoted'],
      }),
    }
  } catch (error) {
    const classified = classifyExternalFailure(error, 'Trace analysis', environment)
    throw classified
  } finally {
    if (source?.session) await closeSession(source.session).catch(() => undefined)
    if (restored?.session) await closeSession(restored.session).catch(() => undefined)
    await config.cleanup()
  }
}
