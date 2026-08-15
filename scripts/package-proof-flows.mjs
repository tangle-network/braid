import { readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import xterm from '@xterm/headless'
import * as pty from 'node-pty'
import { baselineEventEnd } from './package-proof-parity.mjs'
import {
  cleanEnvironment,
  runFifoCommand,
  shellArgument,
  sleep,
  waitFor,
} from './package-proof-runtime.mjs'

const XtermTerminal = xterm.Terminal

export async function runRpc(binary, cwd) {
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
    request({
      version: 1,
      requestId: 'req-unavailable',
      operationId: 'op-rpc-steer-000001',
      command: 'steer',
      params: { runId: 'run-000001', text: 'steer from package proof' },
    }),
    'sleep 1',
    request({ version: 1, requestId: 'req-graph', command: 'get_graph', params: {} }),
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
  const firstState = allResponses
    .filter((response) => response.type === 'state' && response.requestId === 'req-send')
    .at(-1)?.state
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
  const graphAck = allResponses.find(
    (response) => response.type === 'ack' && response.requestId === 'req-graph',
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
    Array.isArray(graphAck?.result?.nodes) &&
      graphAck.result.nodes.some((node) => node?.type === 'conversation'),
    'packed RPC graph command did not return the semantic graph',
  )
  assert(
    unavailable?.code === 'CAPABILITY_UNAVAILABLE' &&
      /steering.*supported by this run/u.test(unavailable.message ?? ''),
    'packed RPC deterministic steering capability changed behavior',
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

export async function runTerminal(binary, cwd, options) {
  const recordPath = join(
    cwd,
    `terminal-${options.columns}x${options.rows}-${options.inline ? 'inline' : 'alt'}-${options.highContrast ? 'high-contrast' : 'default'}-${options.reducedMotion ? 'reduced-motion' : 'motion'}.json`,
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
  if (options.highContrast) args.push('--high-contrast')
  if (options.reducedMotion) args.push('--reduced-motion')
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

  await waitFor(() => screen.includes('Braid starter'), 'terminal conversation shell')
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
    () => normalizedScreen().includes('Fixture response through pi: hello from package proof'),
    'completed fixture response',
  )
  const screenBeforeExit = screen
  session.write('\u0007')
  await waitFor(() => normalizedScreen().includes('conversation graph'), 'terminal graph')
  session.write('\u001b')
  await sleep(30)
  session.write('hello from package proof')
  session.write('\r')
  await waitFor(() => normalizedScreen().includes('working'), 'terminal retry start')
  // Deterministic execution intentionally does not advertise live steering.
  session.write('/steer deterministic package proof')
  session.write('\r')
  await waitFor(
    () => normalizedScreen().includes('steering'),
    'terminal unavailable steering capability',
  )
  session.write('\u001b')
  await sleep(30)
  await waitFor(
    () =>
      normalizedScreen().includes('Fixture response through pi: hello from package proof') &&
      !normalizedScreen().includes('working'),
    'terminal retry completion',
  )
  session.write('cancel terminal proof')
  session.write('\r')
  await waitFor(() => normalizedScreen().includes('working'), 'terminal cancellation start')
  session.write('/cancel')
  session.write('\r')
  await waitFor(() => normalizedScreen().includes('cancelled'), 'terminal cancellation')
  session.write('\u0003')
  await waitFor(() => screen.toLowerCase().includes('ctrl+c again to quit'), 'armed terminal exit')
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

export async function runSignalTerminal(binary, cwd) {
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
  await waitFor(() => output.includes('Braid starter'), 'signal terminal conversation shell')
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

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
