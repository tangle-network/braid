import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function inside(root, target) {
  const path = relative(root, target)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

async function run(file, args, options = {}) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0 && signal === null) resolvePromise()
      else
        reject(new Error(`${file} exited with code ${String(code)} and signal ${String(signal)}`))
    })
  })
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

const repository = resolve(new URL('../../', import.meta.url).pathname)
const artifactRootValue = process.env.BRAID_RELEASE_ARTIFACT_ROOT
assert(artifactRootValue, 'BRAID_RELEASE_ARTIFACT_ROOT is required')
const artifactRoot = resolve(artifactRootValue)
assert(!inside(repository, artifactRoot), 'Release artifacts must be outside the source checkout')

await mkdir(artifactRoot, { recursive: true, mode: 0o700 })
const rootInfo = await lstat(artifactRoot)
assert(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), 'Release artifact root is not real')
assert((await realpath(artifactRoot)) === artifactRoot, 'Release artifact root resolves indirectly')

const statusResult = await new Promise((resolvePromise, reject) => {
  let stdout = ''
  const child = spawn('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: repository,
    shell: false,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.once('error', reject)
  child.once('close', (code) =>
    code === 0 ? resolvePromise(stdout.trim()) : reject(new Error(`git status exited ${code}`)),
  )
})
assert(statusResult === '', `Release source is not clean:\n${statusResult}`)

const packageJson = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'))
const archiveName = `${packageJson.name.replace(/^@/u, '').replace('/', '-')}-${packageJson.version}.tgz`
const candidateRoot = join(artifactRoot, 'candidate')
const tarballPath = join(candidateRoot, archiveName)
const packageProofPath = join(artifactRoot, 'w6', 'package-proof.json')
const existingTarball = await stat(tarballPath).catch(() => undefined)
const existingProof = await stat(packageProofPath).catch(() => undefined)
assert(Boolean(existingTarball) === Boolean(existingProof), 'Restored candidate is incomplete')

if (!existingTarball) {
  await run('pnpm', ['run', 'build'], { cwd: repository })
  await run(
    process.execPath,
    [
      join(repository, 'scripts', 'verify-package.mjs'),
      '--record',
      packageProofPath,
      '--tarball-output',
      tarballPath,
    ],
    { cwd: repository },
  )
}

const packageProof = JSON.parse(await readFile(packageProofPath, 'utf8'))
const head = await new Promise((resolvePromise, reject) => {
  let stdout = ''
  const child = spawn('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    shell: false,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.once('error', reject)
  child.once('close', (code) =>
    code === 0 ? resolvePromise(stdout.trim()) : reject(new Error(`git rev-parse exited ${code}`)),
  )
})
assert(packageProof.version === packageJson.version, 'Package proof version differs')
assert(packageProof.gitCommit === head, 'Restored candidate commit differs')
assert(packageProof.tarball === basename(tarballPath), 'Package proof archive name differs')
assert(packageProof.sha256 === (await sha256(tarballPath)), 'Package proof archive digest differs')
assert(packageProof.packageFileManifest?.entries?.length > 0, 'Package proof has no file manifest')

process.stdout.write(
  `${JSON.stringify(
    {
      version: packageJson.version,
      commit: packageProof.gitCommit,
      tarball: tarballPath,
      tarballSha256: packageProof.sha256,
      packageProof: packageProofPath,
    },
    null,
    2,
  )}\n`,
)
