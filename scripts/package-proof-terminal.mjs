import { join } from 'node:path'
import { readFile, rm, symlink, writeFile } from 'node:fs/promises'
import * as pty from 'node-pty'
import xterm from '@xterm/headless'
import { assert } from './package-proof-assertions.mjs'
import {
  cleanEnvironment,
  runFifoCommand,
  shellArgument,
  sleep,
  waitFor,
} from './package-proof-process.mjs'

const XtermTerminal = xterm.Terminal

export async function runPlain(binary, cwd) {
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

export async function runTerminal(binary, cwd, options) {
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
