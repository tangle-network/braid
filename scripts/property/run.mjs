import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

import { writeJsonAtomic } from '../release/atomic-storage.mjs'

const require = createRequire(import.meta.url)
const repository = resolve(new URL('../../', import.meta.url).pathname)

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function positiveInteger(name, value) {
  if (!/^[1-9][0-9]*$/u.test(String(value ?? ''))) throw new Error(`${name} must be positive`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > 1_000_000)
    throw new Error(`${name} is outside its supported range`)
  return parsed
}

const mode = option('--mode')
if (mode !== 'ci' && mode !== 'soak') throw new Error('--mode must be ci or soak')
const runs = positiveInteger('--runs', option('--runs'))
if (mode === 'ci' && runs < 1_000) throw new Error('CI property runs require at least 1,000 seeds')
if (mode === 'soak' && runs < 100_000)
  throw new Error('Release property runs require at least 100,000 seeds')
const firstSeed = 1
const lastSeed = firstSeed + runs - 1
const startedMilliseconds = Date.now()
const startedAt = new Date(startedMilliseconds).toISOString()

function seedDigest() {
  const hash = createHash('sha256')
  const bytes = Buffer.allocUnsafe(4)
  for (let seed = firstSeed; seed <= lastSeed; seed += 1) {
    bytes.writeUInt32BE(seed)
    hash.update(bytes)
  }
  return hash.digest('hex')
}

function runStage(name, args) {
  const result = spawnSync(process.execPath, args, {
    cwd: repository,
    encoding: 'utf8',
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      BRAID_PROPERTY_FIRST_SEED: String(firstSeed),
      BRAID_PROPERTY_RUNS: String(runs),
    },
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  const failingSeed = String(result.stderr ?? '').match(/Property seed ([0-9]+) failed/u)?.[1]
  return {
    name,
    status: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    failingSeed: failingSeed === undefined ? null : Number(failingSeed),
  }
}

const stages = []
stages.push(runStage('clean', ['scripts/clean-tests.mjs']))
if (stages.at(-1).status === 0) {
  const compiler = join(dirname(require.resolve('typescript')), '..', 'bin', 'tsc')
  stages.push(runStage('compile', [compiler, '-p', 'tsconfig.test.json']))
}
if (stages.at(-1).status === 0)
  stages.push(runStage('properties', ['scripts/run-tests.mjs', '--scope', 'property']))

const failedStage = stages.find(({ status, signal, error }) => status !== 0 || signal || error)
const completedMilliseconds = Date.now()
const evidence = {
  schema: 'braid.property-seeds.v1',
  mode,
  status: failedStage ? 'failed' : 'passed',
  seeds: {
    encoding: 'inclusive-uint32-range',
    first: firstSeed,
    last: lastSeed,
    count: runs,
    sha256: seedDigest(),
  },
  runtime: {
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
  },
  startedAt,
  completedAt: new Date(completedMilliseconds).toISOString(),
  durationMs: completedMilliseconds - startedMilliseconds,
  stages,
}
const artifactRoot = process.env.BRAID_RELEASE_ARTIFACT_ROOT
if (artifactRoot)
  await writeJsonAtomic(join(resolve(artifactRoot), 'property', `${mode}.json`), evidence)

if (failedStage) {
  const reason = `Property ${failedStage.name} stage failed`
  process.stdout.write(
    `BRAID_RELEASE_RESULT_JSON=${JSON.stringify({ status: 'failed', reason })}\n`,
  )
  process.exitCode = 1
} else {
  process.stdout.write('BRAID_RELEASE_RESULT_JSON={"status":"passed"}\n')
  if (mode === 'soak')
    process.stdout.write(
      `BRAID_RELEASE_MEASUREMENTS_JSON=${JSON.stringify({
        measurements: [{ kind: 'scalar', name: 'VR-03', unit: 'seeds', value: runs }],
      })}\n`,
    )
}
