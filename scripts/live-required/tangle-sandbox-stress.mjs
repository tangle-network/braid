import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { Sandbox } from '@tangle-network/sandbox'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const workerPath = resolve(scriptDirectory, 'tangle-sandbox-worker.mjs')
const DEFAULT_SANDBOX_ENDPOINT = 'https://sandbox.tangle.tools'
const DEFAULT_TIMEOUT_MS = 240_000
const CLEANUP_PAGE_SIZE = 100
export const PROOF_OWNER = 'braid-live-proof'

function argument(name) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1 || index + 1 >= process.argv.length) return undefined
  return process.argv[index + 1]
}

function requiredEnvironment(name, fallbacks = []) {
  for (const candidate of [name, ...fallbacks]) {
    const value = process.env[candidate]?.trim()
    if (value) return value
  }
  throw new Error(`Missing ${name}`)
}

function clientConfiguration() {
  return {
    baseUrl: process.env.BRAID_TANGLE_SANDBOX_ENDPOINT?.trim() || DEFAULT_SANDBOX_ENDPOINT,
    apiKey: requiredEnvironment('BRAID_TANGLE_SANDBOX_API_KEY', ['TANGLE_API_KEY']),
  }
}

function proofCoordinates() {
  const nonce = `${Date.now()}-${process.pid}`
  return {
    proofId: `braid-cloud-stress-${nonce}`,
    sessionId: `braid-session-${nonce}`,
    turnId: `braid-turn-${nonce}`,
    marker: `BRAID_CLOUD_${nonce.replaceAll('-', '_')}`,
  }
}

function errorDetails(error) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function combineErrors(primary, secondary) {
  if (!primary) return secondary
  if (!secondary) return primary
  return new AggregateError(
    [primary, secondary],
    `${errorMessage(primary)}; ${errorMessage(secondary)}`,
  )
}

function exactProofTag(box, proofId) {
  return (
    box?.name === proofId &&
    box.metadata?.owner === PROOF_OWNER &&
    box.metadata?.proofId === proofId
  )
}

export function duplicateTurnDetected(duplicate, executionId) {
  return (
    typeof executionId === 'string' &&
    executionId.length > 0 &&
    duplicate?.dispatched === false &&
    duplicate?.sameExecution === true &&
    duplicate?.alreadyExisted === true &&
    duplicate?.executionId === executionId
  )
}

export function cancellationReplayDetected(cancelled, executionId) {
  return (
    typeof executionId === 'string' &&
    executionId.length > 0 &&
    cancelled?.executionId === executionId &&
    cancelled?.first?.cancelled === true &&
    cancelled?.second?.cancelled === false &&
    cancelled?.sessionStatus === 'cancelled'
  )
}

export function assertExactResumeEvidence(resumed, { executionId, cursorEventId }) {
  assert.equal(resumed.result.status, 'success', 'replayed result did not succeed')
  assert.equal(resumed.executionId, executionId, 'resume record execution ID changed during replay')
  assert.equal(
    resumed.result.executionId,
    executionId,
    'resume result execution ID changed during replay',
  )
  assert.equal(resumed.result.markerMatched, true, 'replayed result marker changed')
  assert.equal(resumed.sessionStatus, 'completed', 'replayed session did not complete')
  assert.equal(resumed.completedTurn.found, true, 'completed turn was not retained')
  assert.equal(
    resumed.completedTurn.executionId,
    executionId,
    'completed turn points to a different execution',
  )
  assert.equal(resumed.cursorWasInclusive, true, 'replay did not include the acknowledged cursor')
  assert.ok(Array.isArray(resumed.replay), 'replay did not return an event list')
  assert.ok(resumed.replay.length > 1, 'replay did not return the complete event history')
  assert.equal(resumed.replay[0]?.id, cursorEventId, 'replay started at the wrong event')
  assert.equal(
    new Set(resumed.replay.map((event) => event.id)).size,
    resumed.replay.length,
    'replay returned a duplicate event ID',
  )
  assert.ok(
    resumed.replay.every(
      (event) =>
        typeof event.id === 'string' &&
        event.id.length > 0 &&
        typeof event.type === 'string' &&
        event.type.length > 0,
    ),
    'replay returned an incomplete event record',
  )
  assert.ok(
    resumed.replay.every(
      (event) => event.executionId === undefined || event.executionId === executionId,
    ),
    'replay included a different execution',
  )
}

function spawnWorker(mode, values = {}) {
  const args = [workerPath, mode]
  for (const [name, value] of Object.entries(values)) args.push(`--${name}`, value)
  const child = spawn(process.execPath, args, {
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const records = []
  const waiters = new Set()
  const stderr = []
  const output = createInterface({ input: child.stdout })
  const errors = createInterface({ input: child.stderr })

  output.on('line', (line) => {
    let record
    try {
      record = JSON.parse(line)
    } catch {
      record = { type: 'invalid-output', line }
    }
    records.push(record)
    for (const waiter of waiters) waiter(record)
  })
  errors.on('line', (line) => {
    if (stderr.length < 20) stderr.push(line)
  })

  return { child, records, waiters, stderr }
}

function waitForRecord(worker, type, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const prior = worker.records.find((record) => record.type === type)
  if (prior) return Promise.resolve(prior)
  const priorError = worker.records.find((record) => record.type === 'error')
  if (priorError) return Promise.reject(new Error(priorError.message))
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const finish = (operation) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      worker.waiters.delete(onRecord)
      worker.child.off('exit', onExit)
      operation()
    }
    const onRecord = (record) => {
      if (record.type === type) finish(() => resolvePromise(record))
      if (record.type === 'error') finish(() => rejectPromise(new Error(record.message)))
    }
    const onExit = (code, signal) =>
      finish(() =>
        rejectPromise(
          new Error(
            `Worker exited before ${type}: code=${String(code)} signal=${String(signal)} stderr=${worker.stderr.join(' | ')}`,
          ),
        ),
      )
    const timeout = setTimeout(
      () =>
        finish(() => {
          worker.child.kill('SIGKILL')
          rejectPromise(new Error(`Worker timed out waiting for ${type}`))
        }),
      timeoutMs,
    )
    worker.waiters.add(onRecord)
    worker.child.once('exit', onExit)
  })
}

function knownExit(child) {
  if (child.exitCode !== null || child.signalCode !== null)
    return { code: child.exitCode, signal: child.signalCode }
  return null
}

function waitForExit(child) {
  return new Promise((resolvePromise) => {
    const onExit = (code, signal) => {
      child.off('exit', onExit)
      resolvePromise({ code, signal })
    }
    child.once('exit', onExit)
    const existing = knownExit(child)
    if (existing) {
      child.off('exit', onExit)
      resolvePromise(existing)
    }
  })
}

async function stopWorker(worker) {
  const existing = knownExit(worker.child)
  if (existing) return existing
  const exit = waitForExit(worker.child)
  if (!knownExit(worker.child)) worker.child.kill('SIGKILL')
  return exit
}

async function waitForWorkerExit(worker) {
  return waitForExit(worker.child)
}

async function listAllSandboxes(client) {
  const boxes = []
  const seenIds = new Set()
  let offset = 0
  for (;;) {
    const page = await client.list({ limit: CLEANUP_PAGE_SIZE, offset })
    if (!Array.isArray(page)) throw new Error('Sandbox list returned an invalid page')
    for (const box of page) {
      if (typeof box?.id === 'string') {
        if (seenIds.has(box.id)) throw new Error(`Sandbox list repeated ${box.id}`)
        seenIds.add(box.id)
      }
      boxes.push(box)
    }
    if (page.length < CLEANUP_PAGE_SIZE) return boxes
    offset += page.length
  }
}

function numericDifference(after, before, key) {
  const left = after?.[key]
  const right = before?.[key]
  return typeof left === 'number' && typeof right === 'number' ? left - right : null
}

export async function cleanupProof(client, proofId, knownEnvironmentId) {
  const candidates = []
  if (knownEnvironmentId) {
    const known = await client.get(knownEnvironmentId).catch(() => null)
    if (known) {
      if (!exactProofTag(known, proofId))
        throw new Error(`Refusing to delete sandbox ${known.id} without exact proof ownership`)
      candidates.push(known)
    }
  }
  const knownIds = new Set(candidates.map((box) => box.id))
  const listed = await listAllSandboxes(client)
  candidates.push(...listed.filter((box) => exactProofTag(box, proofId) && !knownIds.has(box.id)))
  for (const box of candidates) {
    if (!exactProofTag(box, proofId))
      throw new Error(`Refusing to delete sandbox ${box.id} without exact proof ownership`)
    await box.delete()
  }
  const remaining = await listAllSandboxes(client)
  return !remaining.some((box) => exactProofTag(box, proofId))
}

function failureOutcome({
  coordinates,
  environmentId,
  outcome,
  state,
  failure,
  cleanupError,
  cleanupConfirmed,
  usageBefore,
  usageAfter,
}) {
  return {
    ...(outcome ?? {
      schemaVersion: 'braid.tangle-sandbox-stress.v1',
      proofId: coordinates.proofId,
    }),
    status: 'failed',
    proofId: coordinates.proofId,
    ...(environmentId ? { environmentId } : {}),
    failure: errorDetails(failure ?? cleanupError),
    ...(cleanupError ? { cleanupFailure: errorDetails(cleanupError) } : {}),
    cleanupConfirmed,
    phase: state.failurePhase ?? state.phase,
    progress: {
      created: state.created ?? null,
      admitted: state.admitted ?? null,
      cursor: state.cursor ?? null,
      dispatcherDeath: state.dispatcherDeath ?? null,
      watcherDeath: state.watcherDeath ?? null,
      resumed: state.resumed ?? null,
      cancelled: state.cancelled ?? null,
    },
    accountDelta: {
      activeSandboxes: numericDifference(usageAfter, usageBefore, 'activeSandboxes'),
      totalSandboxes: numericDifference(usageAfter, usageBefore, 'totalSandboxes'),
      computeMinutes: numericDifference(usageAfter, usageBefore, 'computeMinutes'),
      gpuSeconds: numericDifference(usageAfter, usageBefore, 'gpuSeconds'),
      gpuCostUsd: numericDifference(usageAfter, usageBefore, 'gpuCostUsd'),
    },
  }
}

export async function writeProofArtifact(outputPath, proof) {
  const absolute = resolve(outputPath)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 })
}

export async function runStressProof({
  client: suppliedClient,
  coordinates = proofCoordinates(),
  workerFactory = spawnWorker,
  outputPath,
  writeArtifact = writeProofArtifact,
} = {}) {
  const client = suppliedClient ?? new Sandbox(clientConfiguration())
  const activeWorkers = new Set()
  const state = { phase: 'usage-before' }
  let usageBefore
  let usageAfter
  let environmentId
  let cleanupConfirmed = false
  let outcome
  let failure
  let cleanupError
  let artifactError
  let finalProof

  try {
    usageBefore = await client.usage()
    state.phase = 'dispatch-create'
    const dispatcher = workerFactory('dispatch', {
      'proof-id': coordinates.proofId,
      'session-id': coordinates.sessionId,
      'turn-id': coordinates.turnId,
      marker: coordinates.marker,
    })
    activeWorkers.add(dispatcher)
    const created = await waitForRecord(dispatcher, 'created')
    state.created = created
    environmentId = created.environmentId
    assert.equal(created.workspace.readMatched, true)
    assert.equal(created.workspace.gitExitCode, 0)
    assert.match(created.workspace.gitCommit, /^[0-9a-f]{40}$/u)

    state.phase = 'watch-create'
    const watcher = workerFactory('watch', {
      'environment-id': environmentId,
      'session-id': coordinates.sessionId,
    })
    activeWorkers.add(watcher)
    await waitForRecord(watcher, 'listening')
    state.phase = 'dispatch'
    dispatcher.child.stdin.write('dispatch\n')
    const admittedPromise = waitForRecord(dispatcher, 'admitted').then((record) => {
      state.admitted = record
      return record
    })
    const cursorPromise = waitForRecord(watcher, 'cursor').then((record) => {
      state.cursor = record
      return record
    })
    const [admitted, cursor] = await Promise.all([admittedPromise, cursorPromise])
    assert.equal(admitted.dispatched, true)
    if (cursor.executionId !== undefined)
      assert.equal(
        cursor.executionId,
        admitted.executionId,
        'cursor points to a different execution',
      )

    state.phase = 'kill-dispatcher'
    const dispatcherDeath = await stopWorker(dispatcher)
    state.dispatcherDeath = dispatcherDeath
    state.phase = 'kill-watcher'
    const watcherDeath = await stopWorker(watcher)
    state.watcherDeath = watcherDeath
    activeWorkers.delete(dispatcher)
    activeWorkers.delete(watcher)
    assert.equal(dispatcherDeath.signal, 'SIGKILL')
    assert.equal(watcherDeath.signal, 'SIGKILL')

    state.phase = 'resume'
    const resumedWorker = workerFactory('resume', {
      'environment-id': environmentId,
      'session-id': coordinates.sessionId,
      'execution-id': admitted.executionId,
      'turn-id': coordinates.turnId,
      marker: coordinates.marker,
      cursor: cursor.eventId,
    })
    activeWorkers.add(resumedWorker)
    const resumed = await waitForRecord(resumedWorker, 'resumed')
    state.resumed = resumed
    const resumedExit = await waitForWorkerExit(resumedWorker)
    activeWorkers.delete(resumedWorker)
    assert.equal(resumedExit.code, 0)
    assertExactResumeEvidence(resumed, {
      executionId: admitted.executionId,
      cursorEventId: cursor.eventId,
    })
    assert.equal(resumed.workspaceRetained, true)

    state.phase = 'cancellation-dispatch'
    const recovered = await client.get(environmentId)
    if (!recovered) throw new Error('Sandbox disappeared before cancellation proof')
    const cancelSessionId = `${coordinates.sessionId}-cancel`
    const cancelTurnId = `${coordinates.turnId}-cancel`
    const cancelDispatch = await recovered.dispatchPrompt(
      'Run sleep 120 in the shell. After it exits, reply with exactly CANCEL_MISSED.',
      { sessionId: cancelSessionId, turnId: cancelTurnId, timeoutMs: 180_000 },
    )
    state.cancelDispatch = cancelDispatch
    if (typeof cancelDispatch.executionId !== 'string' || cancelDispatch.executionId.length === 0)
      throw new Error('Cancellation dispatch returned no execution ID')
    state.phase = 'cancel'
    const cancelWorker = workerFactory('cancel', {
      'environment-id': environmentId,
      'session-id': cancelSessionId,
      'execution-id': cancelDispatch.executionId,
    })
    activeWorkers.add(cancelWorker)
    const cancelled = await waitForRecord(cancelWorker, 'cancelled')
    state.cancelled = cancelled
    const cancelExit = await waitForWorkerExit(cancelWorker)
    activeWorkers.delete(cancelWorker)
    assert.equal(cancelExit.code, 0)
    assert.equal(cancelled.first.cancelled, true)

    state.phase = 'complete'
    const sameExecution = resumed.duplicate.sameExecution === true
    const duplicateReplay = duplicateTurnDetected(resumed.duplicate, admitted.executionId)
    const cancellationReplay = cancellationReplayDetected(cancelled, cancelDispatch.executionId)
    const gaps = [
      ...(!sameExecution ? ['turn-idempotency'] : []),
      ...(sameExecution && (!duplicateReplay || resumed.duplicate.dispatched)
        ? ['turn-idempotency-receipt']
        : []),
      ...(!cancellationReplay ? ['cancellation-operation-replay'] : []),
    ]
    outcome = {
      schemaVersion: 'braid.tangle-sandbox-stress.v1',
      status: gaps.length === 0 ? 'passed' : 'passed-with-gaps',
      gaps,
      proofId: coordinates.proofId,
      environmentId,
      exactRun: {
        sessionId: coordinates.sessionId,
        executionId: admitted.executionId,
        turnId: coordinates.turnId,
      },
      checks: {
        created: true,
        workspaceReadWriteExecGit: true,
        resourceUsageReported: created.workspace.resourceUsageReported,
        processKilledAfterDispatch: dispatcherDeath.signal === 'SIGKILL',
        processKilledAfterCursor: watcherDeath.signal === 'SIGKILL',
        freshProcessReplay: true,
        exactResultIdentity: true,
        turnIdempotency: duplicateReplay,
        turnIdempotencyReceipt: duplicateReplay && resumed.duplicate.dispatched === false,
        workspaceRetained: true,
        exactCancellation: cancelled.first.cancelled === true,
        cancellationOperationReplay: cancellationReplay,
      },
      timingsMs: {
        create: created.createdMs,
        workspace: created.workspaceMs,
        dispatchAdmission: admitted.dispatchMs,
        reconnectToResult: resumed.reconnectToResultMs,
      },
      events: {
        firstObservedId: cursor.eventId,
        firstObservedType: cursor.eventType,
        replayCount: resumed.replay.length,
        replayUniqueCount: new Set(resumed.replay.map((event) => event.id)).size,
        providerCursorInclusive: resumed.cursorWasInclusive,
      },
      usage: resumed.result.usage,
      costUsd: resumed.result.costUsd,
      idempotency: {
        completedTurn: resumed.completedTurn,
        duplicate: resumed.duplicate,
        messageStates: resumed.messageStates,
      },
      cancellation: {
        executionId: cancelDispatch.executionId,
        first: cancelled.first,
        second: cancelled.second,
        sessionStatus: cancelled.sessionStatus,
      },
      observation: created.workspace,
    }
  } catch (error) {
    failure = error
    state.failurePhase = state.phase
  } finally {
    for (const worker of activeWorkers) {
      try {
        await stopWorker(worker)
      } catch (error) {
        cleanupError = combineErrors(cleanupError, error)
      }
    }
    state.phase = 'cleanup-sandbox'
    try {
      cleanupConfirmed = await cleanupProof(client, coordinates.proofId, environmentId)
    } catch (error) {
      cleanupError = combineErrors(cleanupError, error)
    }
    state.phase = 'usage-after'
    try {
      usageAfter = await client.usage()
    } catch (error) {
      cleanupError = combineErrors(cleanupError, error)
    }
    if (!cleanupError) {
      try {
        assert.equal(cleanupConfirmed, true)
      } catch (error) {
        cleanupError = error
      }
    }
    const finalError = combineErrors(failure, cleanupError)
    finalProof = finalError
      ? failureOutcome({
          coordinates,
          environmentId,
          outcome,
          state,
          failure: finalError,
          cleanupError,
          cleanupConfirmed,
          usageBefore,
          usageAfter,
        })
      : {
          ...outcome,
          cleanupConfirmed,
          accountDelta: {
            activeSandboxes: numericDifference(usageAfter, usageBefore, 'activeSandboxes'),
            totalSandboxes: numericDifference(usageAfter, usageBefore, 'totalSandboxes'),
            computeMinutes: numericDifference(usageAfter, usageBefore, 'computeMinutes'),
            gpuSeconds: numericDifference(usageAfter, usageBefore, 'gpuSeconds'),
            gpuCostUsd: numericDifference(usageAfter, usageBefore, 'gpuCostUsd'),
          },
        }
    if (outputPath) {
      try {
        await writeArtifact(outputPath, finalProof)
      } catch (error) {
        artifactError = error
      }
    }
  }

  const finalError = combineErrors(combineErrors(failure, cleanupError), artifactError)
  if (finalError) throw finalError
  return finalProof
}

function invokedDirectly() {
  return (
    process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  )
}

if (invokedDirectly()) {
  const proof = await runStressProof({ outputPath: argument('output') })
  process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`)
}
