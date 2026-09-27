import { spawn } from 'node:child_process'
import { readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import xterm from '@xterm/headless'
import * as pty from 'node-pty'
import { baselineEventEnd } from './package-proof-parity.mjs'
import { cleanEnvironment, sleep, waitFor } from './package-proof-runtime.mjs'

const XtermTerminal = xterm.Terminal

export async function runRpc(binary, cwd) {
  const child = spawn(binary, ['rpc', '--fixture', 'deterministic'], {
    cwd,
    env: cleanEnvironment({
      NO_COLOR: '1',
      NODE_NO_WARNINGS: '1',
      BRAID_FIXTURE_CHUNK_DELAY_MS: '100',
      BRAID_JOURNAL_PATH: join(cwd, 'rpc-events.jsonl'),
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const allResponses = []
  const queuedResponses = []
  const waiters = []
  let stderr = ''
  let outputClosed = false
  let streamFailure

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  const childExit = new Promise((resolveExit) => {
    child.once('error', (error) => {
      streamFailure = error
      outputClosed = true
      failWaiters(error)
      resolveExit({ error })
    })
    child.once('close', (code, signal) => resolveExit({ code, signal }))
  })

  function failWaiters(error) {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }

  lines.on('line', (line) => {
    let response
    try {
      response = JSON.parse(line)
    } catch {
      streamFailure = new Error(`packed RPC wrote a non-JSONL line: ${line.slice(0, 240)}`)
      failWaiters(streamFailure)
      return
    }
    if (!response || typeof response !== 'object') {
      streamFailure = new Error('packed RPC wrote a non-object response')
      failWaiters(streamFailure)
      return
    }
    allResponses.push(response)
    const index = waiters.findIndex((waiter) => waiter.matches(response))
    if (index === -1) {
      queuedResponses.push(response)
      return
    }
    const [waiter] = waiters.splice(index, 1)
    clearTimeout(waiter.timer)
    waiter.resolve(response)
  })

  lines.on('close', () => {
    outputClosed = true
    failWaiters(new Error('packed RPC closed stdout before returning the requested response'))
  })

  child.stdin.on('error', (error) => {
    streamFailure = new Error(`packed RPC input closed: ${error.message}`)
    failWaiters(streamFailure)
  })

  function nextResponse(matches, label, timeoutMs = 5_000) {
    const index = queuedResponses.findIndex(matches)
    if (index !== -1) return Promise.resolve(queuedResponses.splice(index, 1)[0])
    if (streamFailure) return Promise.reject(streamFailure)
    if (outputClosed) return Promise.reject(new Error('packed RPC stdout is closed'))
    return new Promise((resolveResponse, rejectResponse) => {
      const waiter = {
        matches,
        resolve: resolveResponse,
        reject: rejectResponse,
        timer: undefined,
      }
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter)
        if (index !== -1) waiters.splice(index, 1)
        rejectResponse(new Error(`timed out waiting for packed RPC ${label}`))
      }, timeoutMs)
      waiters.push(waiter)
    })
  }

  async function request(requestValue, completes, label) {
    if (streamFailure) throw streamFailure
    const response = nextResponse(
      (item) =>
        item.requestId === requestValue.requestId && (item.type === 'error' || completes(item)),
      label,
    )
    const write = new Promise((resolveWrite, rejectWrite) => {
      child.stdin.write(`${JSON.stringify(requestValue)}\n`, (error) => {
        if (error) rejectWrite(error)
        else resolveWrite()
      })
    })
    try {
      const [, result] = await Promise.all([write, response])
      return result
    } catch (error) {
      failWaiters(error)
      throw error
    }
  }

  function runInState(response, runId) {
    return response.state?.runs?.find((run) => run.id === runId)
  }

  async function waitForChildExit(timeoutMs) {
    let timer
    const timedOut = new Promise((resolveExit) => {
      timer = setTimeout(() => resolveExit(undefined), timeoutMs)
    })
    const result = await Promise.race([childExit, timedOut])
    clearTimeout(timer)
    return result
  }

  try {
    const initialized = await request(
      {
        version: 1,
        requestId: 'req-init',
        command: 'initialize',
        params: { workspace: cwd, subscribe: true },
      },
      (response) => response.type === 'ack',
      'initialize acknowledgement',
    )
    if (initialized.type !== 'ack') throw new Error('packed RPC initialize was not acknowledged')
    const initializedState = await nextResponse(
      (response) => response.type === 'state' && response.requestId === 'req-init',
      'initialized full state',
    )
    if (initializedState.projection !== 'full')
      throw new Error('packed RPC initialize did not return full state')

    const firstSend = await request(
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
      (response) => response.type === 'ack',
      'first send acknowledgement',
    )
    if (firstSend.type !== 'ack' || typeof firstSend.runId !== 'string')
      throw new Error('packed RPC first send was not acknowledged with a run identifier')
    const firstRunId = firstSend.runId
    const firstAdmission = await nextResponse(
      (response) =>
        response.type === 'state' &&
        response.requestId === 'req-send' &&
        runInState(response, firstRunId)?.status === 'streaming',
      'first run admission state',
    )
    if (runInState(firstAdmission, firstRunId)?.status !== 'streaming')
      throw new Error('packed RPC first send did not reach streaming state')

    const unavailable = await request(
      {
        version: 1,
        requestId: 'req-unavailable',
        operationId: 'op-rpc-steer-000001',
        command: 'steer',
        params: { runId: firstRunId, text: 'steer from package proof' },
      },
      (response) => response.type === 'ack',
      'unavailable steer response',
    )
    if (
      unavailable.type !== 'error' ||
      unavailable.code !== 'CAPABILITY_UNAVAILABLE' ||
      !/steering.*supported by this run/u.test(unavailable.message ?? '')
    ) {
      throw new Error('packed RPC deterministic steering capability changed behavior')
    }

    const firstTerminal = await nextResponse(
      (response) =>
        response.type === 'state' &&
        response.requestId === 'req-send' &&
        runInState(response, firstRunId)?.status === 'completed',
      'first run completion state',
    )
    const firstState = firstTerminal.state

    const graphAck = await request(
      { version: 1, requestId: 'req-graph', command: 'get_graph', params: {} },
      (response) => response.type === 'ack',
      'graph acknowledgement',
    )
    if (
      graphAck.type !== 'ack' ||
      !Array.isArray(graphAck.result?.nodes) ||
      !graphAck.result.nodes.some((node) => node?.type === 'conversation')
    ) {
      throw new Error('packed RPC graph command did not return the semantic graph')
    }

    const retryAck = await request(
      {
        version: 1,
        requestId: 'req-retry',
        operationId: 'op-rpc-000001',
        command: 'send',
        params: {
          conversationId: 'conv-1',
          branchId: 'branch-1',
          text: 'hello from package proof',
        },
      },
      (response) => response.type === 'ack',
      'idempotent retry acknowledgement',
    )
    if (retryAck.type !== 'ack' || retryAck.replayed !== true)
      throw new Error('packed RPC retry did not replay the operation')

    const cancelSend = await request(
      {
        version: 1,
        requestId: 'req-cancel-send',
        operationId: 'op-rpc-cancel-send',
        command: 'send',
        params: { text: 'cancel from package proof' },
      },
      (response) => response.type === 'ack',
      'cancellation send acknowledgement',
    )
    if (cancelSend.type !== 'ack' || typeof cancelSend.runId !== 'string')
      throw new Error('packed RPC cancellation send lacked its admitted run identifier')
    const cancelRunId = cancelSend.runId
    const cancelAdmission = await nextResponse(
      (response) =>
        response.type === 'state' &&
        response.requestId === 'req-cancel-send' &&
        runInState(response, cancelRunId)?.status === 'streaming',
      'cancellation run admission state',
    )
    if (runInState(cancelAdmission, cancelRunId)?.status !== 'streaming')
      throw new Error('packed RPC cancellation run was not active before cancel')

    const cancelAck = await request(
      {
        version: 1,
        requestId: 'req-cancel',
        operationId: 'op-rpc-cancel',
        command: 'cancel_run',
        params: { runId: cancelRunId, reason: 'package proof cancellation' },
      },
      (response) => response.type === 'ack',
      'cancel acknowledgement',
    )
    if (cancelAck.type !== 'ack' || cancelAck.runId !== cancelRunId)
      throw new Error('packed RPC cancel acknowledgement targeted the wrong run')

    const cancelTerminal = await nextResponse(
      (response) =>
        response.type === 'state' &&
        response.requestId === 'req-cancel' &&
        runInState(response, cancelRunId)?.status === 'aborted',
      'cancellation terminal state',
    )
    if (runInState(cancelTerminal, cancelRunId)?.status !== 'aborted')
      throw new Error('packed RPC cancel did not abort the admitted run')

    const shutdownAck = await request(
      {
        version: 1,
        requestId: 'req-stop',
        operationId: 'op-rpc-shutdown',
        command: 'shutdown',
      },
      (response) => response.type === 'ack',
      'shutdown acknowledgement',
    )
    if (shutdownAck.type !== 'ack' || shutdownAck.operationId !== 'op-rpc-shutdown')
      throw new Error('packed RPC shutdown was not operation-bound')

    child.stdin.end()
    const exit = await waitForChildExit(5_000)
    if (!exit) throw new Error('packed RPC did not exit after shutdown')
    if (exit.error) throw new Error(`packed RPC failed to start: ${exit.error.message}`)
    if (streamFailure) throw new Error(`packed RPC stream failed: ${streamFailure.message}`)
    if (exit.code !== 0) throw new Error(`packed RPC exited ${String(exit.code)} after shutdown`)
    if (stderr) throw new Error(`packed RPC wrote stderr: ${stderr}`)

    const state = cancelTerminal.state
    const events = allResponses
      .filter((response) => response.type === 'event')
      .map((response) => response.event)
    const baselineEvents = events.slice(0, baselineEventEnd(events))
    return {
      responses: allResponses,
      state,
      firstState,
      events,
      baselineEvents,
      stderr,
      flows: ['send', 'graph', 'unavailable', 'retry', 'cancel', 'shutdown'],
    }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await waitForChildExit(1_000)
    if (stderr && error instanceof Error && !error.message.includes(stderr))
      error.message += `\npacked RPC stderr: ${stderr}`
    throw error
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
  await waitFor(() => !normalizedScreen().includes('conversation graph'), 'closed terminal graph')
  const retryPrompt = 'retry from package proof'
  const retryResponse = `Fixture response through pi: ${retryPrompt}`
  session.write(retryPrompt)
  session.write('\r')
  await waitFor(
    () => normalizedScreen().includes('working') || normalizedScreen().includes(retryResponse),
    'terminal retry start',
  )
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
    () => normalizedScreen().includes(retryResponse) && !normalizedScreen().includes('working'),
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
