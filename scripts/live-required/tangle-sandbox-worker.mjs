import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Sandbox } from '@tangle-network/sandbox'

const DEFAULT_SANDBOX_ENDPOINT = 'https://sandbox.tangle.tools'
const DEFAULT_MODEL_ENDPOINT = 'https://router.tangle.tools/v1'
const DEFAULT_MODEL = 'glm-5.2'
const DEFAULT_MODEL_PROVIDER = 'openai-compat'

function argument(name, argv = process.argv) {
  const index = argv.indexOf(`--${name}`)
  if (index === -1 || index + 1 >= argv.length) return undefined
  return argv[index + 1]
}

function requiredArgument(name, argv = process.argv) {
  const value = argument(name, argv)
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing --${name}`)
  return value
}

function requiredEnvironment(name, fallbacks = [], environment = process.env) {
  for (const candidate of [name, ...fallbacks]) {
    const value = environment[candidate]?.trim()
    if (value) return value
  }
  throw new Error(`Missing ${name}`)
}

function clientConfiguration(environment = process.env) {
  return {
    baseUrl: environment.BRAID_TANGLE_SANDBOX_ENDPOINT?.trim() || DEFAULT_SANDBOX_ENDPOINT,
    apiKey: requiredEnvironment('BRAID_TANGLE_SANDBOX_API_KEY', ['TANGLE_API_KEY'], environment),
  }
}

function backendConfiguration(environment = process.env) {
  const provider = environment.BRAID_TANGLE_SANDBOX_MODEL_PROVIDER?.trim() || DEFAULT_MODEL_PROVIDER
  const model = environment.BRAID_TANGLE_SANDBOX_MODEL?.trim() || DEFAULT_MODEL
  const baseUrl = environment.BRAID_TANGLE_SANDBOX_MODEL_ENDPOINT?.trim() || DEFAULT_MODEL_ENDPOINT
  const apiKey = requiredEnvironment(
    'BRAID_TANGLE_SANDBOX_MODEL_API_KEY',
    ['TANGLE_API_KEY'],
    environment,
  )
  return {
    type: environment.BRAID_TANGLE_SANDBOX_RUNNER?.trim() || 'opencode',
    profile: {
      name: 'braid-cloud-proof',
      harness: 'opencode',
      model: { provider: 'tangle-router', default: `tangle-router/${model}` },
    },
    model: { provider, model, baseUrl, apiKey },
  }
}

function writeRecord(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`)
}

function eventExecutionId(event) {
  const candidate = event?.executionId ?? event?.data?.executionId
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined
}

function waitForLine(expected, inputStream = process.stdin) {
  const input = createInterface({ input: inputStream })
  return new Promise((resolve, reject) => {
    const close = () => reject(new Error(`stdin closed before ${expected}`))
    input.once('close', close)
    input.on('line', (line) => {
      if (line !== expected) return
      input.off('close', close)
      input.close()
      resolve()
    })
  })
}

function waitUntilKilled() {
  return new Promise(() => undefined)
}

async function createAndDispatch({
  argv = process.argv,
  environment = process.env,
  client: suppliedClient,
  write = writeRecord,
  inputStream = process.stdin,
} = {}) {
  const proofId = requiredArgument('proof-id', argv)
  const sessionId = requiredArgument('session-id', argv)
  const turnId = requiredArgument('turn-id', argv)
  const marker = requiredArgument('marker', argv)
  const client = suppliedClient ?? new Sandbox(clientConfiguration(environment))
  const backend = backendConfiguration(environment)
  const started = performance.now()
  const box = await client.create({
    name: proofId,
    environment: 'universal',
    idempotencyKey: proofId,
    maxLifetimeSeconds: 600,
    metadata: { owner: 'braid-live-proof', proofId },
    backend,
  })
  const createdMs = performance.now() - started

  const workspaceStarted = performance.now()
  const markerPath = '/tmp/braid-cloud-proof.txt'
  await box.write(markerPath, `${marker}\n`)
  const readBack = await box.read(markerPath)
  const git = await box.exec(
    'set -eu; mkdir -p /tmp/braid-cloud-git; cd /tmp/braid-cloud-git; git init -q; git config user.email braid@local; git config user.name Braid; cp /tmp/braid-cloud-proof.txt proof.txt; git add proof.txt; git commit -qm proof; git rev-parse --verify HEAD',
  )
  const resourceUsage = await box.resourceUsage().catch(() => null)
  await box.createSession({ sessionId, title: 'Braid durability proof', backend })
  write({
    type: 'created',
    pid: process.pid,
    proofId,
    environmentId: box.id,
    sessionId,
    turnId,
    marker,
    createdMs,
    workspaceMs: performance.now() - workspaceStarted,
    workspace: {
      readMatched: readBack === `${marker}\n`,
      gitExitCode: git.exitCode,
      gitCommit: git.stdout.trim(),
      resourceUsageReported: resourceUsage !== null,
      runtimeEndpointReported: Boolean(box.connection?.runtimeUrl),
      machineIdReported: Boolean(box.machineId),
      regionReported: Boolean(box.region),
    },
  })

  await waitForLine('dispatch', inputStream)
  const prompt = promptFor(marker)
  const dispatchStarted = performance.now()
  const dispatched = await box.dispatchPrompt(prompt, {
    sessionId,
    turnId,
    timeoutMs: 180_000,
  })
  if (typeof dispatched.executionId !== 'string' || dispatched.executionId.length === 0)
    throw new Error('Sandbox dispatch returned no execution ID')
  write({
    type: 'admitted',
    pid: process.pid,
    environmentId: box.id,
    sessionId: dispatched.sessionId,
    executionId: dispatched.executionId,
    turnId,
    marker,
    prompt,
    dispatchMs: performance.now() - dispatchStarted,
    dispatched: dispatched.dispatched,
    alreadyExisted: dispatched.alreadyExisted,
  })
  await waitUntilKilled()
}

async function watchFirstEvent({
  argv = process.argv,
  environment = process.env,
  client: suppliedClient,
  write = writeRecord,
} = {}) {
  const client = suppliedClient ?? new Sandbox(clientConfiguration(environment))
  const environmentId = requiredArgument('environment-id', argv)
  const sessionId = requiredArgument('session-id', argv)
  const box = await client.get(environmentId)
  if (!box) throw new Error(`Sandbox ${environmentId} was not found`)
  write({ type: 'listening', pid: process.pid, environmentId, sessionId })
  for await (const event of box.session(sessionId).events()) {
    if (typeof event.id !== 'string' || event.id.length === 0) continue
    const executionId = eventExecutionId(event)
    write({
      type: 'cursor',
      pid: process.pid,
      environmentId,
      sessionId,
      eventId: event.id,
      eventType: event.type,
      ...(executionId ? { executionId } : {}),
    })
    await waitUntilKilled()
  }
  throw new Error('Session event stream ended before a stable event ID arrived')
}

export async function resumeRun({
  argv = process.argv,
  environment = process.env,
  client: suppliedClient,
  write = writeRecord,
} = {}) {
  const client = suppliedClient ?? new Sandbox(clientConfiguration(environment))
  const environmentId = requiredArgument('environment-id', argv)
  const sessionId = requiredArgument('session-id', argv)
  const executionId = requiredArgument('execution-id', argv)
  const turnId = requiredArgument('turn-id', argv)
  const marker = requiredArgument('marker', argv)
  const cursor = requiredArgument('cursor', argv)
  const box = await client.get(environmentId)
  if (!box) throw new Error(`Sandbox ${environmentId} was not found`)
  const reconnectStarted = performance.now()
  const session = box.session(sessionId)
  const replay = []
  for await (const event of session.events({ since: cursor, executionId })) {
    if (typeof event.id === 'string' && event.id.length > 0) {
      const eventExecution = eventExecutionId(event)
      replay.push({
        id: event.id,
        type: event.type,
        ...(eventExecution ? { executionId: eventExecution } : {}),
      })
    }
  }
  const result = await session.result({ executionId })
  const status = await session.status()
  const completedTurn = await box.findCompletedTurn(turnId, { sessionId })
  const messages = await box.messages({ sessionId, limit: 100 })
  const duplicate = await box.dispatchPrompt(promptFor(marker), {
    sessionId,
    turnId,
    timeoutMs: 180_000,
  })
  let duplicateCancellation = null
  if (duplicate.dispatched && duplicate.executionId && duplicate.executionId !== executionId) {
    duplicateCancellation = await session.interrupt({
      executionId: duplicate.executionId,
    })
  }
  const readBack = await box.read('/tmp/braid-cloud-proof.txt')
  const duplicateExecutionId =
    typeof duplicate.executionId === 'string' && duplicate.executionId.length > 0
      ? duplicate.executionId
      : null
  write({
    type: 'resumed',
    pid: process.pid,
    environmentId,
    sessionId,
    executionId,
    reconnectToResultMs: performance.now() - reconnectStarted,
    replay,
    cursorWasInclusive: replay[0]?.id === cursor,
    result: {
      status: result.status,
      executionId: result.executionId,
      markerMatched: typeof result.response === 'string' && result.response.trim() === marker,
      usage: result.usage ?? null,
      costUsd: result.costUsd ?? null,
    },
    sessionStatus: status?.status ?? null,
    completedTurn: {
      found: completedTurn !== null,
      executionId:
        typeof completedTurn?.result?.executionId === 'string'
          ? completedTurn.result.executionId
          : null,
    },
    messageStates: messages.map((message) => ({
      role: message.role,
      status: message.metadata?.status ?? null,
      completed: message.metadata?.completed ?? null,
      interrupted: message.metadata?.interrupted ?? null,
      turnId: message.metadata?.turnId ?? null,
    })),
    duplicate: {
      dispatched: duplicate.dispatched,
      executionId: duplicateExecutionId,
      sameExecution: duplicateExecutionId === executionId,
      alreadyExisted: duplicate.alreadyExisted === true,
      cancellation: duplicateCancellation,
    },
    workspaceRetained: readBack === `${marker}\n`,
  })
}

export async function cancelRun({
  argv = process.argv,
  environment = process.env,
  client: suppliedClient,
  write = writeRecord,
} = {}) {
  const client = suppliedClient ?? new Sandbox(clientConfiguration(environment))
  const environmentId = requiredArgument('environment-id', argv)
  const sessionId = requiredArgument('session-id', argv)
  const executionId = requiredArgument('execution-id', argv)
  const box = await client.get(environmentId)
  if (!box) throw new Error(`Sandbox ${environmentId} was not found`)
  const session = box.session(sessionId)
  const first = await session.interrupt({ executionId })
  const second = await session.interrupt({ executionId })
  const status = await session.status()
  if (typeof first?.cancelled !== 'boolean' || typeof second?.cancelled !== 'boolean')
    throw new Error('Cancellation returned an invalid acknowledgement')
  write({
    type: 'cancelled',
    pid: process.pid,
    environmentId,
    sessionId,
    executionId,
    first,
    second,
    replayDetected: first.cancelled === true && second.cancelled === false,
    sessionStatus: status?.status ?? null,
  })
}

export function promptFor(marker) {
  return `Read /tmp/braid-cloud-proof.txt with a tool. Run sleep 8 in the shell. Then reply with exactly ${marker}.`
}

export async function runWorker(mode, options = {}) {
  if (mode === 'dispatch') return createAndDispatch(options)
  if (mode === 'watch') return watchFirstEvent(options)
  if (mode === 'resume') return resumeRun(options)
  if (mode === 'cancel') return cancelRun(options)
  throw new Error(`Unknown worker mode ${String(mode)}`)
}

function invokedDirectly() {
  return (
    process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  )
}

if (invokedDirectly()) {
  runWorker(process.argv[2]).catch((error) => {
    writeRecord({
      type: 'error',
      pid: process.pid,
      message: error instanceof Error ? error.message : String(error),
    })
    process.exitCode = 1
  })
}
