import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureProvenance, writeCastGif, writeRaster } from './capture-visual-support.mjs'

/** Each set runs one test file that writes a final frame and recording per flow and size. */
const SETS = {
  'interaction-close': {
    test: 'interaction-provider-close.test.js',
    env: 'BRAID_INTERACTION_CAPTURE_ROOT',
    execution: 'controlled provider in test/interaction-provider-close.test.ts; not provider proof',
    recording: 'decline-alt-2',
    flows: {
      'decline-alt-2':
        'alt+2 declines an opencode-shaped permission; the provider sends interaction.cancel reason resolved and then completes',
      'storage-failure':
        'the provider closes a request it never made; the reducer refuses it and the status shows the latched storage failure',
    },
  },
  'failure-cause': {
    test: 'run-failure-cause.test.js',
    env: 'BRAID_FAILURE_CAPTURE_ROOT',
    execution: 'controlled provider in test/run-failure-cause.test.ts; not provider proof',
    recording: 'unverified-cause',
    flows: {
      'failed-cause':
        'a run fails with provider text that carries credentials; the transcript says why with the credentials redacted',
      'unverified-cause':
        'the model-seat resolver refuses before any Sandbox exists and recovery refuses too; the transcript says so instead of RUNTIME_RECONCILIATION_ERROR',
    },
  },
  'send-unavailable': {
    test: 'send-context-capability.test.js',
    env: 'BRAID_SEND_CAPTURE_ROOT',
    execution: 'controlled provider in test/send-context-capability.test.ts; not provider proof',
    recording: 'send-unavailable',
    flows: {
      'send-unavailable':
        'after a failed retained Tangle run, Enter shows why Send is unavailable, names /new, keeps the draft, and starts no run',
    },
  },
}

const name = process.argv[2]
const set = SETS[name]
if (set === undefined) throw new Error(`Choose one capture set: ${Object.keys(SETS).join(', ')}`)
const repository = new URL('../', import.meta.url).pathname
const outputRoot = join(repository, 'artifacts', 'verification', name)
const rawRoot = join(outputRoot, 'raw')
const testDist = join(repository, `.test-dist-capture-${name}`)
const sizes = ['40x12', '80x24', '120x40', '200x60']

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: repository,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`)
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

await rm(outputRoot, { recursive: true, force: true })
await rm(testDist, { recursive: true, force: true })
await mkdir(rawRoot, { recursive: true })
run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.test.json', '--outDir', testDist])
run(process.execPath, ['--test', join(testDist, 'test', set.test)], {
  BRAID_TEST_DIST: testDist,
  [set.env]: rawRoot,
})

const artifacts = []
const scratch = await mkdtemp(join(tmpdir(), `braid-${name}-`))
try {
  for (const flow of Object.keys(set.flows)) {
    for (const size of sizes) {
      const [columns, rows] = size.split('x').map(Number)
      const frame = `${size}-${flow}`
      const textPath = join(outputRoot, `${frame}.txt`)
      const pngPath = join(outputRoot, `${frame}.png`)
      await copyFile(join(rawRoot, `${frame}.txt`), textPath)
      await writeRaster(join(rawRoot, `${frame}.cast`), pngPath, join(scratch, `${frame}.gif`))
      artifacts.push({ path: `${frame}.txt`, sha256: await sha256(textPath), columns, rows })
      artifacts.push({ path: `${frame}.png`, sha256: await sha256(pngPath), columns, rows })
    }
  }
  const recording = `80x24-${set.recording}`
  const castPath = join(outputRoot, `${recording}.cast`)
  await copyFile(join(rawRoot, `${recording}.cast`), castPath)
  artifacts.push({
    path: `${recording}.cast`,
    sha256: await sha256(castPath),
    columns: 80,
    rows: 24,
  })
  const gifPath = join(outputRoot, `${recording}-keyboard.gif`)
  await writeCastGif(castPath, gifPath)
  artifacts.push({
    path: `${recording}-keyboard.gif`,
    sha256: await sha256(gifPath),
    columns: 80,
    rows: 24,
  })
} finally {
  await rm(scratch, { recursive: true, force: true })
  await rm(testDist, { recursive: true, force: true })
}

await writeFile(
  join(outputRoot, 'capture-manifest.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      command: `pnpm capture:${name}`,
      execution: set.execution,
      flows: set.flows,
      provenance: await captureProvenance(),
      artifacts,
    },
    null,
    2,
  )}\n`,
)
console.log(`Captured ${name} evidence in ${outputRoot}`)
