import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path'
import * as pty from 'node-pty'
import xterm from '@xterm/headless'

const repository = new URL('../', import.meta.url).pathname
const SOURCE_EXCLUSIONS = new Set(['.git', 'node_modules', 'dist', '.test-dist', 'artifacts'])

async function sourceDigest(root) {
  const files = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (SOURCE_EXCLUSIONS.has(entry.name)) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files.push(path)
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

const gitValue = (...args) => {
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

function shellArgument(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function runFifoCommand(command, cwd, env) {
  const fifoRoot = await mkdtemp(join(tmpdir(), 'braid-fifo-'))
  const stdoutPath = join(fifoRoot, 'stdout')
  const stderrPath = join(fifoRoot, 'stderr')
  await run('mkfifo', [stdoutPath, stderrPath])
  const readFifo = (path, sink) =>
    new Promise((resolve, reject) => {
      const stream = createReadStream(path, { encoding: 'utf8' })
      stream.on('data', (chunk) => {
        sink.value += chunk
      })
      stream.on('error', reject)
      stream.on('end', resolve)
    })
  const stdoutRead = { value: '' }
  const stderrRead = { value: '' }
  const child = spawn('/bin/sh', ['-c', command(stdoutPath, stderrPath)], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let wrapperStderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    wrapperStderr += chunk
  })
  child.stdout.resume()
  const close = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve(code))
  })
  const timeout = setTimeout(() => child.kill(), 5_000)
  try {
    const [exitCode] = await Promise.all([
      close,
      readFifo(stdoutPath, stdoutRead),
      readFifo(stderrPath, stderrRead),
    ])
    if (exitCode !== 0)
      throw new Error(`fifo command exited ${exitCode}\n${wrapperStderr}\n${stderrRead.value}`)
    return { stdout: stdoutRead.value, stderr: `${wrapperStderr}${stderrRead.value}` }
  } finally {
    clearTimeout(timeout)
    await rm(fifoRoot, { force: true, recursive: true })
  }
}

async function runPty(file, args, options = {}) {
  const session = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: 240,
    rows: 80,
    cwd: options.cwd,
    env: options.env ?? cleanEnvironment({ NODE_NO_WARNINGS: '1' }),
  })
  let stdout = ''
  session.onData((chunk) => {
    stdout += chunk
  })
  const exit = await new Promise((resolve) => session.onExit(resolve))
  if (exit.exitCode !== 0)
    throw new Error(`${file} ${args.join(' ')} exited ${exit.exitCode}\n${stdout}`)
  return { stdout: stdout.replace(/\r\n/gu, '\n').replace(/\r/gu, ''), stderr: '' }
}

async function runRpc(binary, cwd) {
  const request = (value) => `printf '%s\\n' ${shellArgument(JSON.stringify(value))}`
  const script = [
    request({
      version: 1,
      requestId: 'req-init',
      command: 'initialize',
      params: { workspace: cwd, subscribe: true },
    }),
    request({
      version: 1,
      requestId: 'req-send',
      operationId: 'op-rpc-000001',
      command: 'send',
      params: {
        conversationId: 'conv-1',
        branchId: 'branch-1',
        text: 'hello from package proof',
      },
    }),
    'sleep 1',
    request({ version: 1, requestId: 'req-graph', command: 'get_graph', params: {} }),
    request({ version: 1, requestId: 'req-unavailable', command: 'list_profiles', params: {} }),
    request({
      version: 1,
      requestId: 'req-retry',
      operationId: 'op-rpc-000001',
      command: 'send',
      params: {
        conversationId: 'conv-1',
        branchId: 'branch-1',
        text: 'hello from package proof',
      },
    }),
    request({
      version: 1,
      requestId: 'req-cancel-send',
      operationId: 'op-rpc-cancel-send',
      command: 'send',
      params: { text: 'cancel from package proof' },
    }),
    request({
      version: 1,
      requestId: 'req-cancel',
      operationId: 'op-rpc-cancel',
      command: 'cancel_run',
      params: { runId: 'run-000005', reason: 'package proof cancellation' },
    }),
    request({
      version: 1,
      requestId: 'req-stop',
      operationId: 'op-rpc-shutdown',
      command: 'shutdown',
    }),
  ].join('; ')
  const result = await Promise.race([
    runFifoCommand(
      (stdoutPath, stderrPath) =>
        `{ ${script}; } | exec ${shellArgument(binary)} rpc --fixture deterministic > ${shellArgument(stdoutPath)} 2> ${shellArgument(stderrPath)}`,
      cwd,
      cleanEnvironment({
        NO_COLOR: '1',
        NODE_NO_WARNINGS: '1',
        BRAID_FIXTURE_CHUNK_DELAY_MS: '100',
        BRAID_JOURNAL_PATH: join(cwd, 'rpc-events.jsonl'),
      }),
    ),
    sleep(5_000).then(() => {
      throw new Error('packed RPC did not exit')
    }),
  ])
  const { stdout, stderr } = result
  const responses = () =>
    stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  if (stderr) throw new Error(`packed RPC wrote stderr: ${stderr}`)
  const allResponses = responses()
  const firstState = allResponses.find(
    (response) => response.type === 'state' && response.requestId === 'req-send',
  )?.state
  if (!firstState) throw new Error('packed RPC did not return send state')
  const state = allResponses.find(
    (response) => response.type === 'state' && response.requestId === 'req-cancel',
  )?.state
  if (!state)
    throw new Error(
      `packed RPC did not return cancellation state; responses=${allResponses.map((response) => `${response.type}:${response.requestId ?? ''}:${response.code ?? ''}`).join(',')}`,
    )
  const events = allResponses
    .filter((response) => response.type === 'event')
    .map((response) => response.event)
  const baselineEvents = events.slice(0, baselineEventEnd(events))
  const retryAck = allResponses.find(
    (response) => response.type === 'ack' && response.requestId === 'req-retry',
  )
  const graphState = allResponses.find(
    (response) => response.type === 'state' && response.requestId === 'req-graph',
  )
  const unavailable = allResponses.find(
    (response) => response.type === 'error' && response.requestId === 'req-unavailable',
  )
  const cancelState = allResponses.find(
    (response) => response.type === 'state' && response.requestId === 'req-cancel',
  )
  const shutdownAck = allResponses.find(
    (response) => response.type === 'ack' && response.requestId === 'req-stop',
  )
  assert(retryAck?.replayed === true, 'packed RPC retry did not replay the operation')
  assert(
    graphState?.view?.selectedSurface === 'graph',
    'packed RPC graph command did not open graph',
  )
  assert(
    unavailable?.code === 'CAPABILITY_UNAVAILABLE',
    'packed RPC unavailable command changed behavior',
  )
  assert(
    cancelState?.state?.runs?.at(-1)?.status === 'aborted',
    'packed RPC cancel did not abort the active run',
  )
  assert(
    shutdownAck?.operationId === 'op-rpc-shutdown',
    'packed RPC shutdown was not operation-bound',
  )
  return {
    responses: allResponses,
    state,
    firstState,
    events,
    baselineEvents,
    stderr,
    flows: ['send', 'graph', 'unavailable', 'retry', 'cancel', 'shutdown'],
  }
}

async function runPlain(binary, cwd) {
  const recordPath = join(cwd, 'plain-final-state.json')
  const line = (value) => `printf '%s\\n' ${shellArgument(value)}`
  const script = [
    line('plain package proof'),
    'sleep 1.5',
    line('/graph'),
    line('/open'),
    line('plain package proof'),
    line('/graph'),
    line('/open'),
    line('/cancel'),
    line('/quit'),
  ].join('; ')
  const { stdout, stderr } = await Promise.race([
    runFifoCommand(
      (stdoutPath, stderrPath) =>
        `{ ${script}; } | exec ${shellArgument(binary)} --plain --fixture deterministic --no-color --workspace ${shellArgument(cwd)} --record-state ${shellArgument(recordPath)} > ${shellArgument(stdoutPath)} 2> ${shellArgument(stderrPath)}`,
      cwd,
      cleanEnvironment({
        NO_COLOR: '1',
        NODE_NO_WARNINGS: '1',
        BRAID_FIXTURE_CHUNK_DELAY_MS: '100',
        BRAID_JOURNAL_PATH: join(cwd, 'plain-events.jsonl'),
      }),
    ),
    sleep(5_000).then(() => {
      throw new Error('plain proof did not exit')
    }),
  ])
  const evidence = JSON.parse(await readFile(recordPath, 'utf8'))
  const result = { stdout, stderr }
  assert(evidence.view?.selectedSurface === 'graph', 'plain graph command did not open graph')
  assert(
    evidence.state.runs.some((run) => run.status === 'aborted'),
    'plain cancel did not abort a run',
  )
  assert(
    evidence.state.messages.some(
      (message) =>
        message.role === 'assistant' &&
        message.status === 'complete' &&
        message.text === 'Fixture response through pi: plain package proof',
    ),
    'plain retry did not complete',
  )
  return {
    ...result,
    evidence,
    flows: ['send', 'graph', 'unavailable', 'retry', 'cancel', 'shutdown'],
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function baselineEventEnd(events) {
  const finishIndex = events.findIndex(
    (event) => event.kind === 'run.finished' && event.payload?.status === 'completed',
  )
  if (finishIndex < 0) throw new Error('proof has no completed baseline run')
  const requested = events.slice(0, finishIndex).find((event) => event.kind === 'run.requested')
  const operationId = requested?.payload?.operationId
  let end = finishIndex + 1
  while (
    typeof operationId === 'string' &&
    events[end]?.kind === 'effect.upserted' &&
    events[end]?.payload?.effect?.operationId === operationId
  ) {
    end += 1
  }
  return end
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
    env: cleanEnvironment({
      NO_COLOR: '1',
      TERM: 'xterm-256color',
      BRAID_FIXTURE_CHUNK_DELAY_MS: '100',
      BRAID_JOURNAL_PATH: `${recordPath}.journal`,
    }),
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
      () => screen.includes('Commands') && screen.includes('/new'),
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
      normalizedScreen().includes('completed'),
    'completed fixture response',
  )
  const screenBeforeExit = screen
  session.write('\u0007')
  await waitFor(() => normalizedScreen().includes('conversation graph'), 'terminal graph')
  session.write('\u001b')
  await sleep(30)
  session.write('/open')
  session.write('\r')
  await waitFor(
    () => normalizedScreen().includes('Conversation search is not exposed'),
    'terminal unavailable command',
  )
  session.write('\u001b')
  await sleep(30)
  session.write('hello from package proof')
  session.write('\r')
  await waitFor(() => normalizedScreen().includes('streaming'), 'terminal retry start')
  await waitFor(
    () =>
      normalizedScreen().includes('Fixture response through pi: hello from package proof') &&
      normalizedScreen().includes('completed') &&
      !normalizedScreen().includes('streaming'),
    'terminal retry completion',
  )
  session.write('cancel terminal proof')
  session.write('\r')
  await waitFor(() => normalizedScreen().includes('streaming'), 'terminal cancellation start')
  session.write('/cancel')
  session.write('\r')
  await waitFor(() => normalizedScreen().includes('cancelled'), 'terminal cancellation')
  session.write('\u0003')
  await waitFor(
    () => screen.includes('press ctrl+c again to quit') || screen.includes('ctrl+c again to quit'),
    'armed terminal exit',
  )
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
  return {
    output,
    screenBeforeExit,
    evidence,
    flows: ['send', 'graph', 'unavailable', 'retry', 'cancel', 'shutdown'],
  }
}

async function runSignalTerminal(binary, cwd) {
  const session = pty.spawn(binary, ['--fixture', 'deterministic', '--no-color'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: cleanEnvironment({
      NO_COLOR: '1',
      TERM: 'xterm-256color',
      BRAID_JOURNAL_PATH: join(cwd, 'signal-events.jsonl'),
    }),
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

function sortParityValue(value) {
  if (Array.isArray(value)) return value.map((item) => sortParityValue(item))
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortParityValue(child)]),
  )
}

function parityEvidence(state, events) {
  const operationIds = new Map()
  const normalizeCallerOperationId = (value) => {
    if (typeof value !== 'string') return value
    let normalized = operationIds.get(value)
    if (!normalized) {
      normalized = `<caller-operation-${operationIds.size + 1}>`
      operationIds.set(value, normalized)
    }
    return normalized
  }
  const normalizeDerivedOperationId = (value) => {
    if (typeof value !== 'string') return value
    for (const [operationId, normalized] of operationIds) {
      if (value.includes(operationId)) return value.replaceAll(operationId, normalized)
    }
    return value
  }
  const normalizeEffect = (effect) =>
    effect && typeof effect === 'object'
      ? {
          ...effect,
          id: normalizeDerivedOperationId(effect.id),
          operationId: normalizeCallerOperationId(effect.operationId),
        }
      : effect
  const normalizedState = {
    ...state,
    runs: Array.isArray(state?.runs)
      ? state.runs.map((run) => ({
          ...run,
          operationId: normalizeCallerOperationId(run?.operationId),
        }))
      : state?.runs,
    effects: Array.isArray(state?.effects)
      ? state.effects.map((effect) => normalizeEffect(effect))
      : state?.effects,
  }
  const normalizedEvents = events.map((event) =>
    event?.kind === 'run.requested' && event.payload && typeof event.payload === 'object'
      ? {
          ...event,
          payload: {
            ...event.payload,
            operationId: normalizeCallerOperationId(event.payload.operationId),
          },
        }
      : event?.kind === 'effect.upserted' && event.payload && typeof event.payload === 'object'
        ? {
            ...event,
            payload: {
              ...event.payload,
              effect: normalizeEffect(event.payload.effect),
            },
          }
        : event,
  )
  return sortParityValue({ events: normalizedEvents, state: normalizedState })
}

function firstDifference(left, right, path = '$') {
  if (Object.is(left, right)) return undefined
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length)
      return { path: `${path}.length`, left: left.length, right: right.length }
    for (let index = 0; index < left.length; index += 1) {
      const difference = firstDifference(left[index], right[index], `${path}[${index}]`)
      if (difference) return difference
    }
    return undefined
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)].sort())
    for (const key of keys) {
      const difference = firstDifference(left[key], right[key], `${path}.${key}`)
      if (difference) return difference
    }
    return undefined
  }
  return { path, left, right }
}

function firstTerminalTrace(evidence) {
  const finishIndex = evidence.events.findIndex(
    (event) => event.kind === 'run.finished' && event.payload?.status === 'completed',
  )
  if (finishIndex < 0) throw new Error('terminal proof has no completed baseline run')
  const finish = evidence.events[finishIndex]
  const baselineEnd = baselineEventEnd(evidence.events)
  const lastBaselineEvent = evidence.events[baselineEnd - 1] ?? finish
  return {
    state: {
      ...evidence.state,
      revision: lastBaselineEvent.revision,
      sequence: lastBaselineEvent.sequence,
      messages: evidence.state.messages.slice(0, 2),
      runs: evidence.state.runs.slice(0, 1),
      activeRunId: null,
      lastError: null,
    },
    events: evidence.events.slice(0, baselineEnd),
  }
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

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

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
