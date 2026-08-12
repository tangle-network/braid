import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBraidSandboxStress } from './tangle-sandbox-braid-stress.mjs'
import { resourceDelta } from './tangle-sandbox-braid-stress-support.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const repository = resolve(dirname(scriptPath), '../..')
const DEFAULT_RUNS = 3
const DEFAULT_CONCURRENCY = 2
const MAX_RUNS = 20
const MAX_CONCURRENCY = 4

function argument(name, argv = process.argv) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined
}

function boundedInteger(value, fallback, maximum, label) {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${label} must be an integer from 1 through ${maximum}`)
  }
  return parsed
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return null
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]
}

function distribution(values) {
  const sorted = values.filter(Number.isFinite).toSorted((left, right) => left - right)
  if (sorted.length === 0) return { n: 0, min: null, median: null, p90: null, max: null }
  return {
    n: sorted.length,
    min: sorted[0],
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    max: sorted.at(-1),
  }
}

function proofPassed(proof) {
  return (
    proof?.status === 'passed' &&
    proof.cleanup?.exactResource === true &&
    proof.cleanup?.identity?.confirmed === true &&
    Array.isArray(proof.cleanup.identity.remainingIds) &&
    proof.cleanup.identity.remainingIds.length === 0 &&
    proof.accountIdentityConsistency?.stable === true
  )
}

function proofIdentity(proof) {
  return proof?.progress?.firstControlRef?.environmentId
}

function accountKey(proof) {
  const account = proof?.accountIdentityConsistency
  return account?.stable === true ? `${account.customerId}:${account.billingOwnerId}` : undefined
}

function latencySummary(attempts) {
  const phases = new Set()
  for (const attempt of attempts) {
    for (const phase of Object.keys(attempt.proof?.timing ?? {})) {
      if (phase !== 'totalMs') phases.add(phase)
    }
  }
  return {
    totalMs: distribution(attempts.map((attempt) => attempt.proof?.timing?.totalMs)),
    phases: Object.fromEntries(
      [...phases]
        .sort()
        .map((phase) => [
          phase,
          distribution(attempts.map((attempt) => attempt.proof?.timing?.[phase]?.elapsedMs)),
        ]),
    ),
  }
}

function sessionSpend(attempts) {
  const rows = attempts.flatMap((attempt) =>
    (attempt.proof?.spend?.rows ?? []).map((row) => ({ attempt: attempt.index, ...row })),
  )
  const tokenRows = rows.map((row) => row.tokens)
  const costRows = rows.map((row) => row.cost)
  const observedTokens = tokenRows.filter((row) => row?.status === 'observed')
  const observedCosts = costRows.filter((row) => row?.status === 'observed')
  return {
    scope: 'every unique local run in every cloud proof',
    rows,
    tokens: {
      observedRuns: observedTokens.length,
      unavailableRuns: tokenRows.filter((row) => row?.status === 'unavailable').length,
      missingRuns: tokenRows.filter((row) => row?.status === 'missing').length,
      input: observedTokens.reduce((total, row) => total + (row.input ?? 0), 0),
      output: observedTokens.reduce((total, row) => total + (row.output ?? 0), 0),
    },
    cost: {
      observedRuns: observedCosts.length,
      unavailableRuns: costRows.filter((row) => row?.status === 'unavailable').length,
      missingRuns: costRows.filter((row) => row?.status === 'missing').length,
      usd: observedCosts.reduce((total, row) => total + (row.usd ?? 0), 0),
    },
  }
}

function cohortUsage(attempts) {
  const before = attempts[0]?.proof?.usage?.find((entry) => entry.phase === 'before')?.value
  const finalAttempt = attempts
    .toSorted((left, right) => left.completionSequence - right.completionSequence)
    .at(-1)
  const after = finalAttempt?.proof?.usage?.find((entry) => entry.phase === 'after')?.value
  const delta = resourceDelta(after, before)
  return {
    complete: before !== undefined && before !== null && after !== undefined && after !== null,
    before: before ?? null,
    after: after ?? null,
    delta,
  }
}

function cohortFailures(attempts, requestedRuns, usage) {
  const failures = []
  if (attempts.length !== requestedRuns) {
    failures.push(`attempted ${attempts.length} of ${requestedRuns} requested runs`)
  }
  for (const attempt of attempts) {
    if (!proofPassed(attempt.proof))
      failures.push(`run ${attempt.index + 1} did not pass exact proof`)
  }

  const uniqueField = (label, values) => {
    if (values.some((value) => typeof value !== 'string' || value.length === 0)) {
      failures.push(`${label} was missing`)
      return
    }
    if (new Set(values).size !== values.length) failures.push(`${label} was reused across runs`)
  }
  uniqueField(
    'proof identity',
    attempts.map((attempt) => attempt.proof?.proofId),
  )
  uniqueField(
    'cloud environment identity',
    attempts.map((attempt) => proofIdentity(attempt.proof)),
  )

  const binaries = attempts.map((attempt) => attempt.proof?.processes?.binarySha256)
  if (binaries.some((value) => typeof value !== 'string' || value.length === 0)) {
    failures.push('Braid binary digest was missing')
  } else if (new Set(binaries).size !== 1) {
    failures.push('Braid binary changed during the cohort')
  }

  const accounts = attempts.map((attempt) => accountKey(attempt.proof))
  if (accounts.some((value) => value === undefined)) {
    failures.push('Sandbox account identity was missing')
  } else if (new Set(accounts).size !== 1) {
    failures.push('Sandbox account identity changed during the cohort')
  }
  if (!usage.complete || usage.delta.activeSandboxes === null) {
    failures.push('cohort active-resource usage was unavailable')
  } else if (usage.delta.activeSandboxes !== 0) {
    failures.push(`cohort active-resource delta was ${usage.delta.activeSandboxes}, expected 0`)
  }
  return [...new Set(failures)]
}

function finish({ attempts, requestedRuns, concurrency, startedAt, stoppedAfterCanary }) {
  const usage = cohortUsage(attempts)
  const failures = cohortFailures(attempts, requestedRuns, usage)
  const activeResourceDeltas = attempts.map(
    (attempt) => attempt.proof?.cleanup?.activeResourceDelta ?? null,
  )
  return {
    schemaVersion: 'braid.tangle-sandbox-braid-soak.v1',
    status: failures.length === 0 ? 'passed' : 'failed',
    startedAt,
    completedAt: new Date().toISOString(),
    requestedRuns,
    attemptedRuns: attempts.length,
    concurrency,
    stoppedAfterCanary,
    failures,
    cleanup: {
      exactProofs: attempts.filter((attempt) => attempt.proof?.cleanup?.exactResource === true)
        .length,
      exactResourcesRemaining: attempts.reduce(
        (total, attempt) =>
          total +
          (Array.isArray(attempt.proof?.cleanup?.identity?.remainingIds)
            ? attempt.proof.cleanup.identity.remainingIds.length
            : 1),
        0,
      ),
      activeResourceDelta: usage.delta.activeSandboxes,
      activeResourceDeltas,
    },
    accountUsage: usage,
    latency: latencySummary(attempts),
    sessionSpend: sessionSpend(attempts),
    attempts,
  }
}

export async function runBraidSandboxSoak({
  environment = process.env,
  repository: suppliedRepository = repository,
  binary,
  runs = boundedInteger(
    environment.BRAID_TANGLE_SANDBOX_STRESS_RUNS,
    DEFAULT_RUNS,
    MAX_RUNS,
    'runs',
  ),
  concurrency = boundedInteger(
    environment.BRAID_TANGLE_SANDBOX_STRESS_CONCURRENCY,
    DEFAULT_CONCURRENCY,
    MAX_CONCURRENCY,
    'concurrency',
  ),
  stressRunner = runBraidSandboxStress,
} = {}) {
  const requestedRuns = boundedInteger(runs, DEFAULT_RUNS, MAX_RUNS, 'runs')
  const requestedConcurrency = Math.min(
    boundedInteger(concurrency, DEFAULT_CONCURRENCY, MAX_CONCURRENCY, 'concurrency'),
    requestedRuns,
  )
  const startedAt = new Date().toISOString()
  const attempts = []
  let completionSequence = 0

  const attempt = async (index, requireZeroActiveResourceDelta) => {
    const attemptStartedAt = new Date().toISOString()
    let proof
    try {
      proof = await stressRunner({
        environment,
        repository: suppliedRepository,
        binary,
        requireZeroActiveResourceDelta,
        attemptIndex: index,
      })
    } catch (error) {
      if (error && typeof error === 'object' && error.unavailable === true) throw error
      proof = {
        status: 'failed',
        failure: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
    return {
      index,
      completionSequence: completionSequence++,
      startedAt: attemptStartedAt,
      completedAt: new Date().toISOString(),
      requireZeroActiveResourceDelta,
      proof,
    }
  }

  const canary = await attempt(0, true)
  attempts.push(canary)
  if (!proofPassed(canary.proof) || requestedRuns === 1) {
    return finish({
      attempts,
      requestedRuns,
      concurrency: requestedConcurrency,
      startedAt,
      stoppedAfterCanary: !proofPassed(canary.proof),
    })
  }

  let nextIndex = 1
  let stop = false
  const workers = Array.from(
    { length: Math.min(requestedConcurrency, requestedRuns - 1) },
    async () => {
      while (!stop) {
        const index = nextIndex
        nextIndex += 1
        if (index >= requestedRuns) return
        const completed = await attempt(index, false)
        attempts.push(completed)
        if (!proofPassed(completed.proof)) stop = true
      }
    },
  )
  await Promise.all(workers)
  attempts.sort((left, right) => left.index - right.index)
  return finish({
    attempts,
    requestedRuns,
    concurrency: requestedConcurrency,
    startedAt,
    stoppedAfterCanary: false,
  })
}

async function writeOutput(path, value) {
  const resolved = resolve(path)
  await mkdir(dirname(resolved), { recursive: true, mode: 0o700 })
  await writeFile(resolved, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

async function main() {
  const result = await runBraidSandboxSoak({
    runs: boundedInteger(argument('runs'), DEFAULT_RUNS, MAX_RUNS, 'runs'),
    concurrency: boundedInteger(
      argument('concurrency'),
      DEFAULT_CONCURRENCY,
      MAX_CONCURRENCY,
      'concurrency',
    ),
  })
  const output = argument('output')
  if (output) await writeOutput(output, result)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (result.status !== 'passed') process.exitCode = 1
}

if (resolve(process.argv[1] ?? '') === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
