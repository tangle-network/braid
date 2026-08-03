import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import * as pty from 'node-pty'
import xterm from '@xterm/headless'

const repository = new URL('../', import.meta.url).pathname
const XtermTerminal = xterm.Terminal
const recordIndex = process.argv.indexOf('--record')
const recordPath = recordIndex === -1 ? undefined : process.argv[recordIndex + 1]
if (recordIndex !== -1 && !recordPath) throw new Error('--record requires a path')

function cleanEnvironment(extra = {}) {
  const environment = { ...process.env, ...extra }
  delete environment.FORCE_COLOR
  return environment
}

function installEnvironment() {
  const environment = cleanEnvironment({ npm_config_ignore_scripts: 'false' })
  delete environment.NPM_CONFIG_IGNORE_SCRIPTS
  return environment
}

async function run(file, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? cleanEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${file} ${args.join(' ')} exited ${code}\n${stdout}\n${stderr}`))
    })
  })
}

async function runRpc(binary, cwd) {
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, ['rpc', '--fixture', 'deterministic'], {
      cwd,
      env: cleanEnvironment({ NO_COLOR: '1' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`packed braid rpc exited ${code}\n${stdout}\n${stderr}`))
        return
      }
      try {
        const responses = stdout
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        const state = responses.find(
          (response) => response.type === 'state' && response.requestId === 'req-send',
        )?.state
        if (!state) throw new Error('packed RPC did not return send state')
        resolve({ responses, state, stderr })
      } catch (error) {
        reject(error)
      }
    })
    const requests = [
      {
        version: 1,
        requestId: 'req-init',
        command: 'initialize',
        params: { workspace: cwd, subscribe: true },
      },
      {
        version: 1,
        requestId: 'req-send',
        operationId: 'op-rpc-000001',
        command: 'send',
        params: {
          conversationId: 'conv-1',
          branchId: 'branch-1',
          text: 'hello from package proof',
        },
      },
      { version: 1, requestId: 'req-stop', command: 'shutdown' },
    ]
    child.stdin.end(`${requests.map((request) => JSON.stringify(request)).join('\n')}\n`)
  })
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await sleep(20)
  }
}

async function runTerminal(binary, cwd, options) {
  const recordPath = join(
    cwd,
    `terminal-${options.columns}x${options.rows}-${options.inline ? 'inline' : 'alt'}.json`,
  )
  const args = [
    '--fixture',
    'deterministic',
    '--no-color',
    '--workspace',
    cwd,
    '--record-state',
    recordPath,
  ]
  if (options.inline) args.push('--inline')
  const session = pty.spawn(binary, args, {
    name: 'xterm-256color',
    cols: options.columns,
    rows: options.rows,
    cwd,
    env: cleanEnvironment({ NO_COLOR: '1', TERM: 'xterm-256color' }),
  })
  const victimPath = `${recordPath}.victim`
  const formerPredictableTemporary = `${recordPath}.${session.pid}.tmp`
  await writeFile(victimPath, 'unchanged\n')
  await symlink(victimPath, formerPredictableTemporary)
  const emulator = new XtermTerminal({
    cols: options.columns,
    rows: options.rows,
    disableStdin: true,
    allowProposedApi: true,
  })
  let output = ''
  let screen = ''
  const exited = new Promise((resolve) => {
    session.onExit(resolve)
  })
  session.onData((chunk) => {
    output += chunk
    emulator.write(chunk, () => {
      const buffer = emulator.buffer.active
      screen = Array.from(
        { length: emulator.rows },
        (_, index) => buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? '',
      ).join('\n')
    })
  })
  const normalizedScreen = () => screen.replace(/\s+/gu, ' ').trim()

  await waitFor(() => screen.includes('braid'), 'terminal header')
  if (!options.inline) {
    session.write('\u0010')
    await waitFor(
      () => screen.includes('Commands') && screen.includes('/quit'),
      'searchable command overlay',
    )
    session.write('q')
    await waitFor(
      () => screen.includes('/quit') && !screen.includes('/help'),
      'filtered command overlay',
    )
    session.write('\u001b')
    await waitFor(() => !screen.includes('Commands'), 'closed command overlay')
  }
  session.write('hello from package proof')
  await sleep(30)
  session.write('\r')
  if (!options.inline) {
    const resizedColumns = Math.max(40, options.columns - 10)
    const resizedRows = Math.max(12, options.rows - 4)
    emulator.resize(resizedColumns, resizedRows)
    session.resize(resizedColumns, resizedRows)
    await sleep(30)
    emulator.resize(options.columns, options.rows)
    session.resize(options.columns, options.rows)
  }
  await waitFor(
    () =>
      normalizedScreen().includes('Fixture response through pi: hello from package proof') &&
      normalizedScreen().includes('ready'),
    'completed fixture response',
  )
  const screenBeforeExit = screen
  session.write('\u0003')
  await waitFor(() => screen.includes('press ctrl+c again to quit'), 'armed terminal exit')
  session.write('\u0003')
  let timeout
  const timedOut = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      session.kill()
      reject(new Error('Packed terminal did not exit after Ctrl+C'))
    }, 5_000)
  })
  const exit = await Promise.race([exited, timedOut]).finally(() => clearTimeout(timeout))
  if (exit.exitCode !== 0) throw new Error(`Packed terminal exited ${exit.exitCode}`)
  const evidence = JSON.parse(await readFile(recordPath, 'utf8'))
  assert(
    (await readFile(victimPath, 'utf8')) === 'unchanged\n',
    'state write followed a temp symlink',
  )
  await rm(formerPredictableTemporary, { force: true })
  emulator.dispose()
  return { output, screenBeforeExit, evidence }
}

async function runSignalTerminal(binary, cwd) {
  const session = pty.spawn(binary, ['--fixture', 'deterministic', '--no-color'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: cleanEnvironment({ NO_COLOR: '1', TERM: 'xterm-256color' }),
  })
  let output = ''
  const exited = new Promise((resolve) => session.onExit(resolve))
  session.onData((chunk) => {
    output += chunk
  })
  await waitFor(() => output.includes('braid'), 'signal terminal header')
  process.kill(session.pid, 'SIGINT')
  let timeout
  const timedOut = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      session.kill()
      reject(new Error('Packed terminal did not exit after SIGINT'))
    }, 5_000)
  })
  const exit = await Promise.race([exited, timedOut]).finally(() => clearTimeout(timeout))
  return { output, exit }
}

function semanticState(state) {
  return {
    conversationId: state.conversationId,
    branchId: state.branchId,
    draft: state.draft,
    messages: state.messages.map((message) => ({
      role: message.role,
      text: message.text,
      status: message.status,
    })),
    runs: state.runs.map((run) => ({ status: run.status })),
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const packRoot = await mkdtemp(join(tmpdir(), 'braid-pack-'))
const installRoot = await mkdtemp(join(tmpdir(), 'braid-install-'))
try {
  await run('pnpm', ['pack', '--pack-destination', packRoot], { cwd: repository })
  const tarballName = (await readdir(packRoot)).find((name) => name.endsWith('.tgz'))
  if (!tarballName) throw new Error('pnpm pack did not produce a tarball')
  const tarball = join(packRoot, tarballName)
  await writeFile(
    join(installRoot, 'package.json'),
    `${JSON.stringify({ name: 'braid-clean-install-proof', private: true })}\n`,
  )
  await run('npm', ['install', '--no-audit', '--no-fund', tarball], {
    cwd: installRoot,
    env: installEnvironment(),
  })
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
  const version = await run(binary, ['--version'], { cwd: installRoot, env: environment })
  const help = await run(binary, ['--help'], { cwd: installRoot, env: environment })
  assert(version.stdout.trim() === '0.1.0', 'packed --version mismatch')
  assert(help.stdout.includes('braid rpc'), 'packed --help omitted RPC mode')

  const rpc = await runRpc(binary, installRoot)
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

  assert(
    JSON.stringify(semanticState(rpc.state)) ===
      JSON.stringify(semanticState(terminal80.evidence.state)),
    'keyboard and RPC semantic states differ',
  )
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

  const tarballBytes = await readFile(tarball)
  const proof = {
    tarball: tarballName,
    sha256: createHash('sha256').update(tarballBytes).digest('hex'),
    version: version.stdout.trim(),
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
    keyboardMatchesRpc: true,
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
