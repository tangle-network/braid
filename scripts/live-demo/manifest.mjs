import assert from 'node:assert/strict'

export function assertExactPackageProof(proof, expected) {
  assert.ok(proof && typeof proof === 'object', 'The package proof is not an object')
  assert.equal(proof.gitCommit, expected.commit, 'The package proof commit differs')
  assert.equal(proof.version, expected.version, 'The package proof version differs')
  assert.equal(proof.tarball, expected.tarball, 'The package proof tarball name differs')
  assert.equal(
    proof.sha256,
    expected.tarballSha256,
    'The live demo tarball differs from the package proof',
  )
}

export function safeManifestAnalysis(record) {
  const analysis = record.view?.activity?.filter((item) => item.kind === 'analysis').at(-1)
  assert.equal(analysis?.status, 'complete', 'The real /ask activity did not complete')
  const detail = record.view?.entityDetails?.find(
    (item) => item.entityType === 'analysis' && item.entityId === analysis.entityId,
  )
  assert.ok(detail, 'The real /ask analysis retained no public detail')
  assert.equal(detail.status, 'completed', 'The saved /ask analysis did not complete')
  const findings = detail.lines.filter((line) => line.startsWith('• ')).length
  assert.ok(findings > 0, 'The real /ask analysis returned no findings')
  const usage = record.view?.sessionUsage?.analyses
  assert.equal(usage?.sourceCount, 1, 'The live demo expected exactly one analysis usage source')
  const execution = detail.analysisExecution
  assert.ok(execution, 'The saved /ask analysis retained no execution evidence')
  const modelCalls = execution.modelCalls
  const modelLatencyMs =
    modelCalls !== undefined &&
    modelCalls.length > 0 &&
    modelCalls.every((call) => Number.isFinite(call.latencyMs))
      ? modelCalls.reduce((total, call) => total + call.latencyMs, 0)
      : null
  assert.ok(
    ['reported', 'estimated', 'observed-floor', 'unknown'].includes(usage.costStatus),
    'The live demo analysis has no cost provenance',
  )
  return {
    id: analysis.entityId,
    status: detail.status,
    findings,
    configuredModel: execution.configuredModel ?? null,
    observedModels: [...execution.observedModels],
    modelCalls: modelCalls?.length ?? null,
    inputTokens: usage.input ?? null,
    outputTokens: usage.output ?? null,
    costUsd: usage.costUsd ?? null,
    estimatedCostUsd: usage.estimatedCostUsd ?? null,
    costStatus: usage.costStatus,
    modelCallEvidence: modelCalls ?? null,
    modelLatencyMs,
    wallTimeMs: execution.wallTimeMs ?? null,
  }
}
