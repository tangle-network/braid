import { execFile as execFileCallback } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  REQUIRED_PERFORMANCE_IDS,
  REQUIRED_PERFORMANCE_TARGETS,
  validatePerformanceMatrix,
} from '../release-evidence.mjs'
import { createPerformanceMeasurement, releaseMeasurement } from './statistics.mjs'

const execFile = promisify(execFileCallback)

export const repository = new URL('../../', import.meta.url).pathname.replace(/\/$/u, '')
export const outputDirectory = process.env.BRAID_PERFORMANCE_OUTPUT_DIR
  ? resolve(process.env.BRAID_PERFORMANCE_OUTPUT_DIR)
  : join(repository, 'artifacts', 'verification', 'performance')
export const rawReportPath = join(outputDirectory, 'raw.json')
export const smokeReportPath = join(outputDirectory, 'smoke.json')
export const releaseReportPath = join(outputDirectory, 'release-measurements.json')
export const command = process.env.BRAID_PERFORMANCE_COMMAND ?? 'pnpm run test:performance'
export const FULL_REPETITIONS = 20
export const processTerminal =
  'node-pty@1.1.0 + @xterm/headless@6.0.0 + @earendil-works/pi-tui@0.84.1'
export const virtualTerminal = '@xterm/headless@6.0.0 + @earendil-works/pi-tui@0.84.1'
const packedProductionTuiChild = new URL('./packed-production-tui-child.mjs', import.meta.url)

export function errorReason(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

export async function gitRevision() {
  try {
    const result = await execFile('git', ['rev-parse', 'HEAD'], { cwd: repository })
    return result.stdout.trim()
  } catch (error) {
    return `unavailable: ${errorReason(error)}`
  }
}

export async function packageVersions() {
  try {
    const value = JSON.parse(await readFile(`${repository}/package.json`, 'utf8'))
    return Object.freeze({
      braid: value.version,
      piTui: value.dependencies?.['@earendil-works/pi-tui'],
      nodePty: value.devDependencies?.['node-pty'],
      xtermHeadless: value.devDependencies?.['@xterm/headless'],
      sqlite: value.dependencies?.['better-sqlite3-multiple-ciphers'],
    })
  } catch (error) {
    return Object.freeze({ error: errorReason(error) })
  }
}

export function hardwareDescription() {
  const cpu = os.cpus()[0]
  return `${os.hostname()} (${cpu?.model ?? 'unknown CPU'}; ${os.arch()}; ${os.cpus().length} logical CPUs)`
}

export function environment({ dimensions, database, eventCount, terminal = processTerminal }) {
  return Object.freeze({
    machine: hardwareDescription(),
    os: `${process.platform} ${os.release()}`,
    node: process.version,
    terminal,
    dimensions,
    database,
    eventCount,
  })
}

export function packedOptions(packed, fixture, extra = {}) {
  const { environment: extraEnvironment, ...remaining } = extra
  if (fixture?.processMode === 'isolated-production-pty') {
    return {
      binary: packedProductionTuiChild.pathname,
      cwd: repository,
      args: [
        fixture.path,
        fixture.root,
        fixture.keyPath,
        fixture.credentialRoot,
        fixture.packageRoot,
      ],
      environment: {
        BRAID_PERFORMANCE_PROCESS_MODE: 'isolated-production-pty',
        ...extraEnvironment,
      },
      ...remaining,
    }
  }
  return {
    binary: packed.binary,
    cwd: repository,
    ...(fixture === undefined
      ? {}
      : {
          args: ['--workspace', fixture.root, '--config', fixture.configPath, '--no-color'],
          environment: { BRAID_STATE_PATH: fixture.path, ...extraEnvironment },
        }),
    ...(fixture === undefined && extraEnvironment !== undefined
      ? { environment: extraEnvironment }
      : {}),
    ...remaining,
  }
}

export function fixtureOptions(packed, extra = {}) {
  return {
    binary: packed.binary,
    cwd: repository,
    args: ['--fixture', 'deterministic', '--no-color'],
    environment: {
      BRAID_FIXTURE_CHUNK_DELAY_MS: String(extra.chunkDelayMs ?? 10),
      ...(extra.environment ?? {}),
    },
    ...(extra.signal === undefined ? {} : { signal: extra.signal }),
  }
}

export function probeCommand(name, mode = 'full') {
  return `${command} [${name}; ${mode}]`
}

export function mergePackedProvenance(input, context) {
  return {
    ...(input.provenance ?? {}),
    packedPackageRoot: context.packageRoot,
    packedTarballSha256: context.tarballSha256,
  }
}

export function pushUnavailable(measurements, name, reason) {
  const entry = { kind: 'unavailable', name, reason: errorReason(reason) }
  measurements.push(entry)
  return null
}

export async function capture(measurements, name, build, context) {
  try {
    context.throwIfAborted()
    const input = await build()
    context.throwIfAborted()
    const measurement = createPerformanceMeasurement({
      ...input,
      name,
      command: probeCommand(name, context.mode),
      provenance: mergePackedProvenance(input, context),
      allowSingleSample: context.mode === 'smoke',
    })
    measurements.push(measurement)
    return measurement
  } catch (error) {
    if (context.signal.aborted) throw error
    return pushUnavailable(measurements, name, error)
  }
}

export function expectedPerformanceNames(measurements) {
  const expected = new Set(REQUIRED_PERFORMANCE_IDS)
  for (const measurement of measurements) expected.delete(measurement.name)
  return [...expected]
}

export function assertSmokeMeasurements(measurements, expectedNames = REQUIRED_PERFORMANCE_IDS) {
  const expected = new Set(expectedNames)
  for (const measurement of measurements) expected.delete(measurement.name)
  if (expected.size > 0) throw new Error(`Smoke missed rows: ${[...expected].join(', ')}`)
  for (const measurement of measurements) {
    if (measurement.kind !== 'distribution')
      throw new Error(`${measurement.name} was ${measurement.kind}, not measured`)
    if (!(measurement.n >= 1)) throw new Error(`${measurement.name} has no smoke samples`)
    if (!Array.isArray(measurement.rawSamples) || measurement.rawSamples.length === 0)
      throw new Error(`${measurement.name} has no raw smoke samples`)
    const failureReasons = Array.isArray(measurement.failureReasons)
      ? measurement.failureReasons.filter(
          (reason) => typeof reason === 'string' && reason.trim().length > 0,
        )
      : []
    if (measurement.passed !== true) {
      if (failureReasons.length === 0)
        throw new Error(`${measurement.name} failed without a concrete failure reason`)
      throw new Error(`${measurement.name} failed its smoke target: ${failureReasons.join('; ')}`)
    }
    if (failureReasons.length > 0)
      throw new Error(
        `${measurement.name} passed with failure reasons: ${failureReasons.join('; ')}`,
      )
  }
  return measurements
}

export async function writeReports(measurements, report, mode) {
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
  await chmod(outputDirectory, 0o700)
  const complete =
    measurements.length === REQUIRED_PERFORMANCE_IDS.length &&
    measurements.every(
      (measurement) => measurement.kind === 'distribution' && measurement.passed === true,
    )
  const releaseMeasurements = measurements
    .filter((measurement) => measurement.kind === 'distribution')
    .map(releaseMeasurement)
  let releaseValidation = { passed: false, reason: 'smoke report has no release validation' }
  if (mode === 'full') {
    try {
      validatePerformanceMatrix(releaseMeasurements, 'performance release projection')
      releaseValidation = { passed: true }
    } catch (error) {
      releaseValidation = { passed: false, reason: errorReason(error) }
    }
  }
  const raw = {
    schemaVersion: 1,
    kind: 'braid-performance-proof',
    mode,
    status: complete && (mode === 'smoke' || releaseValidation.passed) ? 'passed' : 'failed',
    generatedAt: new Date().toISOString(),
    command,
    thresholds: REQUIRED_PERFORMANCE_TARGETS,
    releaseValidation,
    ...report,
    measurements,
    releaseMeasurements,
  }
  const targetPath = mode === 'smoke' ? smokeReportPath : rawReportPath
  await writeFile(targetPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 })
  if (mode === 'full') {
    await writeFile(
      releaseReportPath,
      `${JSON.stringify({ schemaVersion: 1, measurements: releaseMeasurements }, null, 2)}\n`,
      { mode: 0o600 },
    )
  }
  return { complete, releaseMeasurements, releaseValidation, path: targetPath }
}
