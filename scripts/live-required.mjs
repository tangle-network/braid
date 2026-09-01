import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { runTraceAnalysis } from './live-required/analysis.mjs'
import {
  EXIT_CODES,
  LiveRequiredError,
  normalizeExternalFailure,
  releaseOutcome,
  resultSummary,
  safeJson,
  safeMessage,
  tangleReceiptsArtifact,
} from './live-required/contracts.mjs'
import { runSupervisorCheck } from './live-required/supervisor.mjs'
import { runTangleFlows } from './live-required/tangle.mjs'

const repository = resolve(new URL('../', import.meta.url).pathname)
const scope = process.argv[2] ?? 'live'

function failureResult(scopeName, error) {
  const classified = normalizeExternalFailure(error, scopeName)
  const detail = safeMessage(classified)
  if (!classified.unavailable) {
    return {
      status: 'failed',
      reason: detail,
    }
  }
  return {
    status: 'unavailable',
    reason: `${scopeName} requires protected live-provider credentials/adapters; ${detail}; no live claim is made by this branch`,
  }
}

function emit(scopeName, result) {
  const outcome = releaseOutcome(scopeName, result)
  process.stdout.write(`${safeJson(resultSummary(scopeName, result))}\n`)
  if (outcome.status === 'passed') {
    process.stdout.write('BRAID_RELEASE_RESULT_JSON={"status":"passed"}\n')
    process.stdout.write(
      `BRAID_RELEASE_MEASUREMENTS_JSON=${safeJson({ measurements: result.measurements })}\n`,
    )
    return outcome.exitCode
  }
  const reason =
    result.reason ??
    (Array.isArray(result.unavailable) && result.unavailable.length > 0
      ? result.unavailable.map(({ row, reason: detail }) => `${row}: ${detail}`).join('; ')
      : (outcome.reason ?? `${scopeName} produced no release measurements`))
  const releaseResult = { status: outcome.status, reason: safeMessage(reason) }
  process.stdout.write(`BRAID_RELEASE_RESULT_JSON=${safeJson(releaseResult)}\n`)
  return outcome.exitCode
}

async function writeReleaseEvidence(scopeName, result) {
  const destination =
    scopeName === 'live-tangle'
      ? process.env.BRAID_LIVE_TANGLE_RECEIPTS
      : scopeName === 'live-supervisor'
        ? process.env.BRAID_LIVE_SUPERVISOR_EVIDENCE
        : scopeName === 'live-analysis'
          ? process.env.BRAID_LIVE_ANALYSIS_EVIDENCE
          : undefined
  const evidence =
    scopeName === 'live-tangle' ? tangleReceiptsArtifact(result?.flows) : result?.evidence
  if (destination === undefined || evidence === undefined) return
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await writeFile(destination, `${safeJson(evidence)}\n`, { mode: 0o600 })
}

async function run() {
  if (scope === 'live-bridge') {
    if (process.env.BRAID_LIVE_BRIDGE !== '1') {
      throw new LiveRequiredError(
        'PROTECTED_BRIDGE_OPT_IN_REQUIRED',
        'The existing packed CLI Bridge release check requires BRAID_LIVE_BRIDGE=1',
        { unavailable: true },
      )
    }
    const module = await import('./live-bridge/main.mjs')
    await module.main()
    return undefined
  }
  if (scope === 'semantic-eval') {
    throw new LiveRequiredError(
      'PROTECTED_EVAL_REQUIRED',
      'Semantic evaluation is owned by the protected agent-eval release command',
      { unavailable: true },
    )
  }
  if (scope === 'live-tangle') return runTangleFlows({ repository, environment: process.env })
  if (scope === 'live-analysis') return runTraceAnalysis({ repository, environment: process.env })
  if (scope === 'live-supervisor')
    return runSupervisorCheck({ repository, environment: process.env })
  throw new LiveRequiredError(
    'LIVE_SCOPE_UNKNOWN',
    `Unknown protected live scope '${scope}'; use live-tangle, live-supervisor, live-analysis, or live-bridge`,
    { unavailable: true },
  )
}

try {
  const result = await run()
  if (result === undefined) process.exitCode = EXIT_CODES.passed
  else {
    await writeReleaseEvidence(scope, result)
    process.exitCode = emit(scope, result)
  }
} catch (error) {
  const result = failureResult(scope, error)
  process.stderr.write(`${safeMessage(result.reason)}\n`)
  process.stdout.write(`${safeJson(resultSummary(scope, result))}\n`)
  process.stdout.write(
    `BRAID_RELEASE_RESULT_JSON=${safeJson({ status: result.status, reason: result.reason })}\n`,
  )
  process.exitCode = result.status === 'failed' ? EXIT_CODES.failed : EXIT_CODES.unavailable
}
