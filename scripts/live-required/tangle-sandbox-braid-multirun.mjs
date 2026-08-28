import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AgentExactRunControlRefSchema } from '@tangle-network/agent-interface'
import { Sandbox } from '@tangle-network/sandbox'
import xterm from '@xterm/headless'
import * as pty from 'node-pty'

import { sendTreeSignal, waitForTreeGone } from '../live-bridge/process-tree.mjs'
import { pause } from '../live-demo/terminal.mjs'
import { connectionConfiguration } from './configuration.mjs'
import { safeJson, safeMessage } from './contracts.mjs'
import { configEvidence, prepareProductionWorkspace, resolveBinary } from './headless.mjs'
import { MULTIRUN_PROOF_SCHEMA } from './multirun-contract.mjs'
import {
  cleanupRetainedResourceByControlRef,
  observeRetainedResource,
} from './tangle-sandbox-braid-stress.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const repository = resolve(dirname(scriptPath), '../..')
const DEFAULT_TIMEOUT_MS = 300_000
const DEFAULT_HOLD_SECONDS = 180
const DEFAULT_COLUMNS = 120
const DEFAULT_ROWS = 40
const TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'aborted',
  'cancelled',
  'expired',
  'blocked',
  'unknown',
])
const SECRET_ENVIRONMENT_NAMES = [
  'BRAID_ANALYSIS_AUTH',
  'BRAID_ANALYSIS_API_KEY',
  'BRAID_ANALYSIS_BEARER',
  'BRAID_CLI_BRIDGE_AUTH',
  'BRAID_CLI_BRIDGE_BEARER',
  'BRAID_TANGLE_AUTH',
  'BRAID_TANGLE_API_KEY',
  'BRAID_TANGLE_BEARER',
  'BRAID_TANGLE_SANDBOX_AUTH',
  'BRAID_TANGLE_SANDBOX_API_KEY',
  'BRAID_TANGLE_SANDBOX_BEARER',
  'TANGLE_API_KEY',
]

function argument(name, argv = process.argv) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined
}

function positiveEnvironment(environment, name, fallback) {
  const value = Number(environment[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function configurationEnvironment(environment) {
  if (
    !environment.BRAID_TANGLE_SANDBOX_CREDENTIAL_REF &&
    !environment.BRAID_TANGLE_SANDBOX_AUTH &&
    !environment.BRAID_TANGLE_SANDBOX_API_KEY &&
    !environment.BRAID_TANGLE_SANDBOX_BEARER &&
    environment.TANGLE_API_KEY
  ) {
    return { ...environment, BRAID_TANGLE_SANDBOX_API_KEY: environment.TANGLE_API_KEY }
  }
  return environment
}

function sanitizedEnvironment(environment) {
  const child = { ...environment }
  for (const name of SECRET_ENVIRONMENT_NAMES) delete child[name]
  return child
}

function sandboxConfiguration(environment) {
  return connectionConfiguration(configurationEnvironment(environment), {
    prefix: 'BRAID_TANGLE_SANDBOX',
    kind: 'tangle-sandbox',
    endpointNames: ['BRAID_TANGLE_ENDPOINT'],
    modelNames: ['BRAID_TANGLE_MODEL'],
    runnerNames: ['BRAID_TANGLE_RUNNER'],
    providerNames: ['BRAID_TANGLE_SANDBOX_PROVIDER'],
    fallbackEndpoint: 'https://sandbox.tangle.tools',
    fallbackModel: 'tangle-router/glm-5.2',
    fallbackRunner: 'opencode',
    fallbackProvider: 'tangle',
  })
}

function proofId() {
  return `braid-multirun-${Date.now()}-${randomUUID().replaceAll('-', '')}`
}

function markerFor(proof, label) {
  return `BRAID_MULTIRUN_${proof}_${label}`.toUpperCase()
}

function promptFor(marker, holdSeconds) {
  return [
    'Use the current Tangle Sandbox working directory for every command in this turn.',
    `Write exactly ${marker} followed by a newline to .braid-live/${marker}/marker.txt.`,
    `Read .braid-live/${marker}/marker.txt and print the result.`,
    'Run git -C . rev-parse --is-inside-work-tree and print its result.',
    `Run sleep ${holdSeconds} before the final response so another branch can stream concurrently.`,
    `Reply with exactly ${marker}.`,
  ].join(' ')
}

function screenFrom(terminal) {
  let text = ''
  for (let row = 0; row < terminal.rows; row += 1) {
    text += terminal.buffer.active.getLine(row)?.translateToString(true) ?? ''
    text += '\n'
  }
  return text
}

export function terminalRecordPath(basePath, instance) {
  if (!Number.isSafeInteger(instance) || instance < 0) {
    throw new Error('Terminal record instance must be a non-negative safe integer')
  }
  return instance === 0 ? basePath : `${basePath}.restart-${instance}`
}

function normalizeScreen(screen) {
  return screen.replace(/\s+/gu, ' ').trim()
}

const TRANSCRIPT_FOOTER = 'type / for commands ·'

function createTerminal(
  binary,
  config,
  recordPath,
  columns = DEFAULT_COLUMNS,
  rows = DEFAULT_ROWS,
) {
  const terminal = new xterm.Terminal({
    cols: columns,
    rows,
    disableStdin: true,
    allowProposedApi: true,
  })
  const environment = {
    ...config.environment,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    BRAID_SHUTDOWN_MODE: 'cancel',
    NO_COLOR: '1',
    NODE_NO_WARNINGS: '1',
  }
  for (const name of SECRET_ENVIRONMENT_NAMES) delete environment[name]
  const child = pty.spawn(process.execPath, [binary, '--inline', '--record-state', recordPath], {
    cwd: config.workspace,
    env: environment,
    name: 'xterm-256color',
    cols: columns,
    rows,
  })
  let output = ''
  let exited = false
  let exitResult
  let pendingWrites = 0
  let lastOutputAt = performance.now()
  let lastFrame
  let lastFrameError
  let processCleanup
  const exitPromise = new Promise((resolveExit) => {
    child.onExit((result) => {
      exited = true
      exitResult = result
      resolveExit(result)
    })
  })
  child.onData((data) => {
    output += data
    lastOutputAt = performance.now()
    pendingWrites += 1
    terminal.write(data, () => {
      pendingWrites -= 1
    })
  })
  const waitForStable = async (timeoutMs = 10_000) => {
    const deadline = performance.now() + timeoutMs
    for (;;) {
      if (pendingWrites === 0 && performance.now() - lastOutputAt >= 100) return
      if (performance.now() >= deadline) throw new Error('terminal output did not become stable')
      await pause(25)
    }
  }
  const captureState = async (timeoutMs = 10_000) => {
    // A live provider can keep writing stream frames without a quiet interval.
    // Signal the recorder after a short drain window instead of waiting for the full phase timeout.
    await waitForStable(Math.min(timeoutMs, 1_000)).catch(() => undefined)
    if (exited)
      throw new Error(
        `Braid exited before semantic frame capture (${exitResult?.exitCode ?? 'unknown'})`,
      )
    let previousMtime
    try {
      previousMtime = (await stat(`${recordPath}.frame`)).mtimeNs
    } catch {}
    process.kill(child.pid, 'SIGUSR2')
    const deadline = performance.now() + timeoutMs
    for (;;) {
      try {
        const framePath = `${recordPath}.frame`
        const metadata = await stat(framePath)
        if (previousMtime === undefined || metadata.mtimeNs !== previousMtime) {
          const frame = JSON.parse(await readFile(framePath, 'utf8'))
          lastFrame = frame
          lastFrameError = undefined
          return frame
        }
      } catch (error) {
        lastFrameError = safeMessage(error, config.environment)
      }
      if (performance.now() >= deadline) throw new Error('semantic terminal frame was not recorded')
      await pause(25)
    }
  }
  const close = async () => {
    if (exited) return { ...exitResult, processCleanup: await waitForTreeGone(child, 10_000) }
    for (let layer = 0; layer < 4; layer += 1) {
      child.write('\u001b')
      await pause(250)
      await waitForStable()
    }
    child.write('\u0003')
    const deadline = performance.now() + 10_000
    while (!normalizeScreen(screenFrom(terminal)).includes('Ctrl+C again to quit')) {
      if (performance.now() >= deadline) throw new Error('safe quit prompt was not rendered')
      await pause(25)
    }
    child.write('\u0003')
    const result = await Promise.race([
      exitPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Braid did not exit')), 15_000)),
    ])
    processCleanup = await waitForTreeGone(child, 10_000)
    return { ...result, processCleanup }
  }
  const dispose = async () => {
    if (!exited) {
      await sendTreeSignal(child, 'SIGTERM')
      await Promise.race([exitPromise, pause(1_000)])
      if (!exited) {
        await sendTreeSignal(child, 'SIGKILL')
        await Promise.race([exitPromise, pause(5_000)])
      }
    }
    processCleanup ??= await waitForTreeGone(child, 10_000)
    terminal.dispose()
    return processCleanup
  }
  return {
    child,
    columns,
    rows,
    input(value) {
      child.write(value)
    },
    get exited() {
      return exited
    },
    get output() {
      return output
    },
    get lastFrame() {
      return lastFrame
    },
    get lastFrameError() {
      return lastFrameError
    },
    screen: () => screenFrom(terminal),
    snapshot: () => ({ screen: screenFrom(terminal), outputBytes: Buffer.byteLength(output) }),
    captureState,
    close,
    dispose,
  }
}

/** Preserve the last terminal evidence when a live phase fails. */
export function terminalFailureEvidence(runtime) {
  return {
    ...runtime.snapshot(),
    exited: runtime.exited,
    outputTail: runtime.output.slice(-20_000),
    latestFrame: runtime.lastFrame ?? null,
    latestFrameError: runtime.lastFrameError ?? null,
  }
}

async function waitFor(label, predicate, timeoutMs) {
  const deadline = performance.now() + timeoutMs
  let lastError
  for (;;) {
    try {
      const value = await predicate()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    if (performance.now() >= deadline) {
      throw new Error(
        `${label} timed out after ${timeoutMs}ms${lastError instanceof Error ? `: ${lastError.message}` : ''}`,
      )
    }
    await pause(100)
  }
}

export function activityBrowserOpen(screen) {
  return typeof screen === 'string' && screen.split('\n').some((line) => /^\s*runs ›/u.test(line))
}

export function transcriptSurfaceReady(screen) {
  return (
    typeof screen === 'string' && !activityBrowserOpen(screen) && screen.includes(TRANSCRIPT_FOOTER)
  )
}

export async function waitForActivityBrowserDismissal(runtime, label, timeoutMs) {
  return waitFor(
    `${label} activity browser dismissal`,
    () => transcriptSurfaceReady(runtime.screen()),
    timeoutMs,
  )
}

export async function sendCancellationAfterActivityBrowserDismissal(runtime, label, timeoutMs) {
  if (!transcriptSurfaceReady(runtime.screen())) {
    runtime.input('\u001b')
    await waitForActivityBrowserDismissal(runtime, label, timeoutMs)
  }
  runtime.input('\u0003')
}

async function typeAndSubmit(runtime, value) {
  for (const character of value) {
    runtime.input(character)
    await pause(2)
  }
  runtime.input('\r')
}

async function waitForFrame(runtime, label, predicate, timeoutMs) {
  return waitFor(
    label,
    async () => {
      const frame = await runtime.captureState(timeoutMs)
      return predicate(frame) ? frame : undefined
    },
    timeoutMs,
  )
}

function exactControlRef(value, label) {
  const parsed = AgentExactRunControlRefSchema.safeParse(value)
  assert.ok(parsed.success, `${label} is not an exact provider control reference`)
  return parsed.data
}

function runFromFrame(frame, runId) {
  const stateRun = frame.state?.runs?.find((run) => run.id === runId)
  const viewRun = frame.view?.runs?.find((run) => run.id === runId)
  if (!stateRun || !viewRun) throw new Error(`frame omitted run ${runId}`)
  return { stateRun, viewRun }
}

function eventIdsForRun(frame, runId) {
  const activityIds = (frame?.view?.activity ?? [])
    .filter((item) => item.runId === runId && typeof item.sourceEventId === 'string')
    .map((item) => item.sourceEventId)
  const partIds = (frame?.view?.messages ?? [])
    .filter((message) => message.runId === runId)
    .flatMap((message) => message.parts ?? [])
    .map((part) => part.sourceEventId)
    .filter((value) => typeof value === 'string')
  return [...activityIds, ...partIds]
}

function runStatus(frame, runId) {
  return runFromFrame(frame, runId).stateRun.status
}

function isActive(status) {
  return !TERMINAL_STATUSES.has(status)
}

function assertUniqueEventIds(frame, runId, phase) {
  const ids = eventIdsForRun(frame, runId)
  assert.ok(ids.length > 0, `${phase} did not expose provider event identities for ${runId}`)
  assert.equal(ids.length, new Set(ids).size, `${phase} duplicated provider events for ${runId}`)
  return [...new Set(ids)]
}

function identifiersForControl(controlRef) {
  return [
    { kind: 'provider-environment', id: controlRef.environmentId },
    { kind: 'provider-session', id: controlRef.sessionId },
    { kind: 'provider-execution', id: controlRef.executionId },
    { kind: 'provider-run', id: controlRef.runId },
  ]
}

async function accountSnapshot(client, phase) {
  const [identity, usage, resources] = await Promise.all([
    client.getIdentity(),
    client.usage(),
    listBraidResources(client),
  ])
  const customerId = identity?.customerId
  const billingOwnerId = identity?.billingOwnerId
  assert.equal(typeof customerId, 'string', `${phase} account identity omitted customerId`)
  assert.equal(typeof billingOwnerId, 'string', `${phase} account identity omitted billingOwnerId`)
  const identityDigest = createHash('sha256')
    .update(`${customerId}:${billingOwnerId}`)
    .digest('hex')
  return {
    phase,
    identityDigest,
    usage: {
      activeSandboxes: usage.activeSandboxes ?? null,
      totalSandboxes: usage.totalSandboxes ?? null,
      computeMinutes: usage.computeMinutes ?? null,
      gpuSeconds: usage.gpuSeconds ?? null,
      gpuCostUsd: usage.gpuCostUsd ?? null,
    },
    resources,
  }
}

async function listBraidResources(client) {
  const page = await client.list({ limit: 100, offset: 0 })
  assert.ok(Array.isArray(page), 'Sandbox list returned an invalid page')
  return page
    .filter((box) => box?.metadata?.owner === 'braid' && box.metadata?.lifecycle === 'retained')
    .map((box) => ({
      id: box.id,
      providerSessionId: box.metadata?.providerSessionId ?? null,
      displayName: box.metadata?.displayName ?? null,
      createdAt: box.createdAt ?? null,
    }))
}

async function remoteStatus(client, controlRef, expectedStatus, timeoutMs) {
  const box = await client.get(controlRef.environmentId)
  assert.ok(box, `provider environment ${controlRef.environmentId} was not found`)
  const session = box.session(controlRef.sessionId)
  return waitFor(
    `remote ${expectedStatus} status`,
    async () => {
      const status = await session.status()
      assert.equal(status.latestExecutionId, controlRef.executionId)
      assert.equal(status.runControlRef?.executionId, controlRef.executionId)
      return status.status === expectedStatus ? status : undefined
    },
    timeoutMs,
  )
}

async function writeArtifact(path, result, environment) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${safeJson(result, environment)}\n`, { mode: 0o600 })
}

export function frameRunIds(frame) {
  return (frame.view?.runs ?? []).map((run) => run.id)
}

export function frameEventIds(frame, runId) {
  return eventIdsForRun(frame, runId)
}

function eventKind(event) {
  return event?.kind ?? event?.event?.kind ?? event?.type
}

function eventPayload(event) {
  if (event?.payload !== undefined) return event.payload
  if (event?.event?.payload !== undefined) return event.event.payload
  return event?.event ?? event
}

function eventRunId(event) {
  return event?.runId ?? eventPayload(event)?.runId
}

function eventOperationId(event) {
  const payload = eventPayload(event)
  return (
    event?.operationId ??
    payload?.operationId ??
    payload?.value?.operationId ??
    payload?.control?.operationId
  )
}

function eventControl(event) {
  const payload = eventPayload(event)
  if (typeof payload?.control === 'string') return payload.control
  return payload?.value?.control ?? payload?.control?.control
}

export function frameCancellationDispatch(frame, runId) {
  const event = (Array.isArray(frame?.events) ? frame.events : []).find((candidate) => {
    const payload = eventPayload(candidate)
    return (
      eventKind(candidate) === 'run.control.requested' &&
      eventRunId(candidate) === runId &&
      eventControl(candidate) === 'cancel' &&
      typeof eventOperationId(candidate) === 'string' &&
      eventOperationId(candidate).length > 0
    )
  })
  if (event === undefined) return undefined
  return {
    eventKind: eventKind(event),
    control: eventControl(event),
    runId: eventRunId(event),
    operationId: eventOperationId(event),
    sequence: event?.sequence ?? event?.event?.sequence ?? null,
  }
}

export function cancellationDispatchVisible(frame, unaffectedRunId, targetRunId) {
  const dispatch = frameCancellationDispatch(frame, targetRunId)
  if (dispatch === undefined) return false
  const targetStatus = runStatus(frame, targetRunId)
  return (
    isActive(runStatus(frame, unaffectedRunId)) &&
    (isActive(targetStatus) || ['aborted', 'cancelled'].includes(targetStatus))
  )
}

export function assertSuccessfulTerminalExit(exit, label) {
  assert.equal(exit?.exitCode, 0, `${label} Braid terminal process exited with a non-zero status`)
}

export function renderedWorkStripCount(screen) {
  return screen
    .split('\n')
    .filter((line) => /^[·›] .+ · [^/\s]+\/[^\s]+ · \d+ interactions?/u.test(line.trimStart()))
    .length
}

export function assertFrameHasConcurrentRuns(frame, runIds) {
  assert.equal(runIds.length, 2, 'concurrent proof requires exactly two run ids')
  for (const runId of runIds) {
    assert.ok(frameRunIds(frame).includes(runId), `frame omitted concurrent run ${runId}`)
    assert.ok(isActive(runStatus(frame, runId)), `run ${runId} is not active`)
    assert.ok(eventIdsForRun(frame, runId).length > 0, `run ${runId} has no streamed events`)
  }
  const activeOwnership = frame.state?.activeRuns?.filter((entry) => runIds.includes(entry.runId))
  assert.equal(activeOwnership?.length, 2, 'frame did not expose two active run ownership records')
  const workStrip = frame.view?.workStrip?.filter((entry) => runIds.includes(entry.runId))
  assert.equal(workStrip?.length, 2, 'frame did not project both runs into the work strip')
  return true
}

export async function runProof({
  targetRepository = process.env.BRAID_LIVE_REPOSITORY ?? repository,
  environment = process.env,
  outputPath: suppliedOutputPath,
} = {}) {
  const startedAt = new Date().toISOString()
  const startedClock = performance.now()
  const timeoutMs = positiveEnvironment(
    environment,
    'BRAID_TANGLE_SANDBOX_MULTI_RUN_TIMEOUT_MS',
    DEFAULT_TIMEOUT_MS,
  )
  const holdSeconds = Math.max(
    20,
    Math.floor(
      positiveEnvironment(
        environment,
        'BRAID_TANGLE_SANDBOX_MULTI_RUN_HOLD_SECONDS',
        DEFAULT_HOLD_SECONDS,
      ),
    ),
  )
  const values = sandboxConfiguration(environment)
  assert.equal(values.runner, 'opencode', 'multi-run proof uses the proven OpenCode harness')
  assert.ok(values.credentialValue, 'multi-run proof needs a raw Sandbox credential for cleanup')
  const proof = proofId()
  const markerA = markerFor(proof, 'A')
  const markerB = markerFor(proof, 'B')
  const outputPath =
    suppliedOutputPath ??
    argument('output') ??
    environment.BRAID_TANGLE_SANDBOX_MULTI_RUN_EVIDENCE ??
    environment.BRAID_LIVE_TANGLE_EVIDENCE ??
    join(
      targetRepository,
      'artifacts',
      'verification',
      'live',
      `tangle-sandbox-braid-multirun-production-${Date.now()}.json`,
    )
  const phases = {}
  const identifiers = []
  const terminalEvidence = {}
  const timings = {}
  const controls = new Map()
  const runIds = new Set()
  let config
  let client
  let runtime
  let restarted
  let firstFrame
  let secondFrame
  let focusAFrame
  let focusBFrame
  let cancelDispatchFrame
  let cancelDispatch
  let cancelFrame
  let finalFrame
  let restartedFrame
  let runAId
  let runBId
  let proofError
  const cleanup = {
    resources: [],
    errors: [],
    exact: false,
    activeResourceDelta: null,
    accountStable: false,
  }
  let beforeAccount
  let afterAccount

  const phase = async (name, operation) => {
    const start = performance.now()
    try {
      const value = await operation()
      phases[name] = { status: 'passed', elapsedMs: performance.now() - start }
      timings[name] = performance.now() - start
      return value
    } catch (error) {
      phases[name] = {
        status: 'failed',
        elapsedMs: performance.now() - start,
        error: safeMessage(error, environment),
      }
      timings[name] = performance.now() - start
      throw error
    }
  }

  try {
    client = new Sandbox({ baseUrl: values.endpoint, apiKey: values.credentialValue })
    beforeAccount = await phase('account.before', () => accountSnapshot(client, 'before'))
    const binary = await phase('binary.resolve', () => resolveBinary(targetRepository, environment))
    config = await phase('workspace.prepare', () =>
      prepareProductionWorkspace({
        repository: targetRepository,
        environment: sanitizedEnvironment(configurationEnvironment(environment)),
        kind: values.kind,
        endpoint: values.endpoint,
        model: values.model,
        runner: values.runner,
        provider: values.provider,
        providerOptions: { lifecycle: 'retained', idleTtlSeconds: 1_800 },
        credentialRef: values.credentialRef,
        credentialValue: values.credentialValue,
      }),
    )
    const recordPath = join(config.root, 'multirun-state.json')
    runtime = createTerminal(binary, config, terminalRecordPath(recordPath, 0))
    await phase('terminal.start', () =>
      waitFor('Braid terminal startup', () => /Braid/iu.test(runtime.screen()), timeoutMs),
    )
    firstFrame = await runtime.captureState(timeoutMs)
    const firstConversation = firstFrame.state.conversationId
    const firstBranch = firstFrame.state.branchId
    await phase('branch-a.send', async () => {
      await typeAndSubmit(runtime, promptFor(markerA, holdSeconds))
      firstFrame = await waitForFrame(
        runtime,
        'branch A admission',
        (frame) =>
          frame.view.runs.length >= 1 &&
          frame.view.runs.some((run) => {
            if (run.conversationId !== firstConversation || !isActive(run.status)) return false
            try {
              exactControlRef(runFromFrame(frame, run.id).stateRun.controlRef, 'branch A control')
              return true
            } catch {
              return false
            }
          }),
        timeoutMs,
      )
    })
    const runAView = firstFrame.view.runs.find(
      (run) => run.conversationId === firstConversation && isActive(run.status),
    )
    assert.ok(runAView, 'branch A did not expose an active run')
    runAId = runAView.id
    runIds.add(runAId)
    const runARecord = runFromFrame(firstFrame, runAId)
    const controlA = exactControlRef(runARecord.stateRun.controlRef, 'branch A control')
    controls.set(runAId, controlA)
    identifiers.push(...identifiersForControl(controlA))
    await phase('branch-a.stream', async () => {
      firstFrame = await waitForFrame(
        runtime,
        'branch A stream',
        (frame) => eventIdsForRun(frame, runAId).length > 0 && isActive(runStatus(frame, runAId)),
        timeoutMs,
      )
      assertUniqueEventIds(firstFrame, runAId, 'branch A stream')
    })
    await phase('conversation-b.create', async () => {
      await typeAndSubmit(runtime, `/new ${markerB} conversation`)
      secondFrame = await waitForFrame(
        runtime,
        'conversation B creation',
        (frame) =>
          frame.view.conversations.length >= 2 && frame.state.conversationId !== firstConversation,
        timeoutMs,
      )
    })
    const secondConversation = secondFrame.state.conversationId
    const secondBranch = secondFrame.state.branchId
    assert.notEqual(
      secondConversation,
      firstConversation,
      'the proof did not create an independent conversation',
    )
    assert.notEqual(secondBranch, firstBranch, 'independent conversations reused the branch id')
    await phase('branch-b.send', async () => {
      await typeAndSubmit(runtime, promptFor(markerB, holdSeconds))
      secondFrame = await waitForFrame(
        runtime,
        'branch B admission',
        (frame) =>
          frame.view.runs.some((run) => {
            if (run.conversationId !== secondConversation || !isActive(run.status)) return false
            try {
              exactControlRef(runFromFrame(frame, run.id).stateRun.controlRef, 'branch B control')
              return true
            } catch {
              return false
            }
          }),
        timeoutMs,
      )
    })
    const runBView = secondFrame.view.runs.find(
      (run) => run.conversationId === secondConversation && isActive(run.status),
    )
    assert.ok(runBView, 'branch B did not expose an active run')
    runBId = runBView.id
    runIds.add(runBId)
    assert.notEqual(runAId, runBId, 'independent conversations reused the local run id')
    const runBRecord = runFromFrame(secondFrame, runBId)
    const controlB = exactControlRef(runBRecord.stateRun.controlRef, 'branch B control')
    controls.set(runBId, controlB)
    identifiers.push(...identifiersForControl(controlB))
    await phase('concurrent.stream', async () => {
      secondFrame = await waitForFrame(
        runtime,
        'two concurrent streams',
        (frame) => {
          try {
            return (
              assertFrameHasConcurrentRuns(frame, [runAId, runBId]) &&
              renderedWorkStripCount(runtime.screen()) >= 2
            )
          } catch {
            return false
          }
        },
        timeoutMs,
      )
      assertUniqueEventIds(secondFrame, runAId, 'concurrent branch A')
      assertUniqueEventIds(secondFrame, runBId, 'concurrent branch B')
    })
    terminalEvidence.concurrent = runtime.snapshot()
    const focusedBefore = secondFrame.view.focusedRunId
    assert.equal(focusedBefore, runBId, 'newly admitted branch B was not foreground')
    await phase('focus-a', async () => {
      runtime.input('\u001bOQ')
      await waitFor('activity browser', () => /activity/iu.test(runtime.screen()), timeoutMs)
      runtime.input('\t')
      await pause(100)
      runtime.input('\u001b[B')
      runtime.input('\r')
      focusAFrame = await waitForFrame(
        runtime,
        'focus branch A',
        (frame) => frame.view.focusedRunId === runAId,
        timeoutMs,
      )
      assertFrameHasConcurrentRuns(focusAFrame, [runAId, runBId])
      assert.ok(isActive(runStatus(focusAFrame, runAId)))
      assert.ok(isActive(runStatus(focusAFrame, runBId)))
      runtime.input('\u001b')
      await waitForActivityBrowserDismissal(runtime, 'focus branch A', timeoutMs)
    })
    terminalEvidence.focusA = runtime.snapshot()
    await phase('focus-b', async () => {
      runtime.input('\u001bOQ')
      await waitFor('activity browser again', () => /activity/iu.test(runtime.screen()), timeoutMs)
      runtime.input('\t')
      await pause(100)
      runtime.input('\u001b[A')
      runtime.input('\r')
      focusBFrame = await waitForFrame(
        runtime,
        'focus branch B',
        (frame) => frame.view.focusedRunId === runBId,
        timeoutMs,
      )
      assertFrameHasConcurrentRuns(focusBFrame, [runAId, runBId])
      runtime.input('\u001b')
      await waitForActivityBrowserDismissal(runtime, 'focus branch B', timeoutMs)
    })
    terminalEvidence.focusB = runtime.snapshot()
    await phase('cancel-b.dispatch', async () => {
      await sendCancellationAfterActivityBrowserDismissal(runtime, 'branch B', timeoutMs)
      cancelDispatchFrame = await waitForFrame(
        runtime,
        'branch B cancellation dispatch',
        (frame) => cancellationDispatchVisible(frame, runAId, runBId),
        timeoutMs,
      )
      cancelDispatch = frameCancellationDispatch(cancelDispatchFrame, runBId)
      assert.ok(cancelDispatch, 'branch B cancellation did not persist its dispatch event')
      terminalEvidence.cancelDispatch = runtime.snapshot()
    })
    await phase('cancel-b', async () => {
      cancelFrame = await waitForFrame(
        runtime,
        'branch B cancellation',
        (frame) =>
          frameCancellationDispatch(frame, runBId)?.operationId === cancelDispatch?.operationId &&
          ['aborted', 'cancelled'].includes(runStatus(frame, runBId)) &&
          isActive(runStatus(frame, runAId)),
        timeoutMs,
      )
      assert.ok(isActive(runStatus(cancelFrame, runAId)), 'cancelling B stopped branch A')
      assertUniqueEventIds(cancelFrame, runAId, 'branch A after branch B cancellation')
      assertUniqueEventIds(cancelFrame, runBId, 'branch B cancellation')
    })
    terminalEvidence.cancel = runtime.snapshot()
    await phase('branch-a.complete', async () => {
      finalFrame = await waitForFrame(
        runtime,
        'branch A completion',
        (frame) =>
          runStatus(frame, runAId) === 'completed' &&
          ['aborted', 'cancelled'].includes(runStatus(frame, runBId)),
        timeoutMs,
      )
      const finalA = runFromFrame(finalFrame, runAId).viewRun
      assert.ok((finalA.contentBytes ?? 0) > 0, 'branch A completed without transcript content')
      assertUniqueEventIds(finalFrame, runAId, 'branch A completion')
      assertUniqueEventIds(finalFrame, runBId, 'branch B terminal state')
    })
    await phase('remote.status', async () => {
      await remoteStatus(client, controlA, 'completed', timeoutMs)
      await remoteStatus(client, controlB, 'cancelled', timeoutMs)
    })
    await phase('terminal.first.close', async () => {
      const exit = await runtime.close()
      assertSuccessfulTerminalExit(exit, 'first')
      await runtime.dispose()
    })
    terminalEvidence.final = runtime.snapshot()
    restarted = createTerminal(binary, config, terminalRecordPath(recordPath, 1))
    await phase('terminal.restart', () =>
      waitFor('restarted Braid terminal', () => /Braid/iu.test(restarted.screen()), timeoutMs),
    )
    restartedFrame = await restarted.captureState(timeoutMs)
    await phase('replay.restart', async () => {
      assert.deepEqual(new Set(frameRunIds(restartedFrame)), new Set([runAId, runBId]))
      for (const runId of [runAId, runBId]) {
        const ids = assertUniqueEventIds(restartedFrame, runId, 'restart replay')
        const prior = new Set(eventIdsForRun(finalFrame, runId))
        assert.deepEqual(
          new Set(ids),
          prior,
          `restart replay changed event identities for ${runId}`,
        )
      }
      assert.equal(
        restartedFrame.state.runs.filter((run) => [runAId, runBId].includes(run.id)).length,
        2,
      )
    })
    terminalEvidence.restart = restarted.snapshot()
    await phase('terminal.restart.close', async () => {
      const exit = await restarted.close()
      assertSuccessfulTerminalExit(exit, 'restarted')
      await restarted.dispose()
    })
    await phase('provider.observe', async () => {
      await observeRetainedResource(client, controlA)
      await observeRetainedResource(client, controlB)
    })
  } catch (error) {
    proofError = error
    if (runtime !== undefined) terminalEvidence.failure = terminalFailureEvidence(runtime)
    if (restarted !== undefined)
      terminalEvidence.restartFailure = terminalFailureEvidence(restarted)
  }

  if (runtime !== undefined && !runtime.exited) {
    await runtime
      .dispose()
      .catch((error) =>
        cleanup.errors.push({ phase: 'terminal.dispose', error: safeMessage(error, environment) }),
      )
  }
  if (restarted !== undefined && !restarted.exited) {
    await restarted.dispose().catch((error) =>
      cleanup.errors.push({
        phase: 'terminal.restart.dispose',
        error: safeMessage(error, environment),
      }),
    )
  }

  for (const [runId, controlRef] of controls) {
    try {
      const result = await cleanupRetainedResourceByControlRef(client, controlRef)
      cleanup.resources.push({
        runId,
        providerEnvironmentId: controlRef.environmentId,
        ...result,
      })
    } catch (error) {
      cleanup.errors.push({
        runId,
        providerEnvironmentId: controlRef.environmentId,
        error: safeMessage(error, environment),
      })
    }
  }
  if (client !== undefined) {
    const baselineIds = new Set((beforeAccount?.resources ?? []).map((resource) => resource.id))
    const cleanedIds = new Set(cleanup.resources.map((resource) => resource.id))
    try {
      const remaining = await listBraidResources(client)
      for (const resource of remaining) {
        if (baselineIds.has(resource.id) || cleanedIds.has(resource.id)) continue
        const box = await client.get(resource.id)
        assert.ok(box, `new Braid resource ${resource.id} disappeared before cleanup`)
        assert.equal(box.metadata?.owner, 'braid')
        assert.equal(box.metadata?.lifecycle, 'retained')
        await box.delete()
        assert.equal(await client.get(resource.id), null)
        cleanup.resources.push({
          runId: null,
          providerEnvironmentId: null,
          id: resource.id,
          discovered: true,
          confirmed: true,
        })
      }
    } catch (error) {
      cleanup.errors.push({
        phase: 'provider.discovery-cleanup',
        error: safeMessage(error, environment),
      })
    }
  }
  if (client !== undefined) {
    try {
      afterAccount = await accountSnapshot(client, 'after')
      cleanup.activeResourceDelta =
        beforeAccount === undefined || afterAccount === undefined
          ? null
          : afterAccount.usage.activeSandboxes - beforeAccount.usage.activeSandboxes
      cleanup.accountStable = afterAccount.identityDigest === beforeAccount?.identityDigest
    } catch (error) {
      cleanup.errors.push({ phase: 'account.after', error: safeMessage(error, environment) })
    }
  }
  if (config !== undefined) {
    try {
      const workspaceCleanup = await config.cleanup()
      cleanup.workspace = workspaceCleanup
    } catch (error) {
      cleanup.errors.push({ phase: 'workspace.cleanup', error: safeMessage(error, environment) })
    }
  }
  cleanup.exact =
    cleanup.resources.length === controls.size &&
    cleanup.resources.every((resource) => resource.confirmed === true) &&
    cleanup.errors.length === 0 &&
    cleanup.activeResourceDelta === 0 &&
    cleanup.accountStable === true &&
    cleanup.workspace?.credentialRemoved === true &&
    cleanup.workspace?.temporaryRootRemoved === true
  const publicCleanup = {
    ...cleanup,
    ...(cleanup.workspace === undefined
      ? {}
      : {
          workspace: {
            protectedStoreClean: cleanup.workspace.credentialRemoved === true,
            temporaryRootRemoved: cleanup.workspace.temporaryRootRemoved === true,
          },
        }),
  }
  const passed =
    proofError === undefined &&
    finalFrame !== undefined &&
    restartedFrame !== undefined &&
    cancelDispatch !== undefined &&
    controls.size === 2 &&
    cleanup.exact === true
  const completedAt = new Date().toISOString()
  const result = {
    schemaVersion: MULTIRUN_PROOF_SCHEMA,
    status: passed ? 'passed' : 'failed',
    proofId: proof,
    startedAt,
    completedAt,
    elapsedMs: performance.now() - startedClock,
    config: config === undefined ? null : configEvidence(config),
    provider: {
      endpoint: values.endpoint,
      runner: values.runner,
      model: values.model,
      lifecycle: 'retained',
      credentialConfigured: Boolean(values.credentialValue || values.credentialRef),
    },
    conversations: {
      first: {
        conversationId: firstFrame?.state?.conversationId ?? null,
        branchId: firstFrame?.state?.branchId ?? null,
      },
      second: {
        conversationId: secondFrame?.state?.conversationId ?? null,
        branchId: secondFrame?.state?.branchId ?? null,
      },
    },
    runs: [...runIds].map((runId) => {
      const frame = finalFrame ?? secondFrame
      const record = frame === undefined ? undefined : runFromFrame(frame, runId)
      const viewRun = record?.viewRun
      const controlRef = controls.get(runId)
      const events = frame === undefined ? [] : eventIdsForRun(frame, runId)
      return {
        runId,
        conversationId: viewRun?.conversationId ?? null,
        branchId: viewRun?.branchId ?? null,
        turnId: viewRun?.turnId ?? null,
        operationId: viewRun?.operationId ?? null,
        status: record?.stateRun?.status ?? null,
        provider: viewRun?.provider ?? null,
        runner: viewRun?.runner ?? null,
        model: viewRun?.model ?? null,
        localEnvironmentId: viewRun?.environmentId ?? null,
        providerEnvironmentId: controlRef?.environmentId ?? null,
        materializationDigest: viewRun?.materializationDigest ?? null,
        cursor: viewRun?.cursor ?? null,
        contentBytes: viewRun?.contentBytes ?? null,
        eventCount: events.length,
        eventIdsUnique: events.length === new Set(events).size,
        identifiers: controlRef === undefined ? [] : identifiersForControl(controlRef),
      }
    }),
    overlap: {
      activeRunCount:
        secondFrame?.state?.activeRuns?.filter((entry) => runIds.has(entry.runId)).length ?? 0,
      streamEventCounts: [runAId, runBId].map((runId) => ({
        runId,
        count: eventIdsForRun(secondFrame, runId).length,
      })),
      workStripCount:
        secondFrame?.view?.workStrip?.filter((entry) => runIds.has(entry.runId)).length ?? 0,
      renderedWorkStripCount: renderedWorkStripCount(terminalEvidence.concurrent?.screen ?? ''),
      independentConversations:
        firstFrame?.state?.conversationId !== secondFrame?.state?.conversationId,
    },
    focus: {
      beforeRunId: secondFrame?.view?.focusedRunId ?? null,
      firstSwitchRunId: focusAFrame?.view?.focusedRunId ?? null,
      secondSwitchRunId: focusBFrame?.view?.focusedRunId ?? null,
      firstSwitchPreservedStatuses:
        focusAFrame === undefined
          ? false
          : [runAId, runBId].every((runId) => isActive(runStatus(focusAFrame, runId))),
      secondSwitchPreservedStatuses:
        focusBFrame === undefined
          ? false
          : [runAId, runBId].every((runId) => isActive(runStatus(focusBFrame, runId))),
    },
    cancellation: {
      dispatch: cancelDispatch ?? null,
      targetRunId: runBId ?? null,
      targetStatus:
        cancelFrame === undefined || runBId === undefined ? null : runStatus(cancelFrame, runBId),
      unaffectedRunId: runAId ?? null,
      unaffectedStatusAtAck:
        cancelFrame === undefined || runAId === undefined ? null : runStatus(cancelFrame, runAId),
      unaffectedFinalStatus:
        finalFrame === undefined || runAId === undefined ? null : runStatus(finalFrame, runAId),
    },
    replay: {
      restartedRunCount:
        restartedFrame === undefined
          ? 0
          : frameRunIds(restartedFrame).filter((runId) => runIds.has(runId)).length,
      noDuplicateEventIds:
        restartedFrame === undefined
          ? false
          : [...runIds].every((runId) => {
              const events = eventIdsForRun(restartedFrame, runId)
              return events.length === new Set(events).size
            }),
      eventSetsStable:
        finalFrame !== undefined &&
        restartedFrame !== undefined &&
        [...runIds].every(
          (runId) =>
            new Set(eventIdsForRun(finalFrame, runId)).size ===
            new Set(eventIdsForRun(restartedFrame, runId)).size,
        ),
    },
    terminal: {
      columns: DEFAULT_COLUMNS,
      rows: DEFAULT_ROWS,
      phases: terminalEvidence,
    },
    identifiers,
    timings,
    phases,
    account: { before: beforeAccount ?? null, after: afterAccount ?? null },
    cleanup: publicCleanup,
    error: proofError === undefined ? null : safeMessage(proofError, environment),
  }
  await writeArtifact(outputPath, result, environment)
  if (!passed) {
    const error =
      proofError ??
      new Error('multi-run live proof did not satisfy its cleanup or concurrency checks')
    error.artifactPath = outputPath
    throw error
  }
  return { ...result, artifactPath: outputPath }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  try {
    const result = await runProof()
    process.stdout.write(
      `${safeJson({ status: result.status, artifactPath: result.artifactPath }, process.env)}\n`,
    )
  } catch (error) {
    process.stderr.write(`${safeMessage(error, process.env)}\n`)
    if (error?.artifactPath)
      process.stdout.write(
        `${safeJson({ status: 'failed', artifactPath: error.artifactPath }, process.env)}\n`,
      )
    process.exitCode = 1
  }
}
