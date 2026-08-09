import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { npmExecutable, portableEvidencePath } from './platform.mjs'

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
    child.once('error', reject)
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0 && signal === null) resolvePromise({ stdout, stderr })
      else
        reject(
          new Error(
            `${file} exited with code ${String(code)} and signal ${String(signal)}\n${stdout}\n${stderr}`,
          ),
        )
    })
    if (options.stdin !== undefined) child.stdin.end(options.stdin)
    else child.stdin.end()
    timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 120_000)
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
    await run(npmExecutable(), ['pack', registrySpec, '--pack-destination', packRoot], {
      cwd: smokeRoot,
    })
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
  await run(
    npmExecutable(),
    [
      'install',
      '--prefix',
      installRoot,
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      tarballPath,
    ],
    { cwd: smokeRoot },
  )
  const packageRoot = join(installRoot, 'node_modules', '@tangle-network', 'braid')
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assert(packageJson.version === proof.version, 'Installed package version differs')
  const binary = join(packageRoot, 'dist', 'bin', 'braid.js')
  const version = await run(process.execPath, [binary, '--version'], { cwd: smokeRoot })
  assert(version.stdout.trim() === proof.version, 'Installed binary version differs')

  const plain = await run(process.execPath, [binary, '--fixture', 'deterministic', '--plain'], {
    cwd: smokeRoot,
    stdin: 'platform package smoke\n/quit\n',
    timeoutMs: 30_000,
  })
  assert(
    plain.stdout.includes('Fixture response through pi: platform package smoke'),
    'Installed plain flow did not complete',
  )

  const braid = await import(pathToFileURL(join(packageRoot, 'dist', 'index.js')).href)
  const storageRoot = join(smokeRoot, 'storage')
  await mkdir(storageRoot)
  const credentials = new braid.MemoryCredentialStore()
  const storage = await braid.openSqliteStorage({
    path: join(storageRoot, 'braid.sqlite'),
    workspaceRoot: storageRoot,
    credentialStore: credentials,
    databaseKeyRef: braid.credentialRef('cred:v1:platform-smoke'),
  })
  try {
    const event = {
      workspaceId: braid.createWorkspaceId('workspace-platform-smoke'),
      conversationId: braid.createConversationId('conversation-platform-smoke'),
      runId: braid.createRunId('run-platform-smoke'),
      eventId: braid.createEventId('event-platform-smoke'),
      sequence: 1,
      kind: 'run.finished',
      payload: { platform: process.platform },
      occurredAt: '2026-08-09T00:00:00.000Z',
      terminal: true,
    }
    await storage.append([event])
    assert((await storage.replay({ runId: event.runId })).events.length === 1, 'Replay failed')
    assert((await storage.integrity()).ok === true, 'Encrypted storage integrity failed')
  } finally {
    await storage.close()
  }

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
