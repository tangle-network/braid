import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path'
import { assert } from './package-proof-assertions.mjs'
import { parityEvidence, firstTerminalTrace } from './package-proof-parity.mjs'
import { runRpc } from './package-proof-rpc.mjs'
import { cleanEnvironment, runCommand, runPty } from './package-proof-process.mjs'
import { runPlain, runSignalTerminal, runTerminal } from './package-proof-terminal.mjs'

const repository = new URL('../', import.meta.url).pathname
const SOURCE_EXCLUSIONS = new Set(['.git', 'node_modules', 'dist', '.test-dist', 'artifacts'])

async function sourceDigest(root) {
  const files = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && SOURCE_EXCLUSIONS.has(entry.name)) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else files.push(path)
    }
  }
  await walk(root)
  files.sort()
  const digest = createHash('sha256')
  for (const path of files) {
    digest.update(relative(root, path))
    digest.update('\0')
    digest.update(await readFile(path))
    digest.update('\0')
  }
  return digest.digest('hex')
}

function gitValue(...args) {
  if (args.join(' ') === 'rev-parse HEAD' && process.env.BRAID_PACKAGE_PROOF_COMMIT)
    return process.env.BRAID_PACKAGE_PROOF_COMMIT
  if (args.join(' ') === 'rev-parse HEAD^{tree}' && process.env.BRAID_PACKAGE_PROOF_TREE)
    return process.env.BRAID_PACKAGE_PROOF_TREE
  try {
    return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
  } catch (error) {
    if (error?.status === 0 && typeof error.stdout === 'string') return error.stdout.trim()
    throw error
  }
}

const recordIndex = process.argv.indexOf('--record')
const recordPath = recordIndex === -1 ? undefined : process.argv[recordIndex + 1]
if (recordIndex !== -1 && !recordPath) throw new Error('--record requires a path')

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
    await runCommand(process.execPath, [join(isolatedRoot, 'scripts', 'clean.mjs')], {
      cwd: isolatedRoot,
    })
    await runCommand(
      process.execPath,
      [join(repository, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'],
      { cwd: isolatedRoot },
    )
    const childArgs = [join(isolatedRoot, 'scripts', 'verify-package.mjs')]
    if (recordPath) childArgs.push('--record', resolve(repository, recordPath))
    const child = await runCommand(process.execPath, childArgs, {
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

const packRoot = await mkdtemp(join(tmpdir(), 'braid-pack-'))
const installRoot = await mkdtemp(join(tmpdir(), 'braid-install-'))
try {
  await runCommand('pnpm', ['pack', '--pack-destination', packRoot], { cwd: repository })
  const tarballName = (await readdir(packRoot)).find((name) => name.endsWith('.tgz'))
  if (!tarballName) throw new Error('pnpm pack did not produce a tarball')
  const tarball = join(packRoot, tarballName)
  await writeFile(
    join(installRoot, 'package.json'),
    `${JSON.stringify({ name: 'braid-clean-install-proof', private: true })}\n`,
  )
  await runCommand(
    'npm',
    ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
    { cwd: installRoot },
  )
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
  assert(version.stdout.trim() === '0.1.0', 'packed --version mismatch')
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
  const inline = await runTerminal(binary, installRoot, {
    columns: 80,
    rows: 24,
    inline: true,
  })
  const signal = await runSignalTerminal(binary, installRoot)
  const terminalBaseline = firstTerminalTrace(terminal80.evidence)
  const keyboardMatchesRpc =
    JSON.stringify(parityEvidence(rpc.firstState, rpc.baselineEvents)) ===
    JSON.stringify(parityEvidence(terminalBaseline.state, terminalBaseline.events))
  const expectedFlows = ['send', 'graph', 'unavailable', 'retry', 'cancel', 'shutdown']
  const flowsMatch = (flows) => JSON.stringify(flows) === JSON.stringify(expectedFlows)

  assert(keyboardMatchesRpc, 'keyboard and RPC normalized event ledgers or semantic states differ')
  assert(flowsMatch(rpc.flows), 'RPC proof did not exercise the complete flow')
  assert(flowsMatch(plain.flows), 'plain proof did not exercise the complete flow')
  assert(flowsMatch(terminal80.flows), 'terminal proof did not exercise the complete flow')
  assert(terminal80.output.includes('\u001b[?1049h'), 'alternate screen was not entered')
  assert(terminal80.output.includes('\u001b[?1049l'), 'alternate screen was not restored')
  for (const terminal of [terminal40, terminal80, terminal120, terminal200]) {
    assert(terminal.output.includes('\u001b[?1049l'), 'reference terminal did not restore screen')
  }
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
  const proof = {
    tarball: tarballName,
    sha256: createHash('sha256').update(tarballBytes).digest('hex'),
    version: version.stdout.trim(),
    gitCommit: gitValue('rev-parse', 'HEAD'),
    treeSha256: gitValue('rev-parse', 'HEAD^{tree}'),
    sourceDigest: process.env.BRAID_PACKAGE_PROOF_SOURCE_DIGEST ?? (await sourceDigest(repository)),
    isolatedBuild: true,
    sourceCheckout: 'isolated-copy-of-worktree',
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
  }
  const proofJson = `${JSON.stringify(proof, null, 2)}\n`
  if (recordPath) {
    const target = resolve(repository, recordPath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, proofJson)
  }
  process.stdout.write(proofJson)
} finally {
  await rm(packRoot, { force: true, recursive: true })
  await rm(installRoot, { force: true, recursive: true })
}
