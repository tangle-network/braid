import { createHash } from 'node:crypto'
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path'
import { assertAccessibleTerminalOutput } from './accessibility-output.mjs'
import { runRpc, runSignalTerminal, runTerminal } from './package-proof-flows.mjs'
import {
  baselineEventEnd,
  firstDifference,
  firstTerminalTrace,
  parityEvidence,
} from './package-proof-parity.mjs'
import { runPlain } from './package-proof-plain.mjs'
import {
  cleanEnvironment,
  gitValue,
  installEnvironment,
  repository,
  run,
  runPty,
  sourceDigest,
} from './package-proof-runtime.mjs'
import { packageFileManifestFromTarball } from './release/package-archive.mjs'
import { npmExecutable, pnpmExecutable } from './release/platform.mjs'
import { writeExclusiveAtomic } from './release-files.mjs'
import { assertNoSecretArtifacts } from './scan-secret-artifacts.mjs'

function option(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a path`)
  return value
}

const recordPath = option('--record')
const tarballOutputPath = option('--tarball-output')
const suppliedTarballPath = process.env.BRAID_RELEASE_TARBALL
if (suppliedTarballPath && tarballOutputPath)
  throw new Error('--tarball-output cannot be combined with BRAID_RELEASE_TARBALL')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

assert(
  JSON.stringify(
    parityEvidence({ runs: [], profile: { metadata: { operationId: 'profile-a' } } }, []),
  ) !==
    JSON.stringify(
      parityEvidence({ runs: [], profile: { metadata: { operationId: 'profile-b' } } }, []),
    ),
  'package parity must preserve non-caller operationId fields',
)

function parityFixture(operationId) {
  const admission = {
    version: 1,
    runId: 'run-1',
    turnId: 'turn-1',
    operationId,
    conversationId: 'conversation-1',
    branchId: 'branch-1',
    admittedAt: '2026-08-01T00:00:00.000Z',
    profileDigest: 'profile-digest',
    requested: { text: 'same prompt' },
    capabilities: {},
    admissionStatus: 'admitted',
    requestDigest: `request-${operationId}`,
    capabilitiesDigest: 'capabilities-digest',
    digest: `admission-${operationId}`,
  }
  return [
    { sequence: 1, revision: 1, kind: 'run.requested', payload: { admission } },
    {
      sequence: 2,
      revision: 2,
      kind: 'run.finished',
      payload: { status: 'completed' },
    },
    {
      sequence: 3,
      revision: 3,
      kind: 'effect.upserted',
      payload: {
        value: {
          effect: {
            id: `effect-${operationId}-same`,
            operationId,
            status: 'terminal',
          },
        },
      },
    },
  ]
}

const rpcParityFixture = parityFixture('op-rpc-1')
const terminalParityFixture = parityFixture('op-terminal-1')
assert(baselineEventEnd(rpcParityFixture) === 3, 'package parity omitted a terminal effect')
assert(
  JSON.stringify(parityEvidence({ runs: [] }, rpcParityFixture)) ===
    JSON.stringify(parityEvidence({ runs: [] }, terminalParityFixture)),
  'package parity failed to normalize caller identity and dependent digests',
)

if (process.env.BRAID_PACKAGE_PROOF_ISOLATED !== '1') {
  const isolatedRoot = await mkdtemp(join(tmpdir(), 'braid-package-source-'))
  try {
    await cp(repository, isolatedRoot, {
      recursive: true,
      filter: (source) =>
        !['.git', 'node_modules', 'dist', '.test-dist', 'artifacts'].some(
          (excluded) =>
            source === join(repository, excluded) ||
            source.startsWith(`${join(repository, excluded)}${sep}`),
        ),
    })
    await symlink(join(repository, 'node_modules'), join(isolatedRoot, 'node_modules'))
    await run(process.execPath, [join(isolatedRoot, 'scripts', 'clean.mjs')], {
      cwd: isolatedRoot,
    })
    await run(
      process.execPath,
      [join(repository, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'],
      { cwd: isolatedRoot },
    )
    const childArgs = [join(isolatedRoot, 'scripts', 'verify-package.mjs')]
    if (recordPath) childArgs.push('--record', resolve(repository, recordPath))
    if (tarballOutputPath)
      childArgs.push('--tarball-output', resolve(repository, tarballOutputPath))
    const child = await run(process.execPath, childArgs, {
      cwd: isolatedRoot,
      env: {
        ...cleanEnvironment({ NODE_NO_WARNINGS: '1' }),
        BRAID_PACKAGE_PROOF_ISOLATED: '1',
        BRAID_PACKAGE_PROOF_COMMIT: gitValue('rev-parse', 'HEAD'),
        BRAID_PACKAGE_PROOF_TREE: gitValue('rev-parse', 'HEAD^{tree}'),
        BRAID_PACKAGE_PROOF_SOURCE_DIGEST: await sourceDigest(repository),
      },
    })
    process.stdout.write(child.stdout)
    process.stderr.write(child.stderr)
  } finally {
    await rm(isolatedRoot, { force: true, recursive: true })
  }
  process.exit(0)
}

const packRoot = suppliedTarballPath ? undefined : await mkdtemp(join(tmpdir(), 'braid-pack-'))
const installRoot = await mkdtemp(join(tmpdir(), 'braid-install-'))
try {
  const sourcePackageJson = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'))
  if (packRoot)
    await run(pnpmExecutable(), ['pack', '--pack-destination', packRoot], { cwd: repository })
  const tarballName = packRoot
    ? (await readdir(packRoot)).find((name) => name.endsWith('.tgz'))
    : basename(suppliedTarballPath)
  if (!tarballName) throw new Error('pnpm pack did not produce a tarball')
  const tarball = packRoot ? join(packRoot, tarballName) : resolve(suppliedTarballPath)
  const tarballInfo = await lstat(tarball)
  assert(
    tarballInfo.isFile() && !tarballInfo.isSymbolicLink(),
    'release tarball must be a regular non-symlink file',
  )
  await writeFile(
    join(installRoot, 'package.json'),
    `${JSON.stringify({ name: 'braid-clean-install-proof', private: true })}\n`,
  )
  await run(npmExecutable(), ['install', '--no-audit', '--no-fund', tarball], {
    cwd: installRoot,
    env: installEnvironment(),
  })
  const installedPackageRoot = join(installRoot, 'node_modules', '@tangle-network', 'braid')
  const installedPackageJson = JSON.parse(
    await readFile(join(installedPackageRoot, 'package.json'), 'utf8'),
  )
  assert(installedPackageJson.name === sourcePackageJson.name, 'installed package name mismatch')
  assert(
    installedPackageJson.version === sourcePackageJson.version,
    'installed package version mismatch',
  )
  assert(
    installedPackageJson.bin?.braid === './dist/bin/braid.js',
    'installed package lost the braid binary declaration',
  )
  const packageOwnedEntries = new Set([
    'package.json',
    'dist',
    'LICENSE',
    'README.md',
    'THIRD_PARTY_LICENSES.json',
    'THIRD_PARTY_NOTICES.md',
  ])
  const declaredPackageFiles = new Set(installedPackageJson.files ?? [])
  const expectedDeclaredFiles = new Set(
    [...packageOwnedEntries].filter((entry) => entry !== 'package.json'),
  )
  assert(
    declaredPackageFiles.size === expectedDeclaredFiles.size &&
      [...expectedDeclaredFiles].every((entry) => declaredPackageFiles.has(entry)),
    'packed package files allowlist does not match the audited package contents',
  )
  const installedEntries = await readdir(installedPackageRoot, { withFileTypes: true })
  for (const entry of installedEntries) {
    assert(
      packageOwnedEntries.has(entry.name) || entry.name === 'node_modules',
      `packed package contains unexpected ${entry.name}`,
    )
    if (entry.name !== 'node_modules')
      assert(!entry.isSymbolicLink(), `packed package contains symlink ${entry.name}`)
  }
  for (const required of packageOwnedEntries) {
    assert(
      installedEntries.some((entry) => entry.name === required),
      `packed package is missing ${required}`,
    )
  }
  const binaryInfo = await lstat(join(installedPackageRoot, 'dist', 'bin', 'braid.js'))
  assert(binaryInfo.isFile() && !binaryInfo.isSymbolicLink(), 'packed binary is not a regular file')
  if (process.platform !== 'win32')
    assert((binaryInfo.mode & 0o111) !== 0, 'packed binary is not executable')
  const installedSourceNames = new Set(['src', 'test', 'docs', '.git', '.npmrc', '.env'])
  assert(
    installedEntries.every((entry) => !installedSourceNames.has(entry.name)),
    'packed package contains source or credential configuration',
  )
  async function assertNoPackageLinks(path) {
    const entries = await readdir(path, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = join(path, entry.name)
      assert(!entry.isSymbolicLink(), `packed package contains symlink ${entryPath}`)
      if (entry.isDirectory()) await assertNoPackageLinks(entryPath)
    }
  }
  const secretCanaries = [
    'W12_SECRET_ARTIFACT_CANARY',
    'PACKED_W5_RAW_BYTE_CANARY',
    'SECRET_TYPED_INTERACTION_CANARY',
  ]
  for (const entry of packageOwnedEntries) {
    const ownedPath = join(installedPackageRoot, entry)
    const info = await lstat(ownedPath)
    assert(!info.isSymbolicLink(), `packed package contains symlink ${entry}`)
    if (info.isDirectory()) await assertNoPackageLinks(ownedPath)
    await assertNoSecretArtifacts(ownedPath, secretCanaries)
  }
  const storageSmoke = join(installRoot, 'storage-smoke.mjs')
  await writeFile(
    storageSmoke,
    `
import assert from 'node:assert/strict'
import { readFile, mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MemoryCredentialStore,
  openSqliteStorage,
  canonicalDigest,
  createConversationId,
  createEventId,
  createOperationId,
  createRunId,
  createWorkspaceId,
  credentialRef,
} from '@tangle-network/braid'

const root = await mkdtemp(join(tmpdir(), 'braid-packed-storage-'))
const database = join(root, 'braid.sqlite')
const backup = join(root, 'braid.backup')
const credentials = new MemoryCredentialStore()
const canary = 'PACKED_W5_RAW_BYTE_CANARY'
const storage = await openSqliteStorage({
  path: database,
  workspaceRoot: root,
  credentialStore: credentials,
  databaseKeyRef: credentialRef('cred:v1:packed-database'),
})
try {
  const event = {
    workspaceId: createWorkspaceId('workspace-packed'),
    conversationId: createConversationId('conversation-packed'),
    runId: createRunId('run-packed'),
    eventId: createEventId('event-packed'),
    sequence: 1,
    kind: 'run.finished',
    payload: { text: canary },
    occurredAt: '2026-08-02T00:00:00.000Z',
    terminal: true,
  }
  await storage.append([event])
  assert.equal((await storage.replay({ runId: event.runId })).events[0]?.payloadState, 'available')
  assert.equal((await storage.integrity()).ok, true)
  const backupRequest = { path: backup }
  await storage.backup({
    path: backup,
    operation: {
      operationId: createOperationId('op-packed-backup'),
      kind: 'backup',
      request: backupRequest,
      requestDigest: canonicalDigest(backupRequest),
    },
  })
  for (const path of [database, backup, database + '-wal', database + '-shm']) {
    assert.equal((await readFile(path).catch(() => Buffer.alloc(0))).includes(Buffer.from(canary)), false, path)
  }
  assert.ok((await stat(backup)).size > 0)
} finally {
  await storage.close()
}
`,
  )
  await run(process.execPath, [storageSmoke], { cwd: installRoot })
  const binary = join(
    installRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'braid.cmd' : 'braid',
  )
  const path = `${join(installRoot, 'node_modules', '.bin')}${delimiter}${process.env.PATH ?? ''}`
  const environment = cleanEnvironment({ PATH: path, NO_COLOR: '1' })
  const version = await runPty(binary, ['--version'], {
    cwd: installRoot,
    env: { ...environment, NODE_NO_WARNINGS: '1' },
  })
  const help = await runPty(binary, ['--help'], {
    cwd: installRoot,
    env: { ...environment, NODE_NO_WARNINGS: '1' },
  })
  assert(version.stdout.trim() === sourcePackageJson.version, 'packed --version mismatch')
  assert(help.stdout.includes('braid rpc'), 'packed --help omitted RPC mode')

  const rpc = await runRpc(binary, installRoot)
  const plain = await runPlain(binary, installRoot)
  const terminal80 = await runTerminal(binary, installRoot, {
    columns: 80,
    rows: 24,
    inline: false,
  })
  const terminal40 = await runTerminal(binary, installRoot, {
    columns: 40,
    rows: 12,
    inline: false,
  })
  const terminal120 = await runTerminal(binary, installRoot, {
    columns: 120,
    rows: 40,
    inline: false,
  })
  const terminal200 = await runTerminal(binary, installRoot, {
    columns: 200,
    rows: 60,
    inline: false,
  })
  const accessibility = await runTerminal(binary, installRoot, {
    columns: 80,
    rows: 24,
    inline: false,
    highContrast: true,
    reducedMotion: true,
  })
  const inline = await runTerminal(binary, installRoot, {
    columns: 80,
    rows: 24,
    inline: true,
  })
  const signal = await runSignalTerminal(binary, installRoot)
  const terminalBaseline = firstTerminalTrace(terminal80.evidence)
  const rpcParity = parityEvidence(rpc.firstState, rpc.baselineEvents)
  const terminalParity = parityEvidence(terminalBaseline.state, terminalBaseline.events)
  const keyboardMatchesRpc = JSON.stringify(rpcParity) === JSON.stringify(terminalParity)
  const expectedFlows = ['send', 'graph', 'unavailable', 'retry', 'cancel', 'shutdown']
  const flowsMatch = (flows) => JSON.stringify(flows) === JSON.stringify(expectedFlows)

  assert(
    keyboardMatchesRpc,
    `keyboard and RPC normalized event ledgers or semantic states differ at ${JSON.stringify(firstDifference(rpcParity, terminalParity))}`,
  )
  assert(flowsMatch(rpc.flows), 'RPC proof did not exercise the complete flow')
  assert(flowsMatch(plain.flows), 'plain proof did not exercise the complete flow')
  assert(flowsMatch(terminal80.flows), 'terminal proof did not exercise the complete flow')
  assert(terminal80.output.includes('\u001b[?1049h'), 'alternate screen was not entered')
  assert(terminal80.output.includes('\u001b[?1049l'), 'alternate screen was not restored')
  for (const terminal of [terminal40, terminal80, terminal120, terminal200]) {
    assert(terminal.output.includes('\u001b[?1049l'), 'reference terminal did not restore screen')
  }
  assert(
    accessibility.evidence.view?.appearance?.highContrast === true,
    'packed high-contrast flag did not reach semantic state',
  )
  assert(
    accessibility.evidence.view?.appearance?.reducedMotion === true,
    'packed reduced-motion flag did not reach semantic state',
  )
  assertAccessibleTerminalOutput(accessibility.output)
  assert(!inline.output.includes('\u001b[?1049h'), 'inline mode entered alternate screen')
  assert(signal.output.includes('\u001b[?1049l'), 'SIGINT did not restore alternate screen')
  assert(signal.output.includes('\u001b[?2004l'), 'SIGINT did not disable bracketed paste')
  assert(signal.output.includes('\u001b[?25h'), 'SIGINT did not restore the cursor')
  assert(signal.exit.exitCode === 130, `SIGINT exited ${signal.exit.exitCode}`)
  const sgrPattern = new RegExp(`${String.fromCharCode(27)}\\[([0-9;]*)m`, 'gu')
  // Pi uses inverse-video (7/27) for the text cursor even when theme colors are disabled.
  const unexpectedSgr = [...terminal80.output.matchAll(sgrPattern)]
    .map((match) => match[1])
    .filter(
      (parameters) =>
        parameters !== '' && parameters !== '0' && parameters !== '7' && parameters !== '27',
    )
  assert(
    unexpectedSgr.length === 0,
    `--no-color emitted unexpected SGR sequences: ${[...new Set(unexpectedSgr)].join(', ')}`,
  )
  assert(rpc.stderr === '', 'RPC wrote human logs to stderr during a successful run')
  assert(plain.stderr === '', 'plain mode wrote stderr during a successful run')
  assert(!plain.stdout.includes('\u001b'), 'plain mode emitted terminal controls')
  assert(
    plain.evidence.state.messages.some(
      (message) =>
        message.role === 'assistant' &&
        message.status === 'complete' &&
        message.text === 'Fixture response through pi: plain package proof',
    ),
    'plain --record-state did not persist final semantic state',
  )

  const tarballBytes = await readFile(tarball)
  const persistedTarball = tarballOutputPath ? resolve(repository, tarballOutputPath) : tarball
  if (tarballOutputPath) await writeExclusiveAtomic(persistedTarball, tarballBytes)
  const proof = {
    tarball: basename(persistedTarball),
    sha256: createHash('sha256').update(tarballBytes).digest('hex'),
    version: version.stdout.trim(),
    gitCommit: gitValue('rev-parse', 'HEAD'),
    treeSha256: gitValue('rev-parse', 'HEAD^{tree}'),
    sourceDigest: process.env.BRAID_PACKAGE_PROOF_SOURCE_DIGEST ?? (await sourceDigest(repository)),
    isolatedBuild: true,
    sourceCheckout: 'isolated-copy-of-worktree',
    packageFileManifest: packageFileManifestFromTarball(tarballBytes),
    rpcRecords: rpc.responses.length,
    referenceSizes: [
      { columns: 40, rows: 12, events: terminal40.evidence.events.length },
      { columns: 80, rows: 24, events: terminal80.evidence.events.length },
      { columns: 120, rows: 40, events: terminal120.evidence.events.length },
      { columns: 200, rows: 60, events: terminal200.evidence.events.length },
    ],
    alternateScreenRestored: true,
    sigintRestored: true,
    stateWriteSymlinkSafe: true,
    inlineStayedInMainScreen: true,
    keyboardMatchesRpc,
    eventLedgerMatchesRpc: keyboardMatchesRpc,
    flowParity: {
      rpc: rpc.flows,
      terminal: terminal80.flows,
      plain: plain.flows,
      allFlowsMatch:
        flowsMatch(rpc.flows) && flowsMatch(terminal80.flows) && flowsMatch(plain.flows),
    },
    plainRecordState: true,
    accessibility: {
      highContrast: accessibility.evidence.view?.appearance?.highContrast === true,
      reducedMotion: accessibility.evidence.view?.appearance?.reducedMotion === true,
      terminalModesRestored: accessibility.output.includes('\u001b[?1049l'),
    },
  }
  const proofJson = `${JSON.stringify(proof, null, 2)}\n`
  if (recordPath) {
    const target = resolve(repository, recordPath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, proofJson)
  }
  process.stdout.write(proofJson)
} finally {
  if (packRoot) await rm(packRoot, { force: true, recursive: true })
  await rm(installRoot, { force: true, recursive: true })
}
