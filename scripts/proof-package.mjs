import { execFile } from 'node:child_process'
import { lstat, mkdir, readFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { pnpmInvocation } from './release/platform.mjs'

const run = promisify(execFile)
const repository = new URL('../', import.meta.url).pathname.replace(/\/$/u, '')
const workPackage = process.argv[2]
const captureScript = {
  w0: 'scripts/capture-w0.mjs',
  w6: 'scripts/capture-visual.mjs',
}[workPackage]

if (!captureScript) throw new Error('proof-package requires w0 or w6')

const packageJson = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'))
const archiveName = `${packageJson.name.replace(/^@/u, '').replaceAll('/', '-')}-${packageJson.version}.tgz`
const artifactRoot = process.env.BRAID_RELEASE_ARTIFACT_ROOT
  ? resolve(process.env.BRAID_RELEASE_ARTIFACT_ROOT)
  : join(repository, 'artifacts', 'verification')
const outputRoot = join(artifactRoot, workPackage)
const proofPath = join(outputRoot, 'package-proof.json')
const archivePath = join(outputRoot, archiveName)

await mkdir(outputRoot, { recursive: true })
const priorArchive = await lstat(archivePath).catch(() => undefined)
if (priorArchive?.isSymbolicLink() || (priorArchive && !priorArchive.isFile()))
  throw new Error(`refusing to replace non-file package archive: ${archivePath}`)
if (priorArchive) await unlink(archivePath)

const pnpm = pnpmInvocation(['run', 'build'])
await run(pnpm.file, pnpm.args, { cwd: repository, stdio: 'inherit' })
await run(
  process.execPath,
  [
    join(repository, 'scripts', 'verify-package.mjs'),
    '--record',
    proofPath,
    '--tarball-output',
    archivePath,
  ],
  { cwd: repository, stdio: 'inherit' },
)
await run(process.execPath, [join(repository, captureScript)], {
  cwd: repository,
  env: { ...process.env, BRAID_RELEASE_TARBALL: archivePath },
  stdio: 'inherit',
})
