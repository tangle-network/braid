#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const fixture = process.argv.includes('--fixture')
const workspace = resolve(process.env.BRAID_WORKSPACE ?? process.cwd())
const binary = process.env.BRAID_BIN ?? 'braid'
const pollIntervalMs = 1_000
const rpcTimeoutMs = 30_000
const cleanupTimeoutMs = 10_000
const shutdownTimeoutMs = 5_000
const terminalStatuses = new Set([
  'completed',
  'failed',
  'aborted',
  'blocked',
  'cancelled',
  'expired',
  'unknown',
])
const safePriorTerminalStatuses = new Set([
  'completed',
  'failed',
  'aborted',
  'blocked',
  'cancelled',
  'expired',
])

function configuredTimeout() {
  const configured = process.env.BRAID_FIRST_TASK_TIMEOUT_MS
  if (configured === undefined) return 5 * 60_000
  const timeout = Number(configured)
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60 * 60_000) {
    throw new Error('BRAID_FIRST_TASK_TIMEOUT_MS must be an integer from 1 to 3600000')
  }
  return timeout
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function operationId() {
  return `op-${randomUUID()}`
}

function publicInteraction(interaction) {
  return {
    interactionId: interaction.interactionId,
    kind: interaction.kind,
    prompt: interaction.secret ? '[secret input is hidden]' : interaction.prompt,
    allowedOutcomes: interaction.allowedOutcomes,
    secret: interaction.secret,
  }
}

function terminalResult(state, run, warning) {
  const output = state.messages
    .filter((message) => message.runId === run.id && message.role === 'assistant')
    .map((message) => message.text)
    .filter(Boolean)
    .join('\n')
  const completed = run.status === 'completed' && output.length > 0
  return {
    status: completed ? 'completed' : run.status === 'completed' ? 'missing_output' : run.status,
    runId: run.id,
    ...(completed ? { output } : {}),
    ...(run.error === undefined ? {} : { error: run.error }),
    ...(run.status === 'completed' && output.length === 0
      ? { error: 'The completed run had no public assistant output in its full state.' }
      : {}),
    ...(warning === undefined ? {} : { warning }),
  }
}

function existingWork(state, view) {
  if (!Array.isArray(state.runs) || !Array.isArray(state.queue)) {
    return { reason: 'The full state did not report runs and queues.' }
  }
  const viewQueue = Array.isArray(view.queue) ? view.queue : []
  const unresolvedRuns = state.runs.filter((run) => !safePriorTerminalStatuses.has(run.status))
  if (
    state.activeRunId !== null ||
    (state.activeRuns?.length ?? 0) > 0 ||
    state.queue.length > 0 ||
    viewQueue.length > 0 ||
    unresolvedRuns.length > 0
  ) {
    return {
      reason: 'Existing queued, active, detached, or unknown work is present; no task was sent.',
      activeRunIds: [
        ...(state.activeRunId === null ? [] : [state.activeRunId]),
        ...(state.activeRuns ?? []).map((item) => item.runId),
        ...unresolvedRuns.map((run) => run.id),
      ],
      queueCount: Math.max(state.queue.length, viewQueue.length),
    }
  }
  return undefined
}

async function main() {
  let timeoutMs
  try {
    timeoutMs = configuredTimeout()
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'not_started', error: error.message })}\n`)
    process.exitCode = 1
    return
  }
  const fixtureDirectory = fixture
    ? await mkdtemp(join(tmpdir(), 'braid-rpc-first-task-'))
    : undefined
  const child = spawn(binary, ['rpc', ...(fixture ? ['--fixture', 'deterministic'] : [])], {
    cwd: workspace,
    env: {
      ...process.env,
      ...(fixtureDirectory === undefined
        ? {}
        : { BRAID_JOURNAL_PATH: join(fixtureDirectory, 'journal.jsonl') }),
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const queued = []
  const waiters = []
  let outputClosed = false
  let inputFailure
  let spawnFailure
  let initialized = false
  let shutdownAcknowledged = false
  let mayShutdownWait = false
  let runId
  let sendOperationId
  let sendAttempted = false
  let latestState
  let outcome
  let exitCode = 1

  const childExit = new Promise((resolveExit) => {
    child.once('error', (error) => {
      spawnFailure = error
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
      failWaiters(new Error(`Braid wrote a non-JSONL line: ${line.slice(0, 240)}`))
      return
    }
    const index = waiters.findIndex((waiter) => waiter.matches(response))
    if (index === -1) {
      queued.push(response)
      return
    }
    const [waiter] = waiters.splice(index, 1)
    clearTimeout(waiter.timer)
    waiter.resolve(response)
  })

  lines.on('close', () => {
    outputClosed = true
    failWaiters(new Error('Braid RPC closed its output before the requested response'))
  })

  child.stdin.on('error', (error) => {
    inputFailure = error
    failWaiters(new Error(`Braid RPC input closed: ${error.message}`))
  })

  function nextResponse(matches, timeoutMsForResponse = rpcTimeoutMs) {
    const index = queued.findIndex(matches)
    if (index !== -1) return Promise.resolve(queued.splice(index, 1)[0])
    if (outputClosed) return Promise.reject(new Error('Braid RPC output is closed'))
    if (inputFailure)
      return Promise.reject(new Error(`Braid RPC input closed: ${inputFailure.message}`))
    return new Promise((resolveResponse, rejectResponse) => {
      const waiter = { matches, resolve: resolveResponse, reject: rejectResponse, timer: undefined }
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter)
        if (index !== -1) waiters.splice(index, 1)
        rejectResponse(
          new Error(`Timed out after ${timeoutMsForResponse} ms waiting for Braid RPC`),
        )
      }, timeoutMsForResponse)
      waiters.push(waiter)
    })
  }

  async function command(name, params = {}, mutationId, isDone, commandTimeoutMs = rpcTimeoutMs) {
    const requestId = `req-${randomUUID()}`
    const request = {
      version: 1,
      requestId,
      command: name,
      ...(mutationId === undefined ? {} : { operationId: mutationId }),
      params,
    }
    const responsePromise = nextResponse(
      (item) => item.requestId === requestId && (item.type === 'error' || isDone(item)),
      commandTimeoutMs,
    )
    try {
      if (inputFailure) throw inputFailure
      child.stdin.write(`${JSON.stringify(request)}\n`)
    } catch (error) {
      failWaiters(error)
      throw error
    }
    const response = await responsePromise
    if (response.type === 'error') {
      throw new Error(`${response.code}: ${response.message}`)
    }
    return { requestId, response }
  }

  async function fullState(timeout = rpcTimeoutMs) {
    const result = await command(
      'get_state',
      { projection: 'full' },
      undefined,
      (response) => response.type === 'state',
      timeout,
    )
    if (result.response.type !== 'state' || result.response.projection !== 'full') {
      throw new Error('get_state did not return a full state snapshot')
    }
    latestState = result.response
    return result.response
  }

  async function disposeOnlyThisRun(action, reason) {
    let outcome = 'not_acknowledged'
    if (!latestState?.state?.runs?.some((run) => run.id === runId)) {
      try {
        await fullState(Math.min(cleanupTimeoutMs, rpcTimeoutMs))
      } catch {
        // A bounded refresh may fail; never guess that a capability is available.
      }
    }
    const capabilityName = action === 'detach' ? 'run.detach' : 'run.cancel'
    const capability = latestState?.view?.capabilities?.[capabilityName]
    if (!capability?.available) {
      return {
        action: 'not_requested',
        reason: capability?.reason ?? `${capabilityName} capability was not reported as available`,
        confirmed: false,
        runStatus: latestState?.state?.runs?.find((run) => run.id === runId)?.status,
      }
    }
    try {
      const result = await command(
        action,
        action === 'detach' ? { runId } : { runId, reason },
        operationId(),
        (response) => response.type === 'ack',
        cleanupTimeoutMs,
      )
      outcome = result.response.outcome ?? 'unknown'
      const deadline = Date.now() + cleanupTimeoutMs
      let stateResponse = latestState
      if (action === 'detach') {
        try {
          const completion = await nextResponse(
            (response) => response.requestId === result.requestId && response.type === 'state',
            Math.max(1, deadline - Date.now()),
          )
          if (completion.type === 'state' && completion.projection === 'full') {
            stateResponse = completion
            latestState = completion
          }
        } catch {
          // The bounded state read below determines whether the run detached.
        }
      }
      while (Date.now() < deadline) {
        const run = stateResponse?.state.runs.find((item) => item.id === runId)
        const confirmed =
          action === 'detach'
            ? run?.status === 'detached'
            : run !== undefined && safePriorTerminalStatuses.has(run.status)
        if (run && confirmed) {
          latestState = stateResponse
          return { action, outcome, confirmed: true, runStatus: run.status }
        }
        await delay(Math.min(250, deadline - Date.now()))
        stateResponse = await fullState(Math.max(1, deadline - Date.now()))
      }
      const finalRun = latestState?.state.runs.find((item) => item.id === runId)
      return {
        action,
        outcome,
        confirmed: false,
        runStatus: finalRun?.status ?? 'unreported',
      }
    } catch (error) {
      return {
        action,
        outcome,
        confirmed: false,
        error: error instanceof Error ? error.message : String(error),
        runStatus: latestState?.state?.runs?.find((run) => run.id === runId)?.status,
      }
    }
  }

  async function preserveInteractionRun() {
    const detached = await disposeOnlyThisRun('detach')
    if (detached.confirmed) return detached
    const cancelled = await disposeOnlyThisRun(
      'cancel',
      'The first-task example does not answer interactions.',
    )
    return { ...cancelled, detachAttempt: detached }
  }

  async function requestShutdownWait() {
    if (!initialized || shutdownAcknowledged || child.exitCode !== null) return
    try {
      const result = await command(
        'shutdown',
        { mode: 'wait' },
        operationId(),
        (response) => response.type === 'ack',
        shutdownTimeoutMs,
      )
      shutdownAcknowledged = result.response.type === 'ack'
    } catch (error) {
      process.stderr.write(`Braid shutdown wait was not acknowledged: ${error.message}\n`)
    }
  }

  async function waitForChildExit(timeoutMs) {
    let timer
    const timeout = new Promise((resolveExit) => {
      timer = setTimeout(() => resolveExit(undefined), timeoutMs)
    })
    const result = await Promise.race([childExit, timeout])
    clearTimeout(timer)
    return result
  }

  async function stopLocalRpc() {
    if (shutdownAcknowledged) child.stdin.end()
    else if (child.exitCode === null && child.signalCode === null) {
      // Do not close stdin: EOF invokes the RPC process's configured cancel default.
      child.kill('SIGKILL')
    }
    const exited = await waitForChildExit(3_000)
    if (exited === undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await waitForChildExit(1_000)
    }
  }

  try {
    const initializedResult = await command(
      'initialize',
      { workspace, subscribe: false },
      undefined,
      (response) => response.type === 'state',
    )
    if (
      initializedResult.response.type !== 'state' ||
      initializedResult.response.projection !== 'full'
    ) {
      throw new Error('initialize did not return a full state snapshot')
    }
    initialized = true
    mayShutdownWait = true

    const ready = await fullState()
    const { state, view } = ready
    const priorWork = existingWork(state, view)
    if (priorWork !== undefined) {
      outcome = { status: 'not_started', ...priorWork }
    } else {
      const sendCapability = view.capabilities['run.send']
      if (!sendCapability?.available) {
        outcome = {
          status: 'not_started',
          reason:
            sendCapability?.reason ??
            'run.send capability was not reported. Configure a supported profile and connection first.',
        }
      } else if (!state.conversationId || !state.branchId) {
        outcome = {
          status: 'not_started',
          reason: 'The ready state lacked conversation or branch IDs.',
        }
      } else {
        process.stderr.write(`Ready: ${view.profileName} · ${view.runner} · ${view.connection}\n`)
        sendOperationId = operationId()
        sendAttempted = true
        const sent = await command(
          'send',
          {
            conversationId: state.conversationId,
            branchId: state.branchId,
            text:
              process.env.BRAID_FIRST_TASK ??
              'Summarize the current workspace and suggest one next step.',
          },
          sendOperationId,
          (response) => response.type === 'ack',
        )
        if (sent.response.type !== 'ack' || !sent.response.runId) {
          throw new Error('send was not acknowledged with a run identifier')
        }
        runId = sent.response.runId
        process.stderr.write(`Accepted run ${runId}; waiting up to ${timeoutMs} ms.\n`)

        const deadline = Date.now() + timeoutMs
        let waitState
        let interaction
        let waitingWithoutInteraction = false
        while (Date.now() < deadline) {
          waitState = await fullState(Math.max(1, deadline - Date.now()))
          const run = waitState.state.runs.find((item) => item.id === runId)
          interaction = waitState.view.interactions.find((item) => item.runId === runId)
          if (interaction !== undefined) break
          if (run?.status === 'waiting') {
            waitingWithoutInteraction = true
            break
          }
          if (run && terminalStatuses.has(run.status)) break
          await delay(Math.min(pollIntervalMs, deadline - Date.now()))
        }

        const finalRun = latestState?.state.runs.find((item) => item.id === runId)
        if (interaction !== undefined || waitingWithoutInteraction) {
          const cleanup = await preserveInteractionRun()
          mayShutdownWait = cleanup.confirmed
          outcome = {
            status: 'needs_input',
            runId,
            ...(interaction === undefined
              ? { action: 'The run is waiting, but no public interaction was reported.' }
              : {
                  action:
                    'Resolve this request through Braid. Reconnect only when a fresh full state advertises run.reconnect.',
                  interaction: publicInteraction(interaction),
                }),
            cleanup,
          }
        } else if (finalRun && terminalStatuses.has(finalRun.status)) {
          mayShutdownWait = true
          outcome = terminalResult(latestState.state, finalRun)
        } else {
          const cleanup = await disposeOnlyThisRun('cancel', 'The first-task example timed out.')
          mayShutdownWait = true
          outcome = { status: 'timed_out', runId, timeoutMs, cleanup }
        }
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    if (runId === undefined && sendAttempted && sendOperationId !== undefined) {
      try {
        const recovered = await fullState(2_000)
        const acceptedRun = recovered.state.runs.find((run) => run.operationId === sendOperationId)
        if (acceptedRun !== undefined) runId = acceptedRun.id
      } catch {
        // The operation ID remains the only safe lookup after an ambiguous send response.
      }
    }
    if (runId !== undefined) {
      const run = latestState?.state.runs.find((item) => item.id === runId)
      if (run !== undefined && terminalStatuses.has(run.status)) {
        outcome = terminalResult(latestState.state, run, errorMessage)
      } else {
        const cleanup = await disposeOnlyThisRun(
          'cancel',
          'The first-task example stopped after an RPC error.',
        )
        mayShutdownWait = true
        outcome = {
          status: sendAttempted ? 'submission_unknown' : 'error',
          runId,
          ...(sendOperationId === undefined ? {} : { operationId: sendOperationId }),
          error: errorMessage,
          cleanup,
        }
      }
    } else if (sendAttempted) {
      outcome = {
        status: 'submission_unknown',
        ...(sendOperationId === undefined ? {} : { operationId: sendOperationId }),
        error: `The send response failed and no run could be matched to its operation ID: ${errorMessage}`,
      }
    } else {
      const message =
        spawnFailure?.code === 'ENOENT'
          ? `Could not start Braid binary "${binary}". Install Braid or set BRAID_BIN to its executable path.`
          : errorMessage
      outcome = { status: 'not_started', error: message }
    }
  } finally {
    if (initialized && mayShutdownWait) await requestShutdownWait()
    await stopLocalRpc()
    if (fixtureDirectory !== undefined) {
      await rm(fixtureDirectory, { force: true, recursive: true })
    }
  }

  const result = {
    ...outcome,
    ...(initialized ? { shutdownAcknowledged } : {}),
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (result.status === 'completed' && shutdownAcknowledged) exitCode = 0
  process.exitCode = exitCode
}

await main()
