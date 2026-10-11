import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { safeJson } from './contracts.mjs'

const OWNER = 'tangle-network/agent-dev-container'
const REFERENCE_SCHEMA = 'braid.provider-comparison.infrastructure-reference.v1'

/** Registrations retain the question; its infrastructure owner executes the analysis. */
export function assertComparisonAnalysis(analysis) {
  const required = [
    'samplingUnit',
    'stoppingRule',
    'uncertaintyMethod',
    'familyAlpha',
    'maxCdfWidth',
    'maxCostWidthUsd',
    'maxPersistenceWidth',
    'seed',
    'resamples',
    'usefulEffects',
    'cutpoints',
  ]
  if (
    analysis === null ||
    typeof analysis !== 'object' ||
    Array.isArray(analysis) ||
    required.some((field) => !Object.hasOwn(analysis, field)) ||
    Object.keys(analysis).length !== required.length
  )
    throw new Error('Comparison analysis registration is incomplete')
  if (
    analysis.samplingUnit !== 'independent-allocation-window' ||
    analysis.stoppingRule !== 'fixed-plan-no-peeking' ||
    analysis.uncertaintyMethod !== 'owner-assessment-required'
  )
    throw new Error(
      'Infrastructure uncertainty must be evaluated by the maintained owner against a fixed plan',
    )
  for (const field of ['familyAlpha', 'maxCdfWidth', 'maxCostWidthUsd', 'maxPersistenceWidth']) {
    if (!Number.isFinite(analysis[field]) || analysis[field] <= 0)
      throw new Error(`Registered ${field} must be positive`)
  }
  if (analysis.familyAlpha > 0.05 || analysis.maxCdfWidth > 1 || analysis.maxPersistenceWidth > 2)
    throw new Error('Registered uncertainty limits exceed their supported range')
  if (
    !Number.isSafeInteger(analysis.seed) ||
    !Number.isSafeInteger(analysis.resamples) ||
    analysis.resamples < 1000 ||
    analysis.resamples > 100000
  )
    throw new Error('Analysis must freeze a safe seed and 1000 through 100000 resamples')
  const fields = [
    'costUsd',
    'createMs',
    'firstUsefulOutputMs',
    'setupMs',
    'manualSteps',
    'persistenceRate',
  ]
  if (
    analysis.usefulEffects === null ||
    typeof analysis.usefulEffects !== 'object' ||
    Object.keys(analysis.usefulEffects).length !== fields.length ||
    fields.some(
      (field) =>
        !Number.isFinite(analysis.usefulEffects[field]) || analysis.usefulEffects[field] <= 0,
    )
  )
    throw new Error('Every dimension must declare a positive useful effect')
  if (analysis.usefulEffects.persistenceRate > 1)
    throw new Error('Registered persistence rate effect exceeds one')
  const metrics = ['createMs', 'firstUsefulOutputMs', 'setupMs', 'manualSteps']
  if (
    analysis.cutpoints === null ||
    typeof analysis.cutpoints !== 'object' ||
    Object.keys(analysis.cutpoints).length !== metrics.length
  )
    throw new Error('Analysis must freeze its quantile cutpoints')
  for (const field of metrics) {
    const cutpoints = analysis.cutpoints[field]
    if (
      cutpoints === null ||
      typeof cutpoints !== 'object' ||
      Object.keys(cutpoints).length !== 2 ||
      !Number.isFinite(cutpoints.p50) ||
      cutpoints.p50 < 0 ||
      !Number.isFinite(cutpoints.p95) ||
      cutpoints.p95 < cutpoints.p50
    )
      throw new Error('Registered quantile cutpoints must be nonnegative and ordered')
  }
  return analysis
}

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a nonnegative integer`)
}

function classifyOwnerArtifact(kind, artifact) {
  if (kind === 'benchmark-records') {
    if (!Array.isArray(artifact)) throw new Error('Owner benchmark export must contain records')
    for (const row of artifact) {
      if (
        typeof row.run_id !== 'string' ||
        typeof row.scenario_id !== 'string' ||
        typeof row.pass !== 'boolean' ||
        typeof row.timestamp !== 'string'
      )
        throw new Error('Owner benchmark record is missing its identity or outcome')
      count(row.iteration, 'owner record iteration')
    }
    return {
      scope: 'owner-benchmark-observations',
      rows: artifact.length,
      passed: artifact.filter((row) => row.pass && row.skipped !== true).length,
      failed: artifact.filter((row) => !row.pass && row.skipped !== true).length,
      skipped: artifact.filter((row) => row.skipped === true).length,
      modelCostField: 'cost_usd',
      modelCostIsInfrastructureBill: false,
    }
  }
  if (kind === 'speed-board') {
    count(artifact.rows, 'owner board rows')
    if (
      !Array.isArray(artifact.groups) ||
      artifact.groups.reduce((sum, group) => sum + group.rows, 0) !== artifact.rows
    )
      throw new Error('Owner speed-board groups do not reconcile to their population')
    return {
      scope: 'descriptive-create-phase-statistics',
      rows: artifact.rows,
      leadershipVerdict: false,
    }
  }
  if (kind === 'speed-experiment') {
    if (typeof artifact.knob !== 'string' || !Array.isArray(artifact.scenarios))
      throw new Error('Owner speed experiment is missing its comparison')
    count(artifact.baseline?.records, 'owner baseline records')
    count(artifact.candidate?.records, 'owner candidate records')
    if (artifact.scenarios.some((scenario) => typeof scenario.verdict?.significant !== 'boolean'))
      throw new Error('Owner speed experiment is missing its significance verdict')
    return {
      scope: 'create-p50-knob-contrast',
      knob: artifact.knob,
      scenarios: artifact.scenarios.length,
      significantScenarios: artifact.scenarios.filter((scenario) => scenario.verdict.significant)
        .length,
      allFourProviderLeadership: false,
    }
  }
  if (kind === 'scorecard') {
    if (
      typeof artifact.product !== 'string' ||
      !Array.isArray(artifact.flows) ||
      !Number.isFinite(artifact.aggregate)
    )
      throw new Error('Owner scorecard is incomplete')
    return {
      scope: 'owner-product-quality',
      aggregate: artifact.aggregate,
      leadershipVerdict: false,
    }
  }
  if (kind === 'lifecycle-cost') {
    if (
      !Number.isFinite(artifact.costPerSandboxHourUsd) ||
      !Number.isFinite(artifact.costPerCreateUsd)
    )
      throw new Error('Owner lifecycle cost is incomplete')
    return { scope: 'amortized-host-infrastructure-cost', settledCustomerCharge: false }
  }
  throw new Error('Unsupported infrastructure owner artifact kind')
}

/** Read an existing owner export; Braid neither runs nor rescales its benchmark. */
export async function readInfrastructureEvidence(referencePath) {
  const reference = JSON.parse(await readFile(resolve(referencePath), 'utf8'))
  const keys = ['schema', 'owner', 'sourceRevision', 'kind', 'artifactPath', 'artifactSha256']
  if (
    reference === null ||
    typeof reference !== 'object' ||
    Object.keys(reference).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(reference, key)) ||
    reference.schema !== REFERENCE_SCHEMA ||
    reference.owner !== OWNER ||
    !/^[a-f0-9]{40}$/u.test(reference.sourceRevision) ||
    !/^sha256:[a-f0-9]{64}$/u.test(reference.artifactSha256) ||
    typeof reference.artifactPath !== 'string'
  )
    throw new Error(
      'Infrastructure evidence requires an exact owner, source revision and artifact digest',
    )
  const bytes = await readFile(resolve(dirname(resolve(referencePath)), reference.artifactPath))
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  if (digest !== reference.artifactSha256)
    throw new Error('Infrastructure owner artifact digest changed')
  const text = bytes.toString('utf8')
  const artifact =
    reference.kind === 'benchmark-records'
      ? text
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line))
      : JSON.parse(text)
  const observation = classifyOwnerArtifact(reference.kind, artifact)
  return {
    owner: reference.owner,
    sourceRevision: reference.sourceRevision,
    kind: reference.kind,
    artifactSha256: digest,
    observation,
    provenance: {
      bytes: 'checksum-verified',
      sourceRevision: 'declared-by-exporter',
      producer: 'not-reexecuted',
    },
    artifact: JSON.parse(safeJson(artifact)),
  }
}
