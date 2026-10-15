import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureProvenance, writeCastGif, writeRaster } from './capture-visual-support.mjs'

const repository = new URL('../', import.meta.url).pathname
const outputRoot = join(repository, 'artifacts', 'verification', 'interaction-close')
const rawRoot = join(outputRoot, 'raw')
const testDist = join(repository, '.test-dist-interaction-close')
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
run(process.execPath, ['--test', join(testDist, 'test', 'interaction-provider-close.test.js')], {
  BRAID_TEST_DIST: testDist,
  BRAID_INTERACTION_CAPTURE_ROOT: rawRoot,
})

const artifacts = []
const scratch = await mkdtemp(join(tmpdir(), 'braid-interaction-close-'))
try {
  for (const flow of ['storage-failure', 'decline-alt-2']) {
    for (const size of sizes) {
      const [columns, rows] = size.split('x').map(Number)
      const name = `${size}-${flow}`
      const textPath = join(outputRoot, `${name}.txt`)
      const pngPath = join(outputRoot, `${name}.png`)
      await copyFile(join(rawRoot, `${name}.txt`), textPath)
      await writeRaster(join(rawRoot, `${name}.cast`), pngPath, join(scratch, `${name}.gif`))
      artifacts.push({ path: `${name}.txt`, sha256: await sha256(textPath), columns, rows })
      artifacts.push({ path: `${name}.png`, sha256: await sha256(pngPath), columns, rows })
    }
  }
  const gifPath = join(outputRoot, '80x24-decline-alt-2-keyboard.gif')
  await writeCastGif(join(rawRoot, '80x24-decline-alt-2.cast'), gifPath)
  artifacts.push({
    path: '80x24-decline-alt-2-keyboard.gif',
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
      command: 'pnpm capture:interaction-close',
      execution:
        'controlled provider in test/interaction-provider-close.test.ts; not provider proof',
      flows: {
        'decline-alt-2':
          'alt+2 declines an opencode-shaped permission; the provider sends interaction.cancel reason resolved and then completes',
        'storage-failure':
          'the provider closes a request it never made; the reducer refuses it and the status shows the latched storage failure',
      },
      provenance: await captureProvenance(),
      artifacts,
    },
    null,
    2,
  )}\n`,
)
console.log(`Captured interaction close evidence in ${outputRoot}`)
