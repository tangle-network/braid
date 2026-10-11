import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { safeJson } from './contracts.mjs'
import {
  captureComparisonAttempt,
  comparisonDigest,
  observedMeasurement,
  readComparisonPlan,
  writeComparisonArtifact,
} from './provider-comparison.mjs'

/** The cohort is frozen and retained before the existing live producer starts. */
export async function prepareTangleComparison(environment, runs, concurrency) {
  const planPath = environment.BRAID_LIVE_PROVIDER_PLAN
  if (planPath === undefined) return undefined
  const plan = await readComparisonPlan(planPath)
  const cells = plan.attempts.filter((cell) => cell.provider === 'tangle')
  if (cells.length !== runs || plan.cohort.concurrency !== concurrency) {
    throw new Error('Tangle live runs and concurrency must match the predeclared comparison plan')
  }
  const output = environment.BRAID_LIVE_PROVIDER_RECORDS
  if (typeof output !== 'string' || output.length === 0) {
    throw new Error(
      'BRAID_LIVE_PROVIDER_RECORDS must retain the frozen plan and resulting attempts',
    )
  }
  await mkdir(dirname(resolve(output)), { recursive: true, mode: 0o700 })
  await writeFile(
    resolve(output),
    `${safeJson({
      schema: 'braid.provider-comparison.pending.v1',
      plan,
      planDigest: comparisonDigest(plan),
      comparableAttempts: [],
    })}\n`,
    { mode: 0o600, flag: 'wx' },
  )
  return { plan, cells, output }
}

export async function retainTangleComparison(comparison, comparableAttempts) {
  await writeComparisonArtifact(comparison.output, {
    plan: comparison.plan,
    planDigest: comparisonDigest(comparison.plan),
    comparableAttempts,
  })
}

/** Existing retained proof cannot establish cloud VM restart, allocation or billed compute. */
export function captureTangleComparison(comparison, attempts) {
  return attempts.map((attempt) => {
    const proof = attempt.proof
    const measurements = { actual: {}, persistence: {}, cleanup: {}, allocation: {} }
    if (typeof proof.config?.model === 'string') {
      measurements.actual.model = observedMeasurement(proof.config.model, ['config', 'model'])
    }
    if (typeof proof.config?.runner === 'string') {
      measurements.actual.runner = observedMeasurement(proof.config.runner, ['config', 'runner'])
    }
    if (proof.telemetry?.fields?.region?.status === 'observed') {
      measurements.actual.region = observedMeasurement(proof.telemetry.fields.region.value, [
        'telemetry',
        'fields',
        'region',
        'value',
      ])
    }
    if (typeof proof.cleanup?.exactResource === 'boolean') {
      measurements.cleanup.exactOwnedResourcesRemoved = observedMeasurement(
        proof.cleanup.exactResource,
        ['cleanup', 'exactResource'],
      )
    }
    if (typeof proof.config?.modelProvider === 'string') {
      measurements.actual.modelProvider = observedMeasurement(proof.config.modelProvider, [
        'config',
        'modelProvider',
      ])
    }
    if (typeof proof.progress?.firstControlRef?.environmentId === 'string') {
      measurements.allocation.environmentId = observedMeasurement(
        proof.progress.firstControlRef.environmentId,
        ['progress', 'firstControlRef', 'environmentId'],
      )
    }
    return captureComparisonAttempt({
      plan: comparison.plan,
      id: comparison.cells[attempt.index].id,
      proof,
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt,
      measurements,
    })
  })
}
