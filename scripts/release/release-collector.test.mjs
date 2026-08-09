import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'

import { writeJsonAtomic } from './atomic-storage.mjs'
import { bindingForCheck, readBuildIdentity, readRequirementIds } from './build-identity.mjs'
import { releaseChildEnvironment } from './child-environment.mjs'
import { structuredChildEvidence } from './collection-contract.mjs'
import { collectReleaseEvidence } from './collector.mjs'
import { executeArgv } from './command-runner.mjs'
import { packageFileManifestFromTarball, sourceDigest } from './package-archive.mjs'
import {
  BoundedCapture,
  collectCredentialSecrets,
  collectRedactionSecrets,
  REDACTION_INPUT_CHUNK_CHARS,
  redactText,
  sanitizeEnvironment,
} from './redaction.mjs'
import { StructuredOutputCapture } from './structured-output.mjs'

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`
}

function tarArchive(entries) {
  const blocks = []
  for (const entry of entries) {
    const header = Buffer.alloc(512)
    header.write(entry.name, 0, 'utf8')
    header.write(octal(0o644, 8), 100, 'ascii')
    header.write(octal(0, 8), 108, 'ascii')
    header.write(octal(0, 8), 116, 'ascii')
    header.write(octal(entry.body?.length ?? 0, 12), 124, 'ascii')
    header.write(octal(0, 12), 136, 'ascii')
    header.fill(0x20, 148, 156)
    header[156] = entry.type === 'directory' ? 0x35 : entry.type === 'symlink' ? 0x32 : 0x30
    header.write('ustar\0', 257, 'ascii')
    header.write('00', 263, 'ascii')
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
    blocks.push(header)
    const body = entry.body ?? Buffer.alloc(0)
    blocks.push(body)
    if (body.length % 512 !== 0) blocks.push(Buffer.alloc(512 - (body.length % 512)))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), 'braid-release-repo-'))
  const artifactRoot = await mkdtemp(join(tmpdir(), 'braid-release-artifacts-'))
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: '@example/braid', version: '1.0.0', dependencies: {} })}\n`,
  )
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  await writeFile(
    join(root, 'docs', 'requirements.md'),
    '## Product acceptance\n\n| PR-01 | local proof |\n',
  )
  git(root, 'init', '-q')
  git(root, 'config', 'core.hooksPath', '/dev/null')
  git(root, 'config', 'user.email', 'release-test@example.invalid')
  git(root, 'config', 'user.name', 'Release Test')
  git(root, 'add', 'package.json', 'pnpm-lock.yaml', 'docs/requirements.md')
  git(root, 'commit', '-qm', 'fixture')
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const packageJsonBytes = Buffer.from(`${JSON.stringify(packageJson)}\n`)
  const tarballPath = join(artifactRoot, 'example-braid-1.0.0.tgz')
  const tarballBytes = tarArchive([
    { name: 'package/', type: 'directory' },
    { name: 'package/package.json', body: packageJsonBytes },
    { name: 'package/index.js', body: Buffer.from('export const ok = true\n') },
  ])
  await writeFile(tarballPath, tarballBytes)
  const manifest = packageFileManifestFromTarball(tarballBytes)
  const proof = {
    tarball: 'example-braid-1.0.0.tgz',
    sha256: createHash('sha256').update(tarballBytes).digest('hex'),
    version: '1.0.0',
    gitCommit: git(root, 'rev-parse', 'HEAD'),
    treeSha256: git(root, 'rev-parse', 'HEAD^{tree}'),
    sourceDigest: await sourceDigest(root),
    isolatedBuild: true,
    sourceCheckout: 'isolated-copy-of-worktree',
    packageFileManifest: manifest,
  }
  return { root, artifactRoot, tarballPath, tarballBytes, proof }
}

async function withRepo(action) {
  const fixture = await makeRepo()
  try {
    return await action(fixture)
  } finally {
    await Promise.all([
      rm(fixture.root, { recursive: true, force: true }),
      rm(fixture.artifactRoot, { recursive: true, force: true }),
    ])
  }
}

function expectReject(action, pattern) {
  assert.throws(action, pattern)
}

async function expectRejectAsync(action, pattern) {
  await assert.rejects(action, pattern)
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return true
}

test('redaction counts raw output without publishing a secret-derived digest', () => {
  const left = new BoundedCapture(32, ['secret-value'])
  const right = new BoundedCapture(32, ['secret-value'])
  left.push(Buffer.from(`${'same prefix '.repeat(20)}A`))
  right.push(Buffer.from(`${'same prefix '.repeat(20)}B`))
  const leftResult = left.finish()
  const rightResult = right.finish()
  assert.equal(Object.hasOwn(leftResult, 'rawSha256'), false)
  assert.equal(Object.hasOwn(rightResult, 'rawSha256'), false)
  assert.equal(leftResult.rawByteLength, rightResult.rawByteLength)
  assert(!leftResult.bytes.toString('utf8').includes('\uFFFD'))
  assert(!rightResult.bytes.toString('utf8').includes('\uFFFD'))

  const utf8 = new BoundedCapture(5)
  utf8.push(Buffer.from('ab🙂z'))
  const utf8Result = utf8.finish()
  assert.equal(utf8Result.bytes.toString('utf8'), 'ab')
  assert.equal(utf8Result.redactedTruncated, true)
})

test('redaction catches chunk splits, truncation-boundary splits, and >1 MiB internal flush splits', () => {
  const secret = 'split-secret-7f3e9d'
  const capture = new BoundedCapture(4_096, [secret])
  for (const chunk of ['prefix split-', 'secret-', '7f3e9d suffix'])
    capture.push(Buffer.from(chunk))
  const chunkResult = capture.finish()
  assert(!chunkResult.bytes.toString('utf8').includes(secret))

  const boundary = new BoundedCapture(12, [secret])
  boundary.push(Buffer.from(`123456789${secret}after`))
  const boundaryResult = boundary.finish()
  assert(!boundaryResult.bytes.toString('utf8').includes(secret))
  assert(!boundaryResult.bytes.toString('utf8').includes('\uFFFD'))
  assert(!boundaryResult.bytes.toString('utf8').includes(secret.slice(0, 8)))
  assert(!boundaryResult.bytes.toString('utf8').includes(secret.slice(-8)))

  const cases = [
    { token: secret, sensitive: secret, secrets: [secret] },
    { token: `TOKEN=${'q'.repeat(400)}`, sensitive: 'q'.repeat(400), secrets: [] },
    { token: `Bearer ${'b'.repeat(400)}`, sensitive: 'b'.repeat(400), secrets: [] },
    {
      token: `https://user:${'p'.repeat(400)}@example.invalid/path`,
      sensitive: 'p'.repeat(400),
      secrets: [],
    },
    {
      token: `https://example.invalid/?token=${'u'.repeat(400)}`,
      sensitive: 'u'.repeat(400),
      secrets: [],
    },
  ]
  for (const { token, sensitive, secrets } of cases) {
    const separator = token.startsWith(secret) ? '' : ' '
    const marker = 'before-sentinel-'
    const splitBoundary = REDACTION_INPUT_CHUNK_CHARS * 16
    const tokenStart = splitBoundary - 4
    const prefix = `${marker}${'x'.repeat(tokenStart - marker.length - separator.length)}`
    const after = ' after-sentinel-tail'
    const bytes = Buffer.from(prefix + separator + token + after)
    assert.equal(bytes.indexOf(token), tokenStart)
    assert(tokenStart < splitBoundary)
    assert(tokenStart + Buffer.byteLength(token) > splitBoundary)
    const large = new BoundedCapture(bytes.length + 128, secrets)
    for (let offset = 0; offset < bytes.length; offset += 7_777)
      large.push(bytes.subarray(offset, offset + 7_777))
    const result = large.finish()
    const retained = result.bytes.toString('utf8')
    assert(!retained.includes(token), `credential leaked: ${token.slice(0, 24)}`)
    assert(retained.includes('before-sentinel'))
    assert(retained.includes('after-sentinel'))
    assert(!retained.includes(sensitive.slice(0, 32)))
    assert(!retained.includes(sensitive.slice(-32)))
    assert(!retained.includes('\uFFFD'))
  }

  for (const token of [
    `Bearer ${'b'.repeat(3 * 1024 * 1024)}`,
    `TOKEN=${'q'.repeat(3 * 1024 * 1024)}`,
  ]) {
    const bytes = Buffer.from(`before-unterminated-${token}\n-after-unterminated`)
    const failClosed = new BoundedCapture(bytes.length + 128)
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
      failClosed.push(bytes.subarray(offset, offset + 64 * 1024))
    const result = failClosed.finish()
    const retained = result.bytes.toString('utf8')
    assert.equal(result.redactionFailClosed, true)
    assert(retained.includes('before-unterminated'))
    assert(!retained.includes(token.slice(0, 128)))
    assert(!retained.includes(token.slice(-128)))
    assert(!retained.includes('after-unterminated'))
    assert(result.redactedByteLength < 1024 * 1024)
  }
})

test('environment sanitization unions explicit and innocent-name canaries without stable value fingerprints', () => {
  const environment = {
    AWS_TOKEN: 'obvious-canary-Ω',
    BUILD_LABEL: 'innocent-canary-Δ',
    SERVICE_URL: 'https://user:password@example.invalid/?token=query-canary',
    NODE_ENV: 'test',
  }
  const secrets = collectRedactionSecrets(environment, ['explicit-canary-秘密'])
  assert(secrets.includes('obvious-canary-Ω'))
  assert(secrets.includes('innocent-canary-Δ'))
  assert(secrets.includes('explicit-canary-秘密'))
  const sanitized = sanitizeEnvironment(environment)
  const serialized = JSON.stringify(sanitized)
  for (const canary of [
    'obvious-canary-Ω',
    'innocent-canary-Δ',
    'explicit-canary-秘密',
    'password',
    'query-canary',
  ])
    assert(!serialized.includes(canary))
  assert(!serialized.includes('sha256'))
  assert(!serialized.includes('digest'))
  const text = redactText(
    'https://user:password@example.invalid/?token=query-canary Bearer bearer-canary',
    [...secrets, 'bearer-canary'],
  )
  for (const canary of ['password', 'query-canary', 'bearer-canary']) assert(!text.includes(canary))
})

test('low-entropy control values stay redacted without corrupting structured release markers', async () => {
  const environment = {
    BRAID_LIVE_BRIDGE: '1',
    BRAID_RELEASE_ARTIFACT_ROOT: '/tmp/braid-release-artifacts',
    BRAID_CLI_BRIDGE_BEARER: 'short',
  }
  const secrets = collectRedactionSecrets(environment)
  assert(secrets.includes('1'))
  assert(secrets.includes('short'))
  const output =
    'BRAID_RELEASE_RESULT_JSON={"status":"passed"}\n' +
    'BRAID_RELEASE_MEASUREMENTS_JSON={"measurements":[{"kind":"scalar","name":"LIVE-01","unit":"count","value":1000}]}\n'
  const processResult = await executeArgv({
    file: process.execPath,
    args: ['-e', `process.stdout.write(${JSON.stringify(output)})`],
    cwd: process.cwd(),
    environment: { ...process.env, ...environment },
  })
  assert(processResult.stdout.bytes.toString('utf8').includes('[REDACTED]'))
  const evidence = structuredChildEvidence(
    'live',
    processResult.structuredStdout.bytes,
    1,
    'LIVE-01',
  )
  assert.equal(evidence.result, 'passed')
  assert.equal(evidence.measurements[0]?.name, 'LIVE-01')
  assert.equal(evidence.measurements[0]?.value, 1000)
})

test('structured failure reasons redact credential values before they enter release evidence', () => {
  const credential = 'TOPSECRET_MARKER_VALUE'
  const secrets = collectCredentialSecrets({ BRAID_EVAL_BEARER: credential })
  const output = Buffer.from(
    `BRAID_RELEASE_RESULT_JSON=${JSON.stringify({
      status: 'failed',
      reason: `request failed: ${credential}`,
    })}\n`,
  )
  const evidence = structuredChildEvidence('eval', output, 3, 'EVAL-01', undefined, secrets)
  assert.equal(evidence.result, 'failed')
  assert.doesNotMatch(JSON.stringify(evidence), /TOPSECRET_MARKER_VALUE/u)
  assert.match(evidence.reason ?? '', /\[REDACTED\]/u)
})

test('release children receive only credentials for their exact provider command', () => {
  const environment = {
    PATH: '/bin',
    BRAID_CLI_BRIDGE_BEARER: 'bridge-secret',
    BRAID_CLI_BRIDGE_URL: 'http://127.0.0.1:4010',
    BRAID_EVAL_BEARER: 'eval-secret',
    BRAID_EVAL_BRIDGE_URL: 'http://127.0.0.1:4020',
    BRAID_UPSTREAM_GITHUB_TOKEN: 'upstream-secret',
    GH_TOKEN: 'ambient-secret',
    NODE_OPTIONS: '--require=/tmp/inject.cjs',
  }
  const ordinary = releaseChildEnvironment(environment, 'pnpm check')
  assert.deepEqual(ordinary, { PATH: '/bin' })
  const bridge = releaseChildEnvironment(environment, 'pnpm test:live:bridge:release')
  assert.equal(bridge.BRAID_CLI_BRIDGE_BEARER, 'bridge-secret')
  assert.equal(bridge.BRAID_CLI_BRIDGE_URL, 'http://127.0.0.1:4010')
  assert.equal(bridge.BRAID_EVAL_BEARER, undefined)
  assert.equal(bridge.GH_TOKEN, undefined)
  const evaluation = releaseChildEnvironment(environment, 'pnpm test:eval')
  assert.equal(evaluation.BRAID_EVAL_BEARER, 'eval-secret')
  assert.equal(evaluation.BRAID_CLI_BRIDGE_BEARER, undefined)
})

test('structured release capture handles split markers and rejects oversized marker lines', () => {
  const split = new StructuredOutputCapture()
  split.push('ordinary output\nBRAID_RELEASE_RES')
  split.push('ULT_JSON={"status":"passed"}\n')
  const retained = split.finish()
  assert.equal(retained.error, null)
  assert.equal(retained.bytes.toString(), 'BRAID_RELEASE_RESULT_JSON={"status":"passed"}\n')

  const oversized = new StructuredOutputCapture()
  oversized.push(
    Buffer.concat([Buffer.from('BRAID_RELEASE_RESULT_JSON='), Buffer.alloc(1024 * 1024, 0x61)]),
  )
  assert.match(oversized.finish().error, /oversized/u)
})

test('structured child results require an unambiguous passed marker and one measurement', () => {
  const measurement = JSON.stringify([{ kind: 'scalar', name: 'count', unit: 'count', value: 1 }])
  const passed = structuredChildEvidence(
    'live',
    Buffer.from(
      `BRAID_RELEASE_RESULT_JSON={"status":"passed"}\nBRAID_RELEASE_MEASUREMENTS_JSON=${measurement}\n`,
    ),
    3,
  )
  assert.equal(passed.result, 'passed')
  const exactMeasurements = JSON.stringify([
    { kind: 'scalar', name: 'LIVE-01', unit: 'count', value: 1 },
    { kind: 'scalar', name: 'LIVE-02', unit: 'count', value: 1 },
  ])
  const exactOutput = Buffer.from(
    `BRAID_RELEASE_RESULT_JSON={"status":"passed"}\nBRAID_RELEASE_MEASUREMENTS_JSON=${exactMeasurements}\n`,
  )
  const exact = structuredChildEvidence('live', exactOutput, 3, 'LIVE-02')
  assert.equal(exact.result, 'passed')
  assert.deepEqual(
    exact.measurements.map(({ name }) => name),
    ['LIVE-02'],
  )
  assert.notEqual(structuredChildEvidence('live', exactOutput, 3, 'LIVE-03').result, 'passed')
  assert.notEqual(structuredChildEvidence('live', exactOutput, 3, 'UP-08').result, 'passed')
  assert.notEqual(
    structuredChildEvidence('contract', Buffer.from('contract passed\n'), 3, 'UP-01').result,
    'passed',
  )
  for (const output of [
    `BRAID_RELEASE_MEASUREMENTS_JSON=${measurement}\n`,
    `BRAID_RELEASE_RESULT_JSON={"status":"failed","reason":"no"}\nBRAID_RELEASE_MEASUREMENTS_JSON=${measurement}\n`,
    `BRAID_RELEASE_RESULT_JSON={"status":"mystery"}\nBRAID_RELEASE_MEASUREMENTS_JSON=${measurement}\n`,
    `BRAID_RELEASE_RESULT_JSON={"status":"passed"}\nBRAID_RELEASE_RESULT_JSON={"status":"passed"}\nBRAID_RELEASE_MEASUREMENTS_JSON=${measurement}\n`,
    `BRAID_RELEASE_RESULT_JSON={"status":"passed"}\nBRAID_RELEASE_MEASUREMENTS_JSON=${measurement}\nBRAID_RELEASE_MEASUREMENTS_JSON=${measurement}\n`,
  ]) {
    assert.notEqual(structuredChildEvidence('live', Buffer.from(output), 3).result, 'passed')
  }
  assert.equal(
    structuredChildEvidence(
      'unit',
      Buffer.from('BRAID_RELEASE_RESULT_JSON={"status":"failed"}\n'),
      3,
    ).result,
    'failed',
  )

  const exactResult = 'BRAID_RELEASE_RESULT_JSON={"status":"passed"}\n'
  const exactEvidence = (name, unit, value) =>
    Buffer.from(
      `${exactResult}BRAID_RELEASE_MEASUREMENTS_JSON=${JSON.stringify([
        { kind: 'scalar', name, unit, value },
      ])}\n`,
    )
  assert.equal(
    structuredChildEvidence('release', exactEvidence('VR-03', 'seeds', 100_000), 3, 'VR-03').result,
    'passed',
  )
  assert.notEqual(
    structuredChildEvidence('release', exactEvidence('VR-03', 'seeds', 99_999), 3, 'VR-03').result,
    'passed',
  )
  assert.equal(
    structuredChildEvidence(
      'contract',
      exactEvidence('UP-01', 'upstream-attestations', 1),
      3,
      'UP-01',
    ).result,
    'passed',
  )
  assert.notEqual(
    structuredChildEvidence('contract', exactEvidence('UP-01', 'count', 1), 3, 'UP-01').result,
    'passed',
  )
})

test('command execution settles spawn, nonzero, signal, timeout, and parent-exit cleanup paths', async () => {
  const environment = { PATH: process.env.PATH ?? '', NODE_ENV: 'test' }
  const success = await executeArgv({
    file: process.execPath,
    args: ['-e', 'process.stdout.write("ok")'],
    cwd: process.cwd(),
    environment,
  })
  assert.equal(success.exitCode, 0)
  assert.equal(success.cleanupConfirmed, true)
  assert.equal(success.stdout.bytes.toString(), 'ok')

  const nonzero = await executeArgv({
    file: process.execPath,
    args: ['-e', 'process.stderr.write("bad"); process.exit(7)'],
    cwd: process.cwd(),
    environment,
  })
  assert.equal(nonzero.exitCode, 7)

  const signal = await executeArgv({
    file: process.execPath,
    args: ['-e', 'process.kill(process.pid, "SIGTERM")'],
    cwd: process.cwd(),
    environment,
  })
  assert.equal(signal.signal, 'SIGTERM')

  const timedOut = await executeArgv({
    file: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: process.cwd(),
    environment,
    timeoutMs: 30,
    settlementGraceMs: 300,
  })
  assert.equal(timedOut.timedOut, true)
  assert.equal(timedOut.cleanupConfirmed, true)

  const pidFile = join(await mkdtemp(join(tmpdir(), 'braid-child-cleanup-')), 'grandchild.pid')
  const parentCode = [
    "const { spawn } = require('node:child_process')",
    "const { writeFileSync } = require('node:fs')",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
    'child.unref()',
    'writeFileSync(process.argv[1], String(child.pid))',
  ].join(';')
  const parentExit = await executeArgv({
    file: process.execPath,
    args: ['-e', parentCode, pidFile],
    cwd: process.cwd(),
    environment,
  })
  assert.equal(parentExit.exitCode, 0)
  assert.equal(parentExit.cleanupConfirmed, true)
  const grandchildPid = Number.parseInt(await readFile(pidFile, 'utf8'), 10)
  assert(Number.isInteger(grandchildPid) && grandchildPid > 0)
  const cleaned = await waitFor(() => !alive(grandchildPid))
  if (!cleaned && alive(grandchildPid)) process.kill(grandchildPid, 'SIGKILL')
  assert.equal(cleaned, true)

  const noClose = new EventEmitter()
  noClose.pid = 0
  noClose.stdout = new PassThrough()
  noClose.stderr = new PassThrough()
  const bounded = await executeArgv({
    file: 'fixture',
    args: [],
    cwd: process.cwd(),
    environment,
    timeoutMs: 10,
    settlementGraceMs: 40,
    spawnProcess: () => noClose,
  })
  assert.equal(bounded.settlementTimedOut, true)
  assert.equal(bounded.cleanupConfirmed, false)

  const spawnFailure = await executeArgv({
    file: 'not-found',
    args: [],
    cwd: process.cwd(),
    environment: { ...environment, PRIVATE_TOKEN: 'spawn-secret' },
    spawnProcess: () => {
      throw new Error('cannot spawn spawn-secret')
    },
  })
  assert.equal(spawnFailure.cleanupConfirmed, true)
  assert(!spawnFailure.spawnError.includes('spawn-secret'))
})

test('archive identity rejects duplicate, unsafe, and symlink tar entries', () => {
  const packageJson = Buffer.from('{"name":"x"}\n')
  const valid = tarArchive([{ name: 'package/package.json', body: packageJson }])
  assert.equal(packageFileManifestFromTarball(valid).entries.length, 1)
  expectReject(
    () =>
      packageFileManifestFromTarball(
        tarArchive([
          { name: 'package/x', body: Buffer.from('1') },
          { name: 'package/x', body: Buffer.from('2') },
        ]),
      ),
    /duplicate/iu,
  )
  expectReject(
    () =>
      packageFileManifestFromTarball(
        tarArchive([{ name: 'package/../x', body: Buffer.from('1') }]),
      ),
    /unsafe|outside/iu,
  )
  expectReject(
    () => packageFileManifestFromTarball(tarArchive([{ name: 'package/link', type: 'symlink' }])),
    /unsafe/iu,
  )
})

test('requirements and bindings reject duplicate definitions before canonicalization', async () => {
  await withRepo(async ({ root }) => {
    await writeFile(
      join(root, 'docs', 'duplicate.md'),
      '## Product acceptance\n\n| PR-01 | second definition |\n',
    )
    await expectRejectAsync(
      () => readRequirementIds(root),
      /Duplicate requirement definitions.*PR-01/iu,
    )
  })
  expectReject(
    () =>
      bindingForCheck(
        {
          requirementIds: ['PR-01'],
          tarballSha256: 'a'.repeat(64),
          gitCommit: 'b'.repeat(40),
          gitTree: { algorithm: 'git-tree-object-sha1', value: 'c'.repeat(40) },
          dependencyDigest: 'd'.repeat(64),
          packageFileManifestDigest: 'e'.repeat(64),
          dependencies: [],
        },
        ['PR-01', 'PR-01'],
      ),
    /duplicated/iu,
  )
})

test('build identity binds clean HEAD, explicit Git-tree algorithm, tarball digest, and package manifest', async () => {
  await withRepo(async ({ root, artifactRoot, tarballPath, proof }) => {
    const identity = await readBuildIdentity({
      repository: root,
      artifactRoot,
      tarballPath,
      packageProof: proof,
    })
    assert.deepEqual(identity.gitTree, {
      algorithm: 'git-tree-object-sha1',
      value: identity.treeSha256,
    })
    assert.equal(identity.packageFileManifestDigest, proof.packageFileManifest.digest)
    await writeFile(
      join(root, 'docs', 'requirements.md'),
      '## Product acceptance\n\n| PR-01 | modified |\n',
    )
    await expectRejectAsync(
      () => readBuildIdentity({ repository: root, artifactRoot, tarballPath, packageProof: proof }),
      /Source tree is not clean/iu,
    )
  })
  await withRepo(async ({ root, artifactRoot, tarballPath, tarballBytes, proof }) => {
    await writeFile(tarballPath, Buffer.concat([tarballBytes, Buffer.from('changed')]))
    await expectRejectAsync(
      () => readBuildIdentity({ repository: root, artifactRoot, tarballPath, packageProof: proof }),
      /tarball digest differs/iu,
    )
  })
})

test('atomic interruption leaves no partial file and permits a clean retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-atomic-'))
  try {
    const path = join(root, 'release.json')
    await expectRejectAsync(
      () =>
        writeJsonAtomic(
          path,
          { value: 'interrupted' },
          {
            beforeRename: () => {
              throw new Error('interrupt')
            },
          },
        ),
      /interrupt/u,
    )
    assert.equal(await readFile(path).catch(() => undefined), undefined)
    assert.deepEqual(await readdir(root), [])
    await writeJsonAtomic(path, { value: 'recovered' })
    assert.equal(JSON.parse(await readFile(path, 'utf8')).value, 'recovered')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('one local catalog check produces redacted artifacts and an immutable collection manifest', async () => {
  await withRepo(async ({ root, artifactRoot, tarballPath, proof }) => {
    const bin = await mkdtemp(join(tmpdir(), 'braid-fake-pnpm-'))
    const pnpmPath = join(bin, 'pnpm')
    await writeFile(
      pnpmPath,
      '#!/usr/bin/env node\nprocess.stdout.write(process.argv.slice(2).join(" "))\n',
    )
    await chmod(pnpmPath, 0o755)
    try {
      const collectionOptions = {
        repository: root,
        artifactRoot,
        tarballPath,
        packageProof: proof,
        requirementBindings: { 'PR-01': { checks: ['repository'] } },
        checkIds: ['repository'],
        environment: {
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          NODE_ENV: 'test',
          INNOCENT_CANARY: 'secret-value',
        },
      }
      const result = await collectReleaseEvidence(collectionOptions)
      assert.equal(result.result, 'passed')
      assert.equal(result.envelope.checks.length, 1)
      assert.equal(result.envelope.checks[0].result, 'passed')
      assert.deepEqual(result.manifest.signatures, [])
      const serialized = JSON.stringify(result)
      assert(!serialized.includes('secret-value'))

      await rm(result.paths.manifest)
      const resumed = await collectReleaseEvidence({
        ...collectionOptions,
        now: () => Date.now() + 60_000,
      })
      assert.equal(resumed.result, 'passed')
      assert.equal(resumed.envelope.finishedAt, result.envelope.finishedAt)
      assert.deepEqual(resumed.manifest, result.manifest)

      const partialPath = result.paths.partial
      const originalPartial = await readFile(partialPath, 'utf8')
      const tamperedRecord = JSON.parse(originalPartial)
      tamperedRecord.envelope.checks[0].binding.gitCommit = '0'.repeat(40)
      await writeFile(partialPath, `${JSON.stringify(tamperedRecord)}\n`)
      await expectRejectAsync(() => collectReleaseEvidence(collectionOptions), /binding|commit/iu)

      const wrongBuild = JSON.parse(originalPartial)
      wrongBuild.build.tarballSha256 = '0'.repeat(64)
      await writeFile(partialPath, `${JSON.stringify(wrongBuild)}\n`)
      await expectRejectAsync(
        () => collectReleaseEvidence(collectionOptions),
        /checkpoint build binding differs/iu,
      )

      await writeFile(partialPath, originalPartial)
      const stdoutArtifact = result.envelope.artifacts.find((artifact) =>
        artifact.id.endsWith('-stdout'),
      )
      assert(stdoutArtifact)
      await writeFile(join(artifactRoot, stdoutArtifact.path), 'tampered')
      await expectRejectAsync(
        () => collectReleaseEvidence(collectionOptions),
        /Artifact .* changed/iu,
      )
    } finally {
      await rm(bin, { recursive: true, force: true })
    }
  })
})

test('a restored failed check is retried with a new recorded attempt', async () => {
  await withRepo(async ({ root, artifactRoot, tarballPath, proof }) => {
    let calls = 0
    const runCheck = async ({ checkId }) => {
      calls += 1
      const processResult = await executeArgv({
        file: process.execPath,
        args: ['-e', calls === 1 ? 'process.exit(7)' : 'process.stdout.write("passed")'],
        cwd: root,
        environment: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' },
      })
      return {
        checkId,
        category: 'release',
        command: 'pnpm check',
        argv: ['pnpm', 'check'],
        ...processResult,
      }
    }
    const options = {
      repository: root,
      artifactRoot,
      tarballPath,
      packageProof: proof,
      requirementBindings: { 'PR-01': { checks: ['repository'] } },
      checkIds: ['repository'],
      environment: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' },
      runCheck,
    }
    const failed = await collectReleaseEvidence(options)
    assert.equal(failed.result, 'failed')
    assert.equal(failed.envelope.checks[0]?.attempt, 1)

    const retried = await collectReleaseEvidence(options)
    assert.equal(retried.result, 'passed')
    assert.equal(retried.envelope.checks[0]?.attempt, 2)
    assert.equal(calls, 2)
    assert.deepEqual(retried.manifest.signatures, [])
  })
})
