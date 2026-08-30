import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Sandbox } from '@tangle-network/sandbox'
import { connectionConfiguration } from './configuration.mjs'
import { safeMessage } from './contracts.mjs'
import {
  closeSession,
  configEvidence,
  prepareProductionWorkspace,
  resolveBinary,
  runHeadlessTurn,
} from './headless.mjs'
import { DEFAULT_TANGLE_ROUTER_MODEL } from './model-defaults.mjs'
import {
  environmentForRun,
  resourceDelta,
  runObservations,
} from './tangle-sandbox-braid-stress-support.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_RUNS = 3
const DEFAULT_CONCURRENCY = 2
const MAX_RUNS = 20
const MAX_CONCURRENCY = 4

function argument(name, argv = process.argv) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined
}

function boundedInteger(value, fallback, maximum, name) {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}`)
  }
  return parsed
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return null
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]
}

export function executionLatencyDistribution(attempts) {
  const sorted = attempts
    .map((attempt) => attempt.elapsedMs)
    .filter(Number.isFinite)
    .toSorted((left, right) => left - right)
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    max: sorted.at(-1) ?? null,
  }
}

export function sandboxEnvironment(environment) {
  return {
    ...environment,
    BRAID_TANGLE_SANDBOX_ENDPOINT:
      environment.BRAID_TANGLE_SANDBOX_ENDPOINT?.trim() || 'https://sandbox.tangle.tools',
    BRAID_TANGLE_SANDBOX_MODEL:
      environment.BRAID_TANGLE_SANDBOX_MODEL?.trim() || DEFAULT_TANGLE_ROUTER_MODEL,
    BRAID_TANGLE_SANDBOX_RUNNER: environment.BRAID_TANGLE_SANDBOX_RUNNER?.trim() || 'opencode',
    ...(!environment.BRAID_TANGLE_SANDBOX_API_KEY && environment.TANGLE_API_KEY
      ? { BRAID_TANGLE_SANDBOX_API_KEY: environment.TANGLE_API_KEY }
      : {}),
  }
}

function sandboxConfiguration(environment) {
  return connectionConfiguration(environment, {
    prefix: 'BRAID_TANGLE_SANDBOX',
    kind: 'tangle-sandbox',
    endpointNames: ['BRAID_TANGLE_ENDPOINT'],
    modelNames: ['BRAID_TANGLE_MODEL'],
    runnerNames: ['BRAID_TANGLE_RUNNER'],
    providerNames: ['BRAID_TANGLE_SANDBOX_PROVIDER'],
    modelProviderNames: ['BRAID_TANGLE_SANDBOX_MODEL_PROVIDER'],
    fallbackModelProvider: 'tangle-router',
  })
}

async function listedByName(client, name) {
  const matches = []
  let offset = 0
  for (;;) {
    const page = await client.list({ limit: 100, offset })
    for (const box of page) if (box.name === name) matches.push(box)
    if (page.length < 100) return matches
    offset += page.length
  }
}

async function removeOwned(client, name) {
  const owned = await listedByName(client, name)
  for (const box of owned) await box.delete()
  const remaining = await listedByName(client, name)
  return {
    matched: owned.map((box) => box.id),
    remaining: remaining.map((box) => box.id),
  }
}

function publicError(error, environment) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: safeMessage(error, environment),
  }
}

function identityDigest(identity) {
  return createHash('sha256')
    .update(`${identity.customerId ?? ''}:${identity.billingOwnerId ?? ''}`)
    .digest('hex')
}

function publicUsage(value) {
  if (!value || typeof value !== 'object') return value
  const fields = [
    'completeness',
    'computeMinutes',
    'gpuSeconds',
    'gpuCostUsd',
    'gpuProviderCostUsd',
    'activeSandboxes',
    'totalSandboxes',
    'maximumConcurrentSandboxes',
    'maximumCpuCores',
    'maximumRamGB',
    'maximumStorageGB',
    'periodStart',
    'periodEnd',
    'usagePeriodStart',
    'usagePeriodEnd',
    'sampledAt',
  ]
  return Object.fromEntries(
    fields.filter((field) => value[field] !== undefined).map((field) => [field, value[field]]),
  )
}

function publicObservations(run, state) {
  const observations = runObservations(run, state)
  const accountUsage = observations.environmentRecord?.accountUsage
  const accountTelemetry = observations.environment.accountUsage
  return {
    ...observations,
    environmentRecord:
      observations.environmentRecord === null
        ? null
        : {
            ...observations.environmentRecord,
            ...(accountUsage === undefined ? {} : { accountUsage: publicUsage(accountUsage) }),
          },
    environment: {
      ...observations.environment,
      ...(accountTelemetry?.status !== 'observed'
        ? {}
        : { accountUsage: { ...accountTelemetry, value: publicUsage(accountTelemetry.value) } }),
    },
  }
}

async function runAttempt({ index, proofId, client, binary, values, environment }) {
  const started = performance.now()
  const marker = `BRAID_CLOUD_EXECUTION_${proofId}_${index}_OK`.toUpperCase()
  const connectionName = `braid-execution-${proofId}-${index}`
  let config
  let turn
  let exactEnvironmentId
  let automaticCleanup = false
  let result
  try {
    config = await prepareProductionWorkspace({
      repository,
      environment,
      ...values,
      connectionName,
    })
    turn = await runHeadlessTurn({
      binary,
      config,
      marker,
      prompt: [
        'Use shell tools in the sandbox.',
        `Create ./${connectionName}.txt in the current working directory containing exactly ${marker} followed by a newline.`,
        `Read ./${connectionName}.txt and verify its exact contents.`,
        'Run git -C . init if needed.',
        'Verify git -C . rev-parse --is-inside-work-tree prints true.',
        `Reply with exactly ${marker}.`,
      ].join(' '),
    })
    const state = turn.terminal.state
    const run = state.runs.find((candidate) => candidate.id === turn.run.id)
    assert.ok(run, 'terminal state omitted the admitted run')
    const observed = environmentForRun(state, run)
    assert.ok(observed, 'terminal state omitted the execution environment')
    exactEnvironmentId = observed.providerEnvironmentId
    assert.equal(observed.lifecycle, 'destroyed', 'Sandbox lifecycle was not destroyed')
    assert.equal(observed.cleanup, 'delete-after-turn', 'Sandbox cleanup policy changed')
    assert.equal(observed.continuity, 'unavailable', 'Ephemeral execution claimed continuity')
    assert.equal(observed.location, 'remote', 'Sandbox execution was not remote')
    assert.ok(exactEnvironmentId, 'Sandbox provider identity was unavailable')
    automaticCleanup = (await client.get(exactEnvironmentId)) === null
    assert.equal(automaticCleanup, true, 'Sandbox remained after the completed Braid turn')
    result = {
      index,
      status: 'passed',
      elapsedMs: performance.now() - started,
      runId: run.id,
      operationId: run.operationId,
      model: run.model ?? null,
      runner: run.runner ?? null,
      message: turn.message.text,
      environmentId: exactEnvironmentId,
      automaticCleanup,
      usage: {
        tokens:
          run.tokensKnown === false
            ? { status: 'unavailable' }
            : Number.isSafeInteger(run.inputTokens) && Number.isSafeInteger(run.outputTokens)
              ? { status: 'observed', input: run.inputTokens, output: run.outputTokens }
              : { status: 'missing' },
        cost:
          run.usdKnown === false
            ? { status: 'unavailable' }
            : typeof run.costUsd === 'number'
              ? { status: run.costStatus ?? 'observed', usd: run.costUsd }
              : { status: 'missing' },
      },
      observation: publicObservations(run, state),
    }
  } catch (error) {
    result = {
      index,
      status: 'failed',
      elapsedMs: performance.now() - started,
      environmentId: exactEnvironmentId ?? null,
      automaticCleanup,
      error: publicError(error, environment),
    }
  } finally {
    if (turn?.session) await closeSession(turn.session).catch(() => undefined)
    if (config) await config.cleanup().catch(() => undefined)
  }

  try {
    const cleanup = await removeOwned(client, connectionName)
    if (cleanup.remaining.length > 0) {
      throw new Error(`Exact cleanup left ${cleanup.remaining.length} owned Sandbox resource(s)`)
    }
    return {
      ...result,
      cleanup: {
        status: 'passed',
        matchedCount: cleanup.matched.length,
        remainingCount: 0,
      },
    }
  } catch (error) {
    const cleanupError = publicError(error, environment)
    return {
      ...result,
      status: 'failed',
      cleanup: { status: 'failed', error: cleanupError },
      error:
        result.status === 'failed'
          ? {
              name: 'AggregateError',
              message: `${result.error.message}; cleanup failed: ${cleanupError.message}`,
            }
          : cleanupError,
    }
  }
}

export async function runBraidSandboxExecutionSoak({
  environment: sourceEnvironment = process.env,
  runs = DEFAULT_RUNS,
  concurrency = DEFAULT_CONCURRENCY,
  attemptRunner = runAttempt,
} = {}) {
  const requestedRuns = boundedInteger(runs, DEFAULT_RUNS, MAX_RUNS, 'runs')
  const requestedConcurrency = Math.min(
    boundedInteger(concurrency, DEFAULT_CONCURRENCY, MAX_CONCURRENCY, 'concurrency'),
    requestedRuns,
  )
  const environment = sandboxEnvironment(sourceEnvironment)
  const values = sandboxConfiguration(environment)
  const client = new Sandbox({ baseUrl: values.endpoint, apiKey: values.credentialValue })
  const binary = await resolveBinary(repository, environment)
  const proofId = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const startedAt = new Date().toISOString()
  const before = await client.usage()
  const identityBefore = await client.getIdentity()
  const attempts = []
  let nextIndex = 1
  let stop = false

  const input = { proofId, client, binary, values, environment }
  const canary = await attemptRunner({ ...input, index: 0 })
  attempts.push(canary)
  if (canary.status === 'passed') {
    const workers = Array.from(
      { length: Math.min(requestedConcurrency, requestedRuns - 1) },
      async () => {
        while (!stop) {
          const index = nextIndex
          nextIndex += 1
          if (index >= requestedRuns) return
          const attempt = await attemptRunner({ ...input, index })
          attempts.push(attempt)
          if (attempt.status !== 'passed') stop = true
        }
      },
    )
    await Promise.all(workers)
  }
  attempts.sort((left, right) => left.index - right.index)
  const after = await client.usage()
  const identityAfter = await client.getIdentity()
  const usageDelta = resourceDelta(after, before)
  const failures = []
  if (attempts.length !== requestedRuns)
    failures.push(`attempted ${attempts.length} of ${requestedRuns}`)
  for (const attempt of attempts) {
    if (attempt.status !== 'passed') failures.push(`run ${attempt.index + 1} failed`)
    if (attempt.automaticCleanup !== true)
      failures.push(`run ${attempt.index + 1} lacked automatic cleanup`)
  }
  if (usageDelta.activeSandboxes !== 0) {
    failures.push(`active Sandbox delta was ${usageDelta.activeSandboxes ?? 'unavailable'}`)
  }
  if (
    identityBefore.customerId !== identityAfter.customerId ||
    identityBefore.billingOwnerId !== identityAfter.billingOwnerId
  ) {
    failures.push('Sandbox account identity changed during the cohort')
  }
  return {
    schemaVersion: 'braid.tangle-sandbox-execution-soak.v1',
    status: failures.length === 0 ? 'passed' : 'failed',
    proofId,
    startedAt,
    completedAt: new Date().toISOString(),
    requestedRuns,
    attemptedRuns: attempts.length,
    concurrency: requestedConcurrency,
    failures,
    config: {
      ...configEvidence({
        endpoint: {
          scheme: new URL(values.endpoint).protocol.slice(0, -1),
          host: new URL(values.endpoint).host,
        },
        connection: { id: 'connection-live-tangle-sandbox', kind: values.kind },
        credentialConfigured: true,
        profile: { model: { default: values.model }, harness: values.runner },
      }),
      modelProvider: values.modelProvider,
    },
    account: {
      stable: failures.includes('Sandbox account identity changed during the cohort') === false,
      identityDigest: identityDigest(identityBefore),
    },
    usage: { before: publicUsage(before), after: publicUsage(after), delta: usageDelta },
    latencyMs: executionLatencyDistribution(attempts),
    attempts,
  }
}

async function main() {
  const report = await runBraidSandboxExecutionSoak({
    runs: argument('runs'),
    concurrency: argument('concurrency'),
  })
  const output = `${JSON.stringify(report, null, 2)}\n`
  const outputPath = argument('output')
  if (outputPath) {
    const target = resolve(outputPath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, output, { mode: 0o600 })
  }
  process.stdout.write(output)
  if (report.status !== 'passed') process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
