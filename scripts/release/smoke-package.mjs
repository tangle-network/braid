import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { npmInvocation, portableEvidencePath } from './platform.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function option(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

async function run(file, args, options = {}) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timer
    let timedOut = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.length > 2 * 1024 * 1024) child.kill('SIGKILL')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > 2 * 1024 * 1024) child.kill('SIGKILL')
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0 && signal === null) resolvePromise({ stdout, stderr })
      else
        reject(
          new Error(
            `${options.label ?? file}${timedOut ? ` timed out after ${String(options.timeoutMs ?? 120_000)} ms` : ` exited with code ${String(code)} and signal ${String(signal)}`}\n${stdout}\n${stderr}`,
          ),
        )
    })
    if (options.stdin !== undefined) child.stdin.end(options.stdin)
    else child.stdin.end()
    timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs ?? 120_000)
  })
}

async function runPlainFlow(binary, cwd) {
  const expected = 'Fixture response through pi: platform package smoke'
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [binary, '--fixture', 'deterministic', '--plain'], {
      cwd,
      env: process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let quitSent = false
    let outputExceeded = false
    let inputError
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.length > 2 * 1024 * 1024) {
        outputExceeded = true
        child.kill('SIGKILL')
        return
      }
      if (!quitSent && stdout.includes(expected)) {
        quitSent = true
        child.stdin.end('/quit\n')
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > 2 * 1024 * 1024) {
        outputExceeded = true
        child.kill('SIGKILL')
      }
    })
    child.stdin.on('error', (error) => {
      inputError = error
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (
        code === 0 &&
        signal === null &&
        quitSent &&
        !outputExceeded &&
        inputError === undefined
      ) {
        resolvePromise({ stdout, stderr })
        return
      }
      reject(
        new Error(
          `Installed plain flow exited with code ${String(code)} and signal ${String(signal)}${inputError === undefined ? '' : ` after input error ${String(inputError)}`}\n${stdout}\n${stderr}`,
        ),
      )
    })
    child.stdin.write('platform package smoke\n')
  })
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

const artifactRootValue = option('--artifact-root') ?? process.env.BRAID_RELEASE_ARTIFACT_ROOT
const registrySpec = option('--registry') ?? process.env.BRAID_RELEASE_REGISTRY_SPEC
const outputPathValue = option('--output') ?? process.env.BRAID_SMOKE_OUTPUT
const expectedPlatform = option('--expect-platform') ?? process.env.BRAID_EXPECT_PLATFORM
const expectedArchitecture =
  option('--expect-architecture') ?? process.env.BRAID_EXPECT_ARCHITECTURE
assert(artifactRootValue, '--artifact-root is required')
const artifactRoot = resolve(artifactRootValue)
const proof = JSON.parse(await readFile(join(artifactRoot, 'w6', 'package-proof.json'), 'utf8'))
const smokeRoot = await mkdtemp(join(tmpdir(), 'braid-platform-smoke-'))
let smokeResult

try {
  let tarballPath
  if (registrySpec) {
    const packRoot = join(smokeRoot, 'registry')
    await mkdir(packRoot)
    const npm = npmInvocation(['pack', registrySpec, '--pack-destination', packRoot])
    await run(npm.file, npm.args, { cwd: smokeRoot })
    const archives = (await readdir(packRoot)).filter((name) => name.endsWith('.tgz'))
    assert(archives.length === 1, 'Registry download did not produce exactly one tarball')
    tarballPath = join(packRoot, archives[0])
  } else tarballPath = join(artifactRoot, 'candidate', proof.tarball)

  assert(
    (await sha256(tarballPath)) === proof.sha256,
    'Smoke tarball differs from approved candidate',
  )
  const installRoot = join(smokeRoot, 'install')
  await writeFile(
    join(smokeRoot, 'package.json'),
    `${JSON.stringify({ name: 'braid-platform-smoke', private: true })}\n`,
  )
  const npm = npmInvocation([
    'install',
    '--prefix',
    installRoot,
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    tarballPath,
  ])
  await run(npm.file, npm.args, {
    cwd: smokeRoot,
    label: 'Package installation',
    timeoutMs: 10 * 60_000,
  })
  const packageRoot = join(installRoot, 'node_modules', '@tangle-network', 'braid')
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assert(packageJson.version === proof.version, 'Installed package version differs')
  const binary = join(packageRoot, 'dist', 'bin', 'braid.js')
  const version = await run(process.execPath, [binary, '--version'], { cwd: smokeRoot })
  assert(version.stdout.trim() === proof.version, 'Installed binary version differs')

  const plain = await runPlainFlow(binary, smokeRoot)
  assert(
    plain.stdout.includes('Fixture response through pi: platform package smoke'),
    'Installed plain flow did not complete',
  )

  const storageRoot = join(smokeRoot, 'storage')
  await mkdir(storageRoot)
  const storageProcess = await run(
    process.execPath,
    [
      fileURLToPath(new URL('./storage-smoke-child.mjs', import.meta.url)),
      packageRoot,
      storageRoot,
    ],
    { cwd: smokeRoot },
  )
  const storageResult = JSON.parse(storageProcess.stdout)
  assert(storageResult.encryptedStorage === true, 'Encrypted storage smoke failed')

  smokeResult = {
    schema: 'braid.package-smoke.v1',
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    package: `${packageJson.name}@${packageJson.version}`,
    tarball: basename(tarballPath),
    tarballSha256: proof.sha256,
    source: registrySpec ? 'registry' : 'candidate',
    installationRoot: `<temporary>/${portableEvidencePath(relative(smokeRoot, dirname(packageRoot)))}`,
    plainFlow: true,
    encryptedStorage: true,
  }
} finally {
  await rm(smokeRoot, { recursive: true, force: true })
}

assert(!(await stat(smokeRoot).catch(() => undefined)), 'Temporary smoke state was not removed')
assert(smokeResult, 'Package smoke did not produce a result')
assert(
  !expectedPlatform || smokeResult.platform === expectedPlatform,
  `Expected platform ${expectedPlatform}, received ${smokeResult.platform}`,
)
assert(
  !expectedArchitecture || smokeResult.architecture === expectedArchitecture,
  `Expected architecture ${expectedArchitecture}, received ${smokeResult.architecture}`,
)
const completedResult = {
  ...smokeResult,
  temporaryStateRemoved: true,
  completedAt: new Date().toISOString(),
}
const output = `${JSON.stringify(completedResult)}\n`
if (outputPathValue) {
  const outputPath = resolve(outputPathValue)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, output, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
}
process.stdout.write(output)
