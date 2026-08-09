import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { installPackedBraid } from '../packed-binary.mjs'
import { createPerformanceLifecycle } from './lifecycle.mjs'
import { installedPackageRoot } from './packed-runtime.mjs'
import { runProcessMeasurements } from './process-measurements.mjs'
import { assertProcessPrerequisites } from './process-probes.mjs'
import {
  assertSmokeMeasurements,
  capture,
  errorReason,
  expectedPerformanceNames,
  FULL_REPETITIONS,
  gitRevision,
  hardwareDescription,
  packageVersions,
  repository,
  writeReports,
} from './reporting.mjs'
import { runRuntimeMeasurement } from './runtime-measurement.mjs'
import { prepareStorageFixtures, runStorageMeasurements } from './storage-measurements.mjs'
import {
  createHeadlessProductionProcessFixture,
  createProductionProcessFixture,
} from './storage-probes.mjs'

const smokeOnly = process.argv.includes('--smoke-only')
const execFile = promisify(execFileCallback)
const compileCachePrimer = new URL('./compile-cache-primer.mjs', import.meta.url)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function isCredentialUnavailable(error) {
  return /(?:CREDENTIAL_STORE_UNAVAILABLE|operating-system credential facility|credential store)/iu.test(
    errorReason(error),
  )
}

async function createProcessFixture(eventCount, packageRoot) {
  try {
    return await createProductionProcessFixture(eventCount, { packageRoot })
  } catch (error) {
    if (!isCredentialUnavailable(error)) throw error
    return createHeadlessProductionProcessFixture(eventCount, { packageRoot })
  }
}

async function createContext(mode, lifecycle) {
  const context = {
    mode,
    lifecycle,
    signal: lifecycle.signal,
    throwIfAborted: lifecycle.throwIfAborted,
    repetitions: FULL_REPETITIONS,
    repository,
    processPrerequisiteError: undefined,
    packedError: undefined,
  }
  try {
    context.packed = await installPackedBraid(repository)
    lifecycle.throwIfAborted()
    lifecycle.addCleanup(context.packed.cleanup)
    const sqlitePackage = join(
      context.packed.installRoot,
      'node_modules',
      'better-sqlite3-multiple-ciphers',
    )
    await execFile('npm', ['run', 'install', '--prefix', sqlitePackage], {
      cwd: context.packed.installRoot,
    })
    lifecycle.throwIfAborted()
    context.nativeDependencyPreparation =
      'native prebuild install for better-sqlite3-multiple-ciphers in extracted install'
    context.packageRoot = installedPackageRoot(context.packed)
    context.tarballSha256 = context.packed.tarballSha256
  } catch (error) {
    if (lifecycle.signal.aborted) throw error
    context.packedError = errorReason(error)
  }
  if (context.packageRoot) {
    try {
      context.repeatCompileCachePath = await mkdtemp(
        join(os.tmpdir(), 'braid-repeat-compile-cache-'),
      )
      lifecycle.addCleanup(() =>
        rm(context.repeatCompileCachePath, { force: true, recursive: true }),
      )
      const primed = await execFile(
        process.execPath,
        [compileCachePrimer.pathname, context.packageRoot, context.repeatCompileCachePath],
        { cwd: repository },
      )
      context.compileCachePreparation = JSON.parse(primed.stdout)
    } catch (error) {
      if (lifecycle.signal.aborted) throw error
      context.compileCacheError = errorReason(error)
    }
  }
  lifecycle.throwIfAborted()
  try {
    assertProcessPrerequisites()
  } catch (error) {
    context.processPrerequisiteError = errorReason(error)
  }
  if (context.packed && !context.processPrerequisiteError) {
    lifecycle.throwIfAborted()
    try {
      context.warmProcessFixture = await createProcessFixture(10_000, context.packageRoot)
      lifecycle.throwIfAborted()
      lifecycle.addCleanup(context.warmProcessFixture.cleanup)
    } catch (error) {
      if (lifecycle.signal.aborted) throw error
      context.processPrerequisiteError = errorReason(error)
    }
    if (!context.processPrerequisiteError) {
      try {
        context.coldProcessFixture = await createProcessFixture(100_000, context.packageRoot)
        lifecycle.throwIfAborted()
        lifecycle.addCleanup(context.coldProcessFixture.cleanup)
      } catch (error) {
        if (lifecycle.signal.aborted) throw error
        context.processPrerequisiteError = errorReason(error)
      }
    }
  }
  return context
}

function provenance(context, revision, packages) {
  return {
    repository,
    revision,
    packages,
    machine: hardwareDescription(),
    os: `${process.platform} ${os.release()}`,
    node: process.version,
    arch: process.arch,
    packedPackageRoot: context.packageRoot ?? null,
    packedTarballSha256: context.tarballSha256 ?? null,
    compileCache: context.compileCachePreparation ?? {
      status: 'unavailable',
      reason: context.compileCacheError ?? 'packed candidate unavailable',
    },
    referenceDimensions: '40x12,80x24,120x40,200x60',
    seed: 'fixed 2026-08-03T00:00:00.000Z; receipt-backed complete run; batch size 1000',
    externalResources: 'none; local packed candidate, Pi terminal, and encrypted SQLite only',
  }
}

async function runRows(context, measurements) {
  const collect = (name, build) => capture(measurements, name, build, context)
  await runProcessMeasurements(context, collect)
  await runRuntimeMeasurement(context, collect)
  const fixtures = await prepareStorageFixtures(context)
  await runStorageMeasurements(context, collect, fixtures)
  const missing = expectedPerformanceNames(measurements)
  for (const name of missing)
    measurements.push({
      kind: 'unavailable',
      name,
      reason: 'Runner did not capture this requirement',
    })
  measurements.sort((left, right) => left.name.localeCompare(right.name))
}

async function run() {
  const lifecycle = createPerformanceLifecycle()
  let interrupted = false
  const onSignal = (signal) => {
    interrupted = true
    lifecycle.abort(signal)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    const mode = 'smoke'
    const context = await createContext(mode, lifecycle)
    const smokeMeasurements = []
    await runRows(context, smokeMeasurements)
    const smokeReport = await writeReports(
      smokeMeasurements,
      {
        provenance: provenance(context, await gitRevision(), await packageVersions()),
        limits: { repetitions: 1, noBillableResources: true, smoke: true },
        failures: smokeMeasurements
          .filter(
            (measurement) =>
              measurement.kind !== 'distribution' || measurement.failureReasons?.length,
          )
          .map((measurement) => ({
            name: measurement.name,
            reason: measurement.reason ?? measurement.failureReasons,
          })),
      },
      'smoke',
    )
    process.stdout.write(`Performance smoke report: ${smokeReport.path}\n`)
    process.stdout.write(
      `${JSON.stringify(
        smokeMeasurements.map((measurement) => ({
          name: measurement.name,
          kind: measurement.kind,
          n: measurement.n ?? null,
          minimum: measurement.minimum ?? null,
          median: measurement.median ?? null,
          p95: measurement.p95 ?? null,
          maximum: measurement.maximum ?? null,
          passed: measurement.passed ?? false,
          reason: measurement.reason ?? measurement.failureReasons ?? null,
        })),
        null,
        2,
      )}\n`,
    )
    assertSmokeMeasurements(smokeMeasurements)
    if (smokeOnly) return

    context.mode = 'full'
    const fullMeasurements = []
    await runRows(context, fullMeasurements)
    const fullReport = await writeReports(
      fullMeasurements,
      {
        provenance: provenance(context, await gitRevision(), await packageVersions()),
        limits: {
          repetitions: FULL_REPETITIONS,
          idleDurationSeconds:
            Number(process.env.BRAID_PERFORMANCE_IDLE_DURATION_MS ?? 60_000) / 1_000,
          idleSettleSeconds: Number(process.env.BRAID_PERFORMANCE_IDLE_SETTLE_MS ?? 2_000) / 1_000,
          noBillableResources: true,
        },
        failures: fullMeasurements
          .filter(
            (measurement) => measurement.kind === 'unavailable' || measurement.passed === false,
          )
          .map((measurement) => ({
            name: measurement.name,
            reason:
              measurement.reason ?? measurement.failureReasons ?? 'target or invariant failed',
          })),
      },
      'full',
    )
    assert(
      fullReport.complete && fullReport.releaseValidation.passed,
      `Performance proof failed; see ${fullReport.path}`,
    )
    process.stdout.write(`Performance proof passed; raw report: ${fullReport.path}\n`)
    process.stdout.write('BRAID_RELEASE_RESULT_JSON={"status":"passed"}\n')
    process.stdout.write(
      `BRAID_RELEASE_MEASUREMENTS_JSON=${JSON.stringify({ measurements: fullReport.releaseMeasurements })}\n`,
    )
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    await lifecycle.close()
    if (interrupted) process.exitCode = 130
  }
}

try {
  await run()
} catch (error) {
  process.stderr.write(`Performance proof failed: ${errorReason(error)}\n`)
  process.exitCode = process.exitCode || 1
}
