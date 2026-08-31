import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentExactRunControlRefSchema } from '@tangle-network/agent-interface'
import { Sandbox } from '@tangle-network/sandbox'
import xterm from '@xterm/headless'
import * as pty from 'node-pty'
import { sleep } from '../live-bridge/process.mjs'
import {
  processTreeEnvironment,
  terminateTrackedProcessTree,
  trackProcessTree,
  waitForTreeGone,
} from '../live-bridge/process-tree.mjs'
import { runFromState, stateForRun } from '../live-bridge/protocol.mjs'
import { installPackedBraid } from '../packed-binary.mjs'
import { connectionConfiguration } from './configuration.mjs'
import {
  EXIT_CODES,
  PROOF_OPERATIONS,
  proofInvocation,
  proofReceipt,
  protectedUnavailable,
  safeJson,
  safeMessage,
  scalarMeasurement,
} from './contracts.mjs'
import {
  configEvidence,
  initializedSession,
  prepareProductionWorkspace,
  rpcRequest,
  rpcState,
} from './headless.mjs'
import { DEFAULT_TANGLE_ROUTER_MODEL } from './model-defaults.mjs'
import {
  assertProviderObservationDeadline,
  createProviderObservationDeadline,
  waitForProviderObservation,
} from './provider-observation.mjs'
import {
  accountIdentity,
  assertSingleExecutionAttemptLedger,
  assertStableAccountIdentity,
  closeBraidWithProof,
  executionAttemptLedgerPath,
  providerWorkspaceReadbackEvidence,
  publicAccountIdentityEvidence,
  readRetainedWorkspaceFile,
  retainedBox,
  singleRunSpendDisclosure,
  telemetryDisclosure,
  usage,
} from './tangle-sandbox-braid-stress.mjs'
import { resourceDelta } from './tangle-sandbox-braid-stress-support.mjs'
import {
  createTerminalOutputTracker,
  waitForPiTerminalReady,
  waitForTerminalQuiescence,
} from './terminal-quiescence.mjs'
import { workspaceRequestFor } from './workspace-request.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const repository = resolve(dirname(scriptPath), '../..')
const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_IDLE_TTL_SECONDS = 1_800
const DEFAULT_PROCESS_EXIT_TIMEOUT_MS = 10_000
const SANDBOX_LIST_PAGE_SIZE = 100
const DETACH = '\u001d'
const RUN_STATUS_AFTER_STOP = new Set(['aborted', 'cancelled'])
const CANCELLABLE_INTERACTIVE_RUN_STATUSES = new Set([
  'prepared',
  'starting',
  'running',
  'streaming',
  'waiting',
  'detached',
  'reconnecting',
  'cancelling',
])
const CONTROL_REF_FIELDS = Object.freeze([
  'provider',
  'environmentId',
  'sessionId',
  'executionId',
  'runId',
  'requestDigest',
])
const INTERACTIVE_PROOF_CHECKS = Object.freeze([
  'packed-binary',
  'interactive-command',
  'input',
  'detach',
  'reconnect',
  'terminal-resize',
  'same-local-run',
  'same-provider-control-ref',
  'sandbox-observed-before-stop',
  'stop-through-braid',
  'sandbox-observed-stopped',
  'exact-resource-cleanup',
  'process-exited-before-cleanup',
  'process-group-exited-before-cleanup',
  'provider-bound-input',
  'provider-bound-reconnect',
  'single-provider-execution-attempt',
  'exact-owned-resource-set-cleanup',
  'account-identity-stable',
  'active-resource-delta',
  'telemetry-complete',
  'spend-disclosed',
  'latency-observed',
])
const SECRET_ENVIRONMENT_NAMES = [
  'BRAID_TANGLE_SANDBOX_AUTH',
  'BRAID_TANGLE_SANDBOX_API_KEY',
  'BRAID_TANGLE_SANDBOX_BEARER',
  'BRAID_TANGLE_SANDBOX_CLEANUP_API_KEY',
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

export function sandboxConfiguration(environment) {
  return connectionConfiguration(configurationEnvironment(environment), {
    prefix: 'BRAID_TANGLE_SANDBOX',
    kind: 'tangle-sandbox',
    endpointNames: ['BRAID_TANGLE_ENDPOINT'],
    modelNames: ['BRAID_TANGLE_MODEL'],
    runnerNames: ['BRAID_TANGLE_RUNNER'],
    providerNames: ['BRAID_TANGLE_SANDBOX_PROVIDER'],
    modelProviderNames: ['BRAID_TANGLE_SANDBOX_MODEL_PROVIDER'],
    fallbackEndpoint: 'https://sandbox.tangle.tools',
    fallbackModel: DEFAULT_TANGLE_ROUTER_MODEL,
    fallbackRunner: 'pi',
    fallbackModelProvider: 'tangle-router',
  })
}

export function isCancellableInteractiveRunStatus(status) {
  return typeof status === 'string' && CANCELLABLE_INTERACTIVE_RUN_STATUSES.has(status)
}

export function stoppedRunFromState(response, runId) {
  if (!stateForRun(response, runId)) return undefined
  const run = runFromState(response.state, runId)
  return run !== undefined && RUN_STATUS_AFTER_STOP.has(run.status) ? run : undefined
}

export function interactiveProofCommandSequence(markers) {
  const input = markers.input ?? markers.inputSeed?.toUpperCase()
  const reconnect = markers.reconnect ?? markers.reconnectSeed?.toUpperCase()
  const proofId = markers.proofId ?? `interactive-${markers.outputSeed ?? 'proof'}`
  const inputPath = markers.inputPath ?? `.braid-live/${proofId}/native-input.txt`
  const reconnectPath = markers.reconnectPath ?? `.braid-live/${proofId}/native-reconnect.txt`
  const attemptPath = markers.attemptPath ?? executionAttemptLedgerPath(proofId)
  const attempt = markers.executionAttempt ?? `ATTEMPT_${proofId.replaceAll(/[^A-Za-z0-9]/gu, '_')}`
  return [
    `/interactive Use a shell command with append redirection (>>) in the current Tangle Sandbox workspace to write exactly ${attempt} followed by a newline to ${attemptPath}; never overwrite this file. Then reply with exactly the uppercase version of ${markers.outputSeed}.`,
    interactiveShellMutationCommand(input, inputPath),
    DETACH,
    '/help',
    '/attach',
    interactiveShellMutationCommand(reconnect, reconnectPath),
    DETACH,
    '/help',
  ]
}

function shellLiteral(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`
}

function interactiveShellMutationCommand(value, path) {
  return `!!printf '%s\\n' ${shellLiteral(value)} >> ${shellLiteral(path)}`
}

function occurrences(value, marker) {
  if (!marker) return 0
  let count = 0
  let offset = 0
  while (offset >= 0) {
    offset = value.indexOf(marker, offset)
    if (offset < 0) break
    count += 1
    offset += marker.length
  }
  return count
}

export function assertProviderBoundEvidence(evidence, label = 'provider-bound mutation') {
  assert.ok(evidence && typeof evidence === 'object', `${label} evidence is missing`)
  assert.equal(evidence.provider, 'tangle-sandbox', `${label} was not observed by the provider`)
  assert.equal(evidence.source, 'sandbox-workspace-read', `${label} lacks provider readback`)
  assert.equal(
    evidence.providerObserved ?? evidence.matched,
    true,
    `${label} was not provider-bound; local terminal echo is insufficient`,
  )
  assert.equal(evidence.localEchoOnly, false, `${label} relied on local terminal echo`)
  return evidence
}

export function assertInteractiveTelemetry(telemetry, spend, timing) {
  assert.equal(
    telemetry?.completeDisclosure,
    true,
    'interactive telemetry disclosure is incomplete',
  )
  const fields = telemetry.fields ?? {}
  const missingTelemetry = Object.entries(fields)
    .filter(([, field]) => field?.status === 'missing' || field?.status === 'in-flight')
    .map(([name]) => name)
  assert.deepEqual(missingTelemetry, [], 'interactive telemetry contains missing fields')
  const rows = Array.isArray(spend?.rows) ? spend.rows : []
  assert.equal(rows.length, 1, 'interactive spend disclosure must contain one run')
  const missingSpend = rows.flatMap((row) =>
    ['tokens', 'cost', 'duration']
      .filter((name) => row?.[name]?.status === 'missing')
      .map((name) => `${row.label ?? 'run'}.${name}`),
  )
  assert.deepEqual(missingSpend, [], 'interactive spend disclosure contains missing fields')
  assert.equal(timing?.status, 'observed', 'interactive latency was not observed')
  assert.ok(
    Number.isFinite(timing?.milliseconds) && timing.milliseconds >= 0,
    'interactive latency is not a finite measurement',
  )
  return { complete: true }
}

export function assertInteractiveOwnedResourceCleanup(cleanup, expectedEnvironmentId) {
  assert.equal(cleanup?.confirmed, true, 'owned Sandbox cleanup was not confirmed')
  assert.ok(
    Array.isArray(cleanup?.removedIds) && cleanup.removedIds.includes(expectedEnvironmentId),
    'owned Sandbox cleanup omitted the exact resource',
  )
  assert.equal(cleanup?.remainingIds?.length, 0, 'owned Sandbox cleanup left a resource behind')
  assert.equal(
    cleanup?.matchedCount,
    1,
    `owned Sandbox cleanup found ${cleanup?.matchedCount ?? 'an unknown number of'} resources; expected one`,
  )
  return cleanup
}

async function waitForProviderReadback(client, controlRef, path, expectedValue, timeoutMs, label) {
  const deadline = createProviderObservationDeadline(label, timeoutMs)
  const box = await waitForProviderObservation(
    `${label} retained Sandbox`,
    () => retainedBox(client, controlRef, label),
    timeoutMs,
    { deadline },
  )
  const observation = await waitForProviderObservation(
    `${label} provider readback`,
    () =>
      readRetainedWorkspaceFile(client, controlRef, path, {
        label,
        allowMissing: true,
        box,
      }).then((value) => (value?.value === expectedValue ? value : undefined)),
    timeoutMs,
    { deadline },
  )
  return assertProviderBoundEvidence(
    providerWorkspaceReadbackEvidence(observation, expectedValue, `provider-bound ${label}`),
    label,
  )
}

async function waitForExecutionAttempt(client, controlRef, path, expectedAttempt, timeoutMs) {
  const expectedValue = `${expectedAttempt}\n`
  const deadline = createProviderObservationDeadline('execution attempt', timeoutMs)
  const box = await waitForProviderObservation(
    'Execution-attempt retained Sandbox',
    () => retainedBox(client, controlRef, 'Execution-attempt ledger'),
    timeoutMs,
    { deadline },
  )
  let previousValue
  let stableReads = 0
  const observation = await waitForProviderObservation(
    'single provider execution attempt',
    async () => {
      const value = await readRetainedWorkspaceFile(client, controlRef, path, {
        label: 'Execution-attempt ledger',
        allowMissing: true,
        box,
      })
      if (value?.value === undefined) return undefined
      assertSingleExecutionAttemptLedger(value.value, expectedAttempt)
      if (value.value === previousValue) stableReads += 1
      else {
        previousValue = value.value
        stableReads = 1
      }
      return stableReads >= 3 ? value : undefined
    },
    timeoutMs,
    { deadline },
  )
  const ledger = assertSingleExecutionAttemptLedger(observation.value, expectedAttempt)
  return {
    ...assertProviderBoundEvidence(
      providerWorkspaceReadbackEvidence(
        observation,
        expectedValue,
        'provider-bound execution attempt',
      ),
      'execution attempt',
    ),
    path: observation.path,
    ...ledger,
  }
}

function terminalText(terminal) {
  let text = ''
  for (let row = 0; row < terminal.rows; row += 1) {
    text += terminal.buffer.active.getLine(row)?.translateToString(true) ?? ''
    text += '\n'
  }
  return text
}

function terminalDiagnostic(runtime) {
  if (runtime === undefined) return 'terminal unavailable'
  const rows = runtime.screen
    .split('\n')
    .map((row) => row.trim())
    .filter((row) => row.length > 0)
    .slice(-8)
  return rows.length === 0 ? 'terminal screen empty' : rows.join(' | ').slice(-768)
}

function stateDiagnostic(frame) {
  const runs = Array.isArray(frame?.state?.runs) ? frame.state.runs : []
  return runs.map((run) => ({
    id: typeof run?.id === 'string' ? run.id : null,
    status: typeof run?.status === 'string' ? run.status : null,
    retainedAdmission: interactiveAdmissionPhase(frame, run?.id),
    controlRef: AgentExactRunControlRefSchema.safeParse(run?.controlRef).success,
  }))
}

export function interactiveMaterializationEvidence(record) {
  const runs = Array.isArray(record?.state?.runs) ? record.state.runs : []
  if (runs.length !== 1) return undefined
  const run = runs[0]
  const runId = typeof run?.id === 'string' && run.id.length > 0 ? run.id : undefined
  const phase = interactiveAdmissionPhase(record, runId)
  const materialized =
    phase === 'interactive_environment' ||
    phase === 'interactive_started' ||
    typeof run?.environmentId === 'string' ||
    typeof run?.controlRef?.environmentId === 'string'
  return {
    ...(runId === undefined ? {} : { runId }),
    phase,
    materialized,
    boundary: materialized
      ? 'provider-environment-identity'
      : phase === 'interactive_intent'
        ? 'before-interactive_environment'
        : 'unknown',
  }
}

function interactiveResourceName(runId) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9._:-]{1,95}$/u.test(runId)) {
    throw new Error('Interactive run-derived cleanup requires a bounded Braid run identity')
  }
  return `braid-interactive-${runId}`
}

function isOwnedInteractiveResource(box, expectedName) {
  return (
    typeof box?.id === 'string' &&
    box.name === expectedName &&
    box.metadata?.owner === 'braid' &&
    box.metadata?.lifecycle === 'retained' &&
    box.metadata?.surface === 'interactive-agent'
  )
}

function sameNameInteractiveResources(resources, expectedName, predicate) {
  const matches = resources.filter((resource) => resource?.name === expectedName)
  if (matches.length > 1) {
    throw new Error(
      `Interactive run-derived cleanup found ${String(matches.length)} same-name Sandbox resources; cleanup refused`,
    )
  }
  if (matches.length === 1 && !predicate(matches[0])) {
    throw new Error(
      `Interactive run-derived resource ${String(matches[0]?.id ?? 'without-id')} failed exact ownership validation`,
    )
  }
  return matches
}

async function listAllSandboxResources(
  client,
  {
    deadline: providedDeadline,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    label = 'Sandbox resource list',
  } = {},
) {
  const deadline = providedDeadline ?? createProviderObservationDeadline(label, timeoutMs)
  const resources = []
  const seenIds = new Set()
  let offset = 0
  for (;;) {
    const page = await waitForProviderObservation(
      `${label} page ${offset}`,
      () => client.list({ limit: SANDBOX_LIST_PAGE_SIZE, offset }),
      timeoutMs,
      { deadline },
    )
    if (!Array.isArray(page)) throw new Error('Sandbox list returned an invalid page')
    for (const resource of page) {
      if (typeof resource?.id === 'string') {
        if (seenIds.has(resource.id)) throw new Error(`Sandbox list repeated ${resource.id}`)
        seenIds.add(resource.id)
      }
      resources.push(resource)
    }
    if (page.length < SANDBOX_LIST_PAGE_SIZE) return resources
    offset += page.length
  }
}

async function observeInteractiveResource(
  client,
  controlRef,
  runId,
  { box: providedBox, deadline: providedDeadline, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const deadline =
    providedDeadline ??
    createProviderObservationDeadline('Interactive Sandbox observation', timeoutMs)
  const expectedName = interactiveResourceName(runId)
  const box =
    providedBox ??
    (await waitForProviderObservation(
      'Interactive Sandbox identity',
      () => retainedBox(client, controlRef, 'Interactive Sandbox observation'),
      timeoutMs,
      { deadline },
    ))
  if (box === null) {
    throw new Error(`Interactive Sandbox ${controlRef.environmentId} was not visible`)
  }
  if (!isOwnedInteractiveResource(box, expectedName)) {
    throw new Error(
      `Interactive Sandbox ${controlRef.environmentId} failed exact Braid ownership validation`,
    )
  }
  const matches = sameNameInteractiveResources(
    await listAllSandboxResources(client, {
      deadline,
      timeoutMs,
      label: 'Interactive Sandbox resource census',
    }),
    expectedName,
    (resource) => isOwnedInteractiveResource(resource, expectedName),
  )
  if (matches.length !== 1 || matches[0]?.id !== box.id) {
    throw new Error('Interactive Sandbox control identity did not match its owned resource census')
  }
  return {
    observed: true,
    id: box.id,
    name: expectedName,
    metadata: {
      owner: 'braid',
      lifecycle: 'retained',
      surface: 'interactive-agent',
    },
  }
}

async function cleanupInteractiveByRunId(
  client,
  materialization,
  { deadline: providedDeadline, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const deadline =
    providedDeadline ?? createProviderObservationDeadline('Interactive Sandbox cleanup', timeoutMs)
  const runId = materialization?.runId
  const expectedName = interactiveResourceName(runId)
  const predicate = (resource) => isOwnedInteractiveResource(resource, expectedName)
  const listed = sameNameInteractiveResources(
    await listAllSandboxResources(client, {
      deadline,
      timeoutMs,
      label: 'Interactive Sandbox cleanup resource census',
    }),
    expectedName,
    predicate,
  )
  const deletions = []
  const removedIds = []
  for (const resource of listed) {
    const exact = await waitForProviderObservation(
      `Interactive Sandbox cleanup identity ${resource.id}`,
      () => client.get(resource.id),
      timeoutMs,
      { deadline },
    )
    if (exact === null) {
      deletions.push({
        id: resource.id,
        observed: true,
        resolved: true,
        deleted: false,
        confirmed: true,
      })
      continue
    }
    if (!predicate(exact)) {
      throw new Error(
        `Interactive run-derived resource ${resource.id} failed exact ownership validation`,
      )
    }
    assertProviderObservationDeadline(
      deadline,
      `Interactive Sandbox deletion ${resource.id}`,
      'delete',
    )
    await exact.delete()
    assertProviderObservationDeadline(
      deadline,
      `Interactive Sandbox deletion ${resource.id}`,
      'delete',
    )
    const remaining = await waitForProviderObservation(
      `Interactive Sandbox deletion verification ${resource.id}`,
      () => client.get(resource.id),
      timeoutMs,
      { deadline },
    )
    if (remaining !== null) {
      throw new Error(`Interactive run-derived resource ${resource.id} remained after delete`)
    }
    removedIds.push(resource.id)
    deletions.push({
      id: resource.id,
      observed: true,
      resolved: true,
      deleted: true,
      confirmed: true,
    })
  }
  const remaining = sameNameInteractiveResources(
    await listAllSandboxResources(client, {
      deadline,
      timeoutMs,
      label: 'Interactive Sandbox cleanup final census',
    }),
    expectedName,
    predicate,
  )
  if (remaining.length > 0) {
    throw new Error(
      `Interactive run-derived cleanup left ${String(remaining.length)} same-name Sandbox resources`,
    )
  }
  return {
    confirmed: true,
    mode: listed.length === 0 ? 'run-derived-absence' : 'run-derived-owned-resource-set',
    phase: materialization.phase,
    runId,
    expectedName,
    matchedCount: listed.length,
    observedIds: listed.map((resource) => resource.id),
    removedIds,
    deletions,
    remainingIds: [],
  }
}

async function waitFor(label, predicate, timeoutMs) {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (performance.now() >= deadline) throw new Error(`${label} timed out after ${timeoutMs}ms`)
    await sleep(50)
  }
}

function createPty(binary, config, statePath, exitTimeoutMs) {
  const terminal = new xterm.Terminal({ cols: 120, rows: 36, allowProposedApi: true })
  const environment = processTreeEnvironment({
    ...config.environment,
    BRAID_SHUTDOWN_MODE: 'detach',
    NO_COLOR: '1',
    NODE_NO_WARNINGS: '1',
  })
  const child = pty.spawn(process.execPath, [binary, '--inline', '--record-state', statePath], {
    cwd: config.workspace,
    env: environment.environment,
    name: 'xterm-256color',
    cols: 120,
    rows: 36,
  })
  trackProcessTree(child, environment.token)
  let output = ''
  let exited = false
  let exitResult
  let processCleanup
  const outputTracker = createTerminalOutputTracker()
  const waitForProcessCleanup = async () => {
    processCleanup ??= await waitForTreeGone(child, exitTimeoutMs)
    return processCleanup
  }
  child.onData((chunk) => {
    output += chunk
    outputTracker.observe(chunk, (settle) => terminal.write(chunk, settle))
  })
  child.onExit((result) => {
    exited = true
    exitResult = result
  })
  return {
    child,
    terminal,
    get output() {
      return output
    },
    get screen() {
      return terminalText(terminal)
    },
    get exited() {
      return exited || (processCleanup?.supported === true && processCleanup.gone === true)
    },
    get processCleanup() {
      return processCleanup
    },
    get terminalOutputRevision() {
      return outputTracker.snapshot().revision
    },
    waitForTerminalQuiescence(timeoutMs, afterRevision) {
      return waitForTerminalQuiescence(outputTracker, { timeoutMs, afterRevision, pause: sleep })
    },
    waitForPiTerminalReady(timeoutMs, afterRevision, beforeScreen) {
      return waitForPiTerminalReady({
        tracker: outputTracker,
        readScreen: () => terminalText(terminal),
        timeoutMs,
        afterRevision,
        beforeScreen,
        pause: sleep,
      })
    },
    write(value) {
      child.write(value)
    },
    resize(columns, rows) {
      assert.ok(Number.isInteger(columns) && columns > 0, 'PTY columns must be positive')
      assert.ok(Number.isInteger(rows) && rows > 0, 'PTY rows must be positive')
      child.resize(columns, rows)
      terminal.resize(columns, rows)
    },
    async close() {
      if (exited) return { ...exitResult, processCleanup: await waitForProcessCleanup() }
      child.write('\u0003')
      await waitFor(
        'Braid terminal quit prompt',
        () => /Ctrl\+C again to quit/iu.test(this.screen),
        exitTimeoutMs,
      )
      child.write('\u0003')
      const result = await waitFor('Braid terminal exit', () => exited && exitResult, exitTimeoutMs)
      return { ...result, processCleanup: await waitForProcessCleanup() }
    },
    async forceClose() {
      if (exited) return { ...exitResult, processCleanup: await waitForProcessCleanup() }
      const termTimeoutMs = Math.min(1_000, exitTimeoutMs)
      const termination = await terminateTrackedProcessTree(child, {
        termTimeoutMs,
        killTimeoutMs: Math.max(0, exitTimeoutMs - termTimeoutMs),
      })
      processCleanup = termination.tree
      if (!termination.descendantsVerified) {
        throw new Error(
          `forced Braid terminal cleanup did not remove the tracked process tree (${termination.cleanupStatus})`,
        )
      }
      return { ...exitResult, processCleanup, termination }
    },
    dispose() {
      terminal.dispose()
    },
  }
}

async function captureStateFrame(runtime, recordPath, timeoutMs) {
  const framePath = `${recordPath}.frame`
  const previousVersion = await stateFrameVersion(framePath)
  process.kill(runtime.child.pid, 'SIGUSR2')
  return waitFor(
    'atomic Braid interactive state frame',
    async () => {
      try {
        const version = await stateFrameVersion(framePath)
        if (version === undefined || version === previousVersion) return undefined
        const frame = JSON.parse(await readFile(framePath, 'utf8'))
        return (await stateFrameVersion(framePath)) === version ? frame : undefined
      } catch (error) {
        if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
        return undefined
      }
    },
    timeoutMs,
  )
}

async function stateFrameVersion(path) {
  try {
    const value = await stat(path, { bigint: true })
    return `${value.dev}:${value.ino}:${value.mtimeNs}:${value.size}`
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function proveTuiReturned(runtime, timeoutMs, label) {
  const before = runtime.output.length
  runtime.write('/help\r')
  await waitFor(`${label} returned to Braid`, () => /Commands/iu.test(runtime.screen), timeoutMs)
  runtime.write('\u001b')
  await waitFor(
    `${label} closed the Braid help surface`,
    () => !/Commands/iu.test(runtime.screen),
    timeoutMs,
  )
  return { outputBytes: runtime.output.length - before }
}

function eventKind(event) {
  return event?.kind
}

function eventRunId(event) {
  return event?.payload?.runId
}

function assertOrderedRunEvents(events, runId, required) {
  let nextIndex = 0
  for (const kind of required) {
    const found = events.findIndex(
      (event, index) =>
        index >= nextIndex && eventKind(event) === kind && eventRunId(event) === runId,
    )
    assert.ok(found >= nextIndex, `interactive record omitted ordered ${kind}`)
    nextIndex = found + 1
  }
}

function exactControlRef(value, label) {
  const parsed = AgentExactRunControlRefSchema.safeParse(value)
  assert.ok(parsed.success, `${label} is not a valid exact Braid control reference`)
  return parsed.data
}

function assertControlRefsEqual(expected, actual, label) {
  const expectedRef = exactControlRef(expected, `${label} expected`)
  const actualRef = exactControlRef(actual, `${label} actual`)
  for (const field of CONTROL_REF_FIELDS) {
    assert.equal(actualRef[field], expectedRef[field], `${label}.${field} mismatch`)
  }
  return actualRef
}

function projectedRetainedAdmission(event) {
  if (eventKind(event) !== 'run.retained.admitted') return undefined
  const value = event?.payload?.value
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.kind !== 'run.retained.admitted' ||
    typeof value.runId !== 'string' ||
    value.runId.length === 0 ||
    event?.payload?.runId !== value.runId
  )
    return undefined
  const admission = value.admission
  return admission && typeof admission === 'object' ? admission : undefined
}

function interactiveAdmissions(record, runId) {
  const events = Array.isArray(record?.events) ? record.events : []
  return events.flatMap((event) => {
    const admission = projectedRetainedAdmission(event)
    if (admission === undefined) return []
    const admittedRunId = eventRunId(event)
    return admittedRunId === runId ? [admission] : []
  })
}

function interactiveAdmissionPhase(record, runId) {
  if (typeof runId !== 'string' || runId.length === 0) return null
  const projected = interactiveAdmissions(record, runId).at(-1)?.phase
  return typeof projected === 'string' ? projected : null
}

function interactiveAdmissionIdentity(record, run) {
  const admission = interactiveAdmissions(record, run?.id).findLast(
    (candidate) => candidate?.phase === 'interactive_started',
  )
  assert.equal(
    admission?.phase,
    'interactive_started',
    'interactive proof requires the canonical interactive_started admission phase',
  )
  const startedControlRef = exactControlRef(
    admission.ref?.run,
    'interactive_started admission control reference',
  )
  const controlRef = assertControlRefsEqual(
    run.controlRef,
    startedControlRef,
    'interactive admission control reference',
  )
  if (run.providerSessionId !== undefined) {
    assert.equal(
      startedControlRef.sessionId,
      run.providerSessionId,
      'interactive admission session differs from the stored provider session',
    )
  }
  return { admission, ref: { run: startedControlRef }, controlRef }
}

export function recoverInteractiveIdentity(record) {
  const runs = Array.isArray(record?.state?.runs) ? record.state.runs : []
  if (runs.length !== 1 || typeof runs[0]?.id !== 'string' || runs[0].id.length === 0)
    return undefined
  const run = runs[0]
  try {
    const { admission, ref, controlRef } = interactiveAdmissionIdentity(record, run)
    return {
      run,
      admission,
      ref,
      controlRef,
      eventKinds: (Array.isArray(record?.events) ? record.events : []).map(eventKind),
    }
  } catch {
    return undefined
  }
}

export async function waitForInteractiveIdentityFrame({ captureFrame, timeoutMs }) {
  assert.equal(
    typeof captureFrame,
    'function',
    'interactive identity polling requires captureFrame',
  )
  assert.ok(
    Number.isFinite(timeoutMs) && timeoutMs > 0,
    'interactive identity timeout must be positive',
  )
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const frame = await captureFrame()
    const identity = recoverInteractiveIdentity(frame)
    if (identity !== undefined) return { frame, identity }
    if (performance.now() >= deadline) {
      throw new Error(`retained interactive identity timed out after ${timeoutMs}ms`)
    }
    await sleep(50)
  }
}

export function assertInteractiveRecord(record) {
  const runs = Array.isArray(record?.state?.runs) ? record.state.runs : []
  assert.equal(runs.length, 1, 'interactive proof must retain exactly one local run')
  const run = runs[0]
  const { controlRef } = interactiveAdmissionIdentity(record, run)
  assert.equal(controlRef.provider, 'tangle-sandbox')
  const events = Array.isArray(record?.events) ? record.events : []
  const kinds = events.map(eventKind)
  for (const required of ['run.control.requested', 'run.control.acknowledged', 'run.detached']) {
    assert.ok(kinds.includes(required), `interactive record omitted ${required}`)
  }
  assert.ok(kinds.includes('run.reconnecting'), 'interactive record omitted run.reconnecting')
  assertOrderedRunEvents(events, run.id, [
    'run.control.requested',
    'run.control.acknowledged',
    'run.detached',
    'run.reconnecting',
    'run.detached',
  ])
  assert.equal(run.status, 'detached', 'TUI must leave the retained run detached before stop')
  return { run, controlRef, eventKinds: kinds }
}

export function assertStoppedTerminal(terminal) {
  if (terminal === null) return { terminal: null, stopped: true }
  assert.ok(terminal && typeof terminal === 'object', 'Sandbox terminal observation was invalid')
  assert.equal(terminal.isRunning, false, 'Sandbox terminal remained active after Braid stop')
  return { terminal, stopped: true }
}

async function observeSandbox(
  client,
  controlRef,
  runId,
  timeoutMs,
  expectedRunning,
  expectedGeometry,
) {
  const deadline = createProviderObservationDeadline('interactive Sandbox observation', timeoutMs)
  const box = await waitForProviderObservation(
    'interactive Sandbox identity',
    () => retainedBox(client, controlRef, 'Interactive Sandbox observation'),
    timeoutMs,
    { deadline },
  )
  const resource = await waitForProviderObservation(
    'interactive Sandbox ownership',
    () => observeInteractiveResource(client, controlRef, runId, { box, deadline, timeoutMs }),
    timeoutMs,
    { deadline },
  )
  assert.equal(box.id, resource.id, 'Sandbox observation changed environment identity')
  assert.ok(box.terminals && typeof box.terminals.get === 'function')
  let terminal
  await waitForProviderObservation(
    expectedRunning ? 'retained interactive terminal' : 'stopped retained interactive terminal',
    async () => {
      terminal = await box.terminals.get(controlRef.sessionId)
      if (terminal !== null) assert.equal(terminal.sessionId, controlRef.sessionId)
      if (expectedRunning) {
        const ready =
          terminal?.isRunning === true &&
          (expectedGeometry === undefined ||
            (terminal.cols === expectedGeometry.cols && terminal.rows === expectedGeometry.rows))
        return ready ? terminal : undefined
      }
      return terminal === null || terminal?.isRunning === false ? terminal : undefined
    },
    timeoutMs,
    { deadline },
  )
  const stopped = expectedRunning ? undefined : assertStoppedTerminal(terminal)
  if (expectedGeometry !== undefined) {
    assert.equal(
      terminal?.cols,
      expectedGeometry.cols,
      'Sandbox terminal columns were not retained',
    )
    assert.equal(terminal?.rows, expectedGeometry.rows, 'Sandbox terminal rows were not retained')
  }
  let resourceSample
  let resourceSampleError
  try {
    if (typeof box.resourceUsage !== 'function') {
      resourceSample = undefined
    } else {
      const sample = await waitForProviderObservation(
        'interactive Sandbox resource usage',
        async () => ({ value: await box.resourceUsage() }),
        timeoutMs,
        { deadline },
      )
      resourceSample = sample.value
    }
  } catch (error) {
    resourceSampleError = safeMessage(error)
  }
  return {
    resource,
    terminal,
    resourceSample:
      resourceSample === undefined
        ? { status: 'missing' }
        : resourceSample === null
          ? { status: 'unavailable', value: null }
          : { status: 'observed', value: resourceSample },
    ...(resourceSampleError === undefined ? {} : { resourceSampleError }),
    ...(terminal === null
      ? {}
      : { geometry: { cols: terminal.cols ?? null, rows: terminal.rows ?? null } }),
    ...(stopped ?? {}),
  }
}

async function cleanupExactSandbox(client, identity, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = createProviderObservationDeadline('Interactive Sandbox cleanup', timeoutMs)
  const observed = await observeInteractiveResource(client, identity.controlRef, identity.run.id, {
    deadline,
    timeoutMs,
  })
  const cleanup = await cleanupInteractiveByRunId(
    client,
    {
      runId: identity.run.id,
      phase: 'interactive_started',
    },
    { deadline, timeoutMs },
  )
  return assertInteractiveOwnedResourceCleanup(cleanup, observed.id)
}

function cleanupFailure(label, error) {
  return new Error(`${label}: ${safeMessage(error)}`, { cause: error })
}

export function interactiveFailureMessages(error, environment = process.env) {
  const messages = []
  const seen = new Set()
  const visit = (candidate) => {
    if (candidate === null || (typeof candidate !== 'object' && typeof candidate !== 'function'))
      return
    if (seen.has(candidate)) return
    seen.add(candidate)
    messages.push(safeMessage(candidate, environment))
    if (candidate instanceof AggregateError) {
      for (const nested of candidate.errors) visit(nested)
    }
    visit(candidate.cause)
  }
  visit(error)
  return [...new Set(messages)]
}

function assertStopResultMatchesIdentity(stopResult, identity) {
  assert.ok(stopResult && typeof stopResult === 'object', 'Braid stop returned no result')
  const controlRef = assertControlRefsEqual(
    identity.controlRef,
    stopResult.controlRef,
    'Braid stop result control reference',
  )
  assert.ok(
    RUN_STATUS_AFTER_STOP.has(stopResult.run?.status),
    'Braid stop result did not prove a terminal stopped status',
  )
  assert.equal(
    stopResult.run?.id,
    identity.run.id,
    'Braid stop result returned a different local run',
  )
  return controlRef
}

async function attemptCleanup(errors, label, operation) {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    errors.push(cleanupFailure(label, error))
    return { ok: false, value: undefined }
  }
}

export async function finalizeInteractiveProof({
  packed,
  config,
  runtime,
  recordPath,
  identity,
  materialization,
  client,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  exitTimeoutMs = DEFAULT_PROCESS_EXIT_TIMEOUT_MS,
  executionStarted = runtime !== undefined,
  stopped = false,
  stopResult,
  stop = ({ binary, targetConfig, runId, timeout }) =>
    stopThroughBraid(binary, targetConfig, runId, timeout),
  observe = (targetClient, controlRef, runId, timeout) =>
    observeSandbox(targetClient, controlRef, runId, timeout, false),
  cleanupSandbox = cleanupExactSandbox,
} = {}) {
  const errors = []
  let processExited = runtime === undefined || runtime.exited === true
  let processGroupExited =
    runtime === undefined ||
    (runtime.processCleanup?.supported === true && runtime.processCleanup.gone === true)
  if (runtime !== undefined && !processExited) {
    await attemptCleanup(errors, 'PTY process exit', () => runtime.forceClose(exitTimeoutMs))
    processExited = runtime.exited === true
    processGroupExited =
      runtime.processCleanup?.supported === true && runtime.processCleanup.gone === true
  }
  if (runtime !== undefined && processExited) {
    await attemptCleanup(errors, 'PTY terminal disposal', () => runtime.dispose?.())
  }
  if (runtime !== undefined && !processExited) {
    errors.push(new Error('PTY process did not exit; workspace cleanup was refused'))
  }
  if (runtime !== undefined && processExited && !processGroupExited) {
    errors.push(new Error('PTY process group did not exit; workspace cleanup was refused'))
  }

  let resolvedIdentity = identity
  const identityRecoveryErrors = []
  if (resolvedIdentity === undefined && executionStarted && recordPath !== undefined) {
    const recovered = await attemptCleanup(
      identityRecoveryErrors,
      'recorded Braid identity recovery',
      async () => {
        const record = JSON.parse(await readFile(recordPath, 'utf8'))
        const recoveredIdentity = recoverInteractiveIdentity(record)
        if (recoveredIdentity === undefined)
          throw new Error('recorded state did not contain one exact Braid run identity')
        return recoveredIdentity
      },
    )
    if (recovered.ok) resolvedIdentity = recovered.value
  }
  let providerMaterialization
  if (executionStarted && resolvedIdentity === undefined) {
    if (materialization?.runId !== undefined) {
      if (client === undefined) {
        errors.push(
          new Error(
            'Sandbox observation client was unavailable; run-derived absence could not be confirmed',
          ),
        )
      } else {
        const observed = await attemptCleanup(errors, 'run-derived Sandbox cleanup', () =>
          cleanupInteractiveByRunId(client, materialization, { timeoutMs }),
        )
        if (observed.ok) providerMaterialization = observed.value
      }
    } else {
      errors.push(new Error('Braid run identity was unavailable; exact cloud cleanup was refused'))
    }
  }
  if (resolvedIdentity === undefined && providerMaterialization === undefined) {
    errors.unshift(...identityRecoveryErrors)
  }

  let resolvedStop = stopResult
  let didStop = false
  if (resolvedIdentity !== undefined && resolvedStop !== undefined) {
    const verifiedStop = await attemptCleanup(errors, 'Braid stop identity', () =>
      assertStopResultMatchesIdentity(resolvedStop, resolvedIdentity),
    )
    didStop = verifiedStop.ok
  }
  if (resolvedIdentity !== undefined && resolvedStop === undefined && stopped) {
    errors.push(new Error('Braid stop result was unavailable; exact cloud cleanup was refused'))
  } else if (resolvedIdentity !== undefined && resolvedStop === undefined) {
    if (packed?.binary === undefined || config === undefined) {
      errors.push(new Error('Braid stop was unavailable; exact cloud cleanup was refused'))
    } else {
      const stoppedResult = await attemptCleanup(errors, 'Braid stop', () =>
        stop({
          binary: packed.binary,
          targetConfig: config,
          runId: resolvedIdentity.run.id,
          timeout: timeoutMs,
        }),
      )
      if (stoppedResult.ok) {
        resolvedStop = stoppedResult.value
        const verifiedStop = await attemptCleanup(errors, 'Braid stop identity', () =>
          assertStopResultMatchesIdentity(resolvedStop, resolvedIdentity),
        )
        didStop = verifiedStop.ok
      }
    }
  }

  let afterStop
  let cleanup
  if (resolvedIdentity !== undefined && didStop && processExited && processGroupExited) {
    if (client === undefined) {
      errors.push(
        new Error('Sandbox observation client was unavailable; exact deletion was refused'),
      )
    } else {
      const observed = await attemptCleanup(errors, 'stopped Sandbox observation', () =>
        observe(client, resolvedIdentity.controlRef, resolvedIdentity.run.id, timeoutMs),
      )
      if (observed.ok) {
        afterStop = observed.value
        const deleted = await attemptCleanup(errors, 'exact Sandbox deletion', () =>
          cleanupSandbox(client, resolvedIdentity, timeoutMs),
        )
        if (deleted.ok) {
          cleanup = deleted.value
          try {
            assertInteractiveOwnedResourceCleanup(
              cleanup,
              resolvedIdentity.controlRef.environmentId,
            )
          } catch (error) {
            errors.push(error)
          }
        }
      }
    }
  } else if (resolvedIdentity !== undefined && didStop) {
    errors.push(new Error('PTY process group did not exit; exact cloud deletion was refused'))
  } else if (resolvedIdentity !== undefined) {
    errors.push(new Error('Braid stop was not proven; exact cloud cleanup was refused'))
  }

  if (config !== undefined) {
    if (!processExited || !processGroupExited) {
      errors.push(
        new Error('Braid workspace cleanup was refused while the PTY process group remained'),
      )
    } else {
      const workspace = await attemptCleanup(errors, 'Braid workspace cleanup', () =>
        config.cleanup(),
      )
      if (
        workspace.ok &&
        (workspace.value?.credentialRemoved !== true ||
          workspace.value?.temporaryRootRemoved !== true)
      )
        errors.push(new Error('Braid workspace cleanup returned incomplete evidence'))
    }
  }
  if (packed !== undefined) {
    if (processExited && processGroupExited) {
      await attemptCleanup(errors, 'packed Braid cleanup', () => packed.cleanup())
    } else {
      errors.push(
        new Error('packed Braid cleanup was refused while the PTY process group remained alive'),
      )
    }
  }

  if (errors.length > 0) {
    const failure = new AggregateError(errors, 'Braid interactive proof cleanup incomplete')
    failure.code = 'BRAID_INTERACTIVE_CLEANUP_INCOMPLETE'
    throw failure
  }
  return {
    processExited,
    processGroupExited,
    processCleanup: runtime?.processCleanup,
    identity: resolvedIdentity,
    ...(providerMaterialization === undefined ? {} : { providerMaterialization }),
    stop: resolvedStop,
    afterStop,
    cleanup,
  }
}

async function stopThroughBraid(binary, config, runId, timeoutMs) {
  const initialized = await initializedSession(binary, config)
  let result
  try {
    const before = await rpcState(initialized.session)
    const beforeRun = runFromState(before.state, runId)
    if (RUN_STATUS_AFTER_STOP.has(beforeRun?.status)) {
      result = {
        operationId: undefined,
        acknowledgement: { outcome: 'already-applied' },
        run: beforeRun,
        controlRef: exactControlRef(beforeRun.controlRef, 'already-stopped Braid run'),
      }
    } else {
      assert.ok(
        isCancellableInteractiveRunStatus(beforeRun?.status),
        `Braid stop cannot target run status ${beforeRun?.status ?? 'missing'}`,
      )
      const operationId = `live-interactive-stop-${randomUUID()}`
      const acknowledgement = await rpcRequest(
        initialized.session,
        'cancel_run',
        { runId, reason: 'Braid packed-binary interactive live proof complete' },
        operationId,
      )
      assert.ok(
        acknowledgement.outcome === 'accepted' || acknowledgement.outcome === 'replayed',
        'Braid stop did not return an accepted or replayed outcome',
      )
      const terminal = await initialized.session.waitFor(
        'Braid interactive stop state',
        (candidate) => stoppedRunFromState(candidate, runId) !== undefined,
        timeoutMs,
      )
      const stoppedRun = stoppedRunFromState(terminal, runId)
      assert.ok(stoppedRun, 'Braid stop did not return the target run')
      assert.ok(RUN_STATUS_AFTER_STOP.has(stoppedRun.status))
      const controlRef = assertControlRefsEqual(
        beforeRun.controlRef,
        stoppedRun.controlRef,
        'Braid stop state control reference',
      )
      result = { operationId, acknowledgement, run: stoppedRun, controlRef }
    }
  } finally {
    const processCleanup = await closeBraidWithProof(
      initialized.session,
      'Braid interactive stop RPC process',
    )
    if (result !== undefined) result = { ...result, processCleanup }
  }
  return result
}

async function runProof({
  repository: targetRepository = repository,
  environment = process.env,
} = {}) {
  const timeoutMs = positiveEnvironment(
    environment,
    'BRAID_TANGLE_SANDBOX_INTERACTIVE_TIMEOUT_MS',
    DEFAULT_TIMEOUT_MS,
  )
  const exitTimeoutMs = Math.min(DEFAULT_PROCESS_EXIT_TIMEOUT_MS, timeoutMs)
  const idleTtlSeconds = positiveEnvironment(
    environment,
    'BRAID_TANGLE_SANDBOX_INTERACTIVE_IDLE_TTL_SECONDS',
    DEFAULT_IDLE_TTL_SECONDS,
  )
  const values = sandboxConfiguration(environment)
  assert.equal(values.runner, 'pi', 'LIVE-08 native interactive proof must run the Pi harness')
  if (!values.credentialValue) {
    throw protectedUnavailable(
      'SANDBOX_OBSERVATION_CREDENTIAL_REQUIRED',
      'The packed interactive proof needs a raw Sandbox credential to observe and clean its exact Braid resource',
    )
  }

  let packed
  let config
  let runtime
  let recordPath
  let identity
  let materialization
  let client
  let proofData
  let proofError
  let runObserved = false
  let stopped = false
  const proofStartedAt = performance.now()
  const usageRecords = []
  const identityRecords = []
  let metrics
  try {
    packed = await installPackedBraid(targetRepository)
    config = await prepareProductionWorkspace({
      repository: targetRepository,
      environment: sanitizedEnvironment(configurationEnvironment(environment)),
      kind: values.kind,
      endpoint: values.endpoint,
      model: values.model,
      runner: values.runner,
      modelProvider: values.modelProvider,
      workspaceRequest: workspaceRequestFor(environment),
      providerOptions: { lifecycle: 'retained', idleTtlSeconds },
      credentialRef: values.credentialRef,
      credentialValue: values.credentialValue,
    })
    client = new Sandbox({ baseUrl: values.endpoint, apiKey: values.credentialValue })
    usageRecords.push(await usage(client, 'before'))
    identityRecords.push(await accountIdentity(client, 'before'))
    recordPath = join(config.root, 'interactive-state.json')
    runtime = createPty(packed.binary, config, recordPath, exitTimeoutMs)
    await waitFor('packed Braid TUI startup', () => /Braid/iu.test(runtime.screen), timeoutMs)

    const markers = {
      proofId: `braid-live-interactive-${randomUUID().replaceAll('-', '')}`,
      outputSeed: `braid_interactive_output_${randomUUID().replaceAll('-', '')}`,
      inputSeed: `braid_interactive_input_${randomUUID().replaceAll('-', '')}`,
      reconnectSeed: `braid_interactive_reconnect_${randomUUID().replaceAll('-', '')}`,
      executionAttempt: `ATTEMPT_${randomUUID().replaceAll('-', '')}`,
    }
    markers.output = markers.outputSeed.toUpperCase()
    markers.input = markers.inputSeed.toUpperCase()
    markers.reconnect = markers.reconnectSeed.toUpperCase()
    markers.inputPath = `.braid-live/${markers.proofId}/native-input.txt`
    markers.reconnectPath = `.braid-live/${markers.proofId}/native-reconnect.txt`
    markers.attemptPath = executionAttemptLedgerPath(markers.proofId)

    const [interactiveCommand, inputCommand, detach, , attach, reconnectCommand] =
      interactiveProofCommandSequence(markers)
    const promptCount = occurrences(runtime.output, markers.output)
    const interactiveBeforeScreen = runtime.screen
    const interactiveActionRevision = runtime.terminalOutputRevision
    runtime.write(`${interactiveCommand}\r`)
    await waitFor(
      'native interactive output',
      () => {
        if (/This action is unavailable with the selected connection/iu.test(runtime.screen)) {
          throw new Error(
            `native interactive command was unavailable: ${terminalDiagnostic(runtime)}`,
          )
        }
        return occurrences(runtime.output, markers.output) > promptCount
      },
      timeoutMs,
    )
    await runtime.waitForPiTerminalReady(
      timeoutMs,
      interactiveActionRevision,
      interactiveBeforeScreen,
    )
    const { frame: initialFrame, identity: initialIdentity } =
      await waitForInteractiveIdentityFrame({
        captureFrame: () => captureStateFrame(runtime, recordPath, timeoutMs),
        timeoutMs,
      })
    runObserved = stateDiagnostic(initialFrame).length > 0
    const initialAttach = await observeSandbox(
      client,
      initialIdentity.controlRef,
      initialIdentity.run.id,
      timeoutMs,
      true,
      { cols: 120, rows: 36 },
    )
    const inputBeforeScreen = runtime.screen
    const inputActionRevision = runtime.terminalOutputRevision
    runtime.write(`${inputCommand}\r`)
    const inputEvidence = await waitForProviderReadback(
      client,
      initialIdentity.controlRef,
      markers.inputPath,
      `${markers.input}\n`,
      timeoutMs,
      'interactive input',
    )
    await runtime.waitForPiTerminalReady(timeoutMs, inputActionRevision, inputBeforeScreen)

    runtime.write(detach)
    await proveTuiReturned(runtime, timeoutMs, 'native interactive detach')
    const attachOutputRevision = runtime.terminalOutputRevision
    const attachBeforeScreen = runtime.screen
    runtime.write(`${attach}\r`)
    await runtime.waitForPiTerminalReady(timeoutMs, attachOutputRevision, attachBeforeScreen)
    const resizeOutputRevision = runtime.terminalOutputRevision
    runtime.resize(100, 30)
    await runtime.waitForTerminalQuiescence(timeoutMs, resizeOutputRevision)
    const resized = await observeSandbox(
      client,
      initialIdentity.controlRef,
      initialIdentity.run.id,
      timeoutMs,
      true,
      { cols: 100, rows: 30 },
    )
    const reconnectedFrame = await captureStateFrame(runtime, recordPath, timeoutMs)
    const reconnectedIdentity = recoverInteractiveIdentity(reconnectedFrame)
    assert.ok(reconnectedIdentity, 'reconnected frame did not contain one exact Braid run identity')
    assert.equal(
      reconnectedIdentity.run.id,
      initialIdentity.run.id,
      'native reconnect changed the local run identity',
    )
    assertControlRefsEqual(
      initialIdentity.controlRef,
      reconnectedIdentity.controlRef,
      'native reconnect provider control reference',
    )
    const reconnectBeforeScreen = runtime.screen
    const reconnectActionRevision = runtime.terminalOutputRevision
    runtime.write(`${reconnectCommand}\r`)
    const reconnectEvidence = await waitForProviderReadback(
      client,
      initialIdentity.controlRef,
      markers.reconnectPath,
      `${markers.reconnect}\n`,
      timeoutMs,
      'interactive reconnect input',
    )
    await runtime.waitForPiTerminalReady(timeoutMs, reconnectActionRevision, reconnectBeforeScreen)
    const executionAttempt = await waitForExecutionAttempt(
      client,
      initialIdentity.controlRef,
      markers.attemptPath,
      markers.executionAttempt,
      timeoutMs,
    )
    runtime.write(detach)
    await proveTuiReturned(runtime, timeoutMs, 'native interactive reconnect detach')
    const exit = await runtime.close()
    assert.equal(exit.exitCode, 0, 'packed Braid TUI exited with a non-zero status')

    const record = JSON.parse(await readFile(recordPath, 'utf8'))
    identity = assertInteractiveRecord(record)
    assert.equal(
      identity.run.id,
      initialIdentity.run.id,
      'final TUI state changed the local run identity',
    )
    assertControlRefsEqual(
      initialIdentity.controlRef,
      identity.controlRef,
      'final TUI state provider control reference',
    )
    const sameLocalRun =
      initialIdentity.run.id === reconnectedIdentity.run.id &&
      initialIdentity.run.id === identity.run.id
    const sameProviderControlRef = CONTROL_REF_FIELDS.every(
      (field) =>
        initialIdentity.controlRef[field] === reconnectedIdentity.controlRef[field] &&
        initialIdentity.controlRef[field] === identity.controlRef[field],
    )
    const beforeStop = await observeSandbox(
      client,
      identity.controlRef,
      identity.run.id,
      timeoutMs,
      true,
      { cols: 100, rows: 30 },
    )
    const stop = await stopThroughBraid(packed.binary, config, identity.run.id, timeoutMs)
    stopped = true
    proofData = {
      markers,
      initialAttach,
      resized,
      beforeStop,
      stop,
      recordState: record.state,
      inputEvidence,
      reconnectEvidence,
      executionAttempt,
      sameLocalRun,
      sameProviderControlRef,
      identityContinuity: {
        initialLocalRunId: initialIdentity.run.id,
        reconnectedLocalRunId: reconnectedIdentity.run.id,
        finalLocalRunId: identity.run.id,
        initialControlRef: initialIdentity.controlRef,
        reconnectedControlRef: reconnectedIdentity.controlRef,
        finalControlRef: identity.controlRef,
      },
    }
  } catch (error) {
    const failures = [error]
    if (runtime !== undefined && !runtime.exited && recordPath !== undefined) {
      try {
        const failureFrame = await captureStateFrame(runtime, recordPath, exitTimeoutMs)
        materialization = interactiveMaterializationEvidence(failureFrame)
        runObserved ||= materialization?.runId !== undefined
        identity ??= recoverInteractiveIdentity(failureFrame)
        failures.push(
          new Error(`failure Braid state: ${JSON.stringify(stateDiagnostic(failureFrame))}`),
        )
      } catch (captureError) {
        failures.push(
          new Error(`failure-state identity capture failed: ${safeMessage(captureError)}`, {
            cause: captureError,
          }),
        )
      }
    }
    failures.push(new Error(`last Braid terminal screen: ${terminalDiagnostic(runtime)}`))
    proofError = new AggregateError(failures, 'Braid native interactive flow failed')
  }

  let cleanup
  let cleanupError
  try {
    cleanup = await finalizeInteractiveProof({
      packed,
      config,
      runtime,
      recordPath,
      identity,
      materialization,
      client,
      timeoutMs,
      exitTimeoutMs,
      executionStarted: runObserved,
      stopped,
      stopResult: proofData?.stop,
    })
  } catch (error) {
    cleanupError = error
  }

  if (client !== undefined) {
    usageRecords.push(await usage(client, 'after'))
    identityRecords.push(await accountIdentity(client, 'after'))
  }
  if (proofError === undefined && cleanupError === undefined) {
    try {
      const beforeUsage = usageRecords.find((entry) => entry.phase === 'before')
      const afterUsage = usageRecords.find((entry) => entry.phase === 'after')
      const usageDelta = resourceDelta(afterUsage?.value, beforeUsage?.value)
      const usageObservationComplete =
        beforeUsage?.error === undefined &&
        beforeUsage?.value !== undefined &&
        beforeUsage?.value !== null &&
        afterUsage?.error === undefined &&
        afterUsage?.value !== undefined &&
        afterUsage?.value !== null &&
        usageDelta.activeSandboxes !== null
      assert.equal(usageObservationComplete, true, 'interactive usage telemetry was unavailable')
      assert.equal(
        usageDelta.activeSandboxes,
        0,
        'interactive resource cleanup changed active usage',
      )
      const accountIdentityConsistency = assertStableAccountIdentity(identityRecords)
      const telemetry = telemetryDisclosure(
        proofData.stop.run,
        proofData.recordState,
        proofData.beforeStop,
        { identityDigest: accountIdentityConsistency.identityDigest },
      )
      const spend = singleRunSpendDisclosure(proofData.stop.run)
      const timing = {
        status: 'observed',
        milliseconds: performance.now() - proofStartedAt,
      }
      assertInteractiveTelemetry(telemetry, spend, timing)
      metrics = {
        usage: usageRecords.map((entry) => ({
          phase: entry.phase,
          status:
            entry.error !== undefined
              ? 'unavailable'
              : entry.value === undefined
                ? 'missing'
                : entry.value === null
                  ? 'unavailable'
                  : 'observed',
          ...(entry.value === undefined ? {} : { value: entry.value }),
          ...(entry.error ? { error: entry.error } : {}),
        })),
        accountIdentities: identityRecords.map((entry) => ({
          phase: entry.phase,
          status: entry.error ? 'unavailable' : entry.value === undefined ? 'missing' : 'observed',
          ...(entry.value === undefined
            ? {}
            : { value: publicAccountIdentityEvidence(entry.value) }),
          ...(entry.error ? { error: entry.error } : {}),
        })),
        accountIdentityConsistency,
        usageDelta,
        telemetry,
        spend,
        timing,
      }
    } catch (error) {
      proofError = new AggregateError([error], 'Braid interactive telemetry proof failed')
    }
  }

  if (proofError !== undefined && cleanup?.providerMaterialization !== undefined) {
    const prior = proofError instanceof AggregateError ? [...proofError.errors] : [proofError]
    const materialization = cleanup.providerMaterialization
    const phase = materialization.phase ?? 'no-retained-phase'
    const cleanupMessage =
      materialization.matchedCount === 0
        ? `Sandbox interactive resource absence confirmed before ${phase} for ${materialization.runId}`
        : `Sandbox interactive resource cleanup confirmed after ${phase} for ${materialization.runId}; removed ${materialization.matchedCount}`
    proofError = new AggregateError([...prior, new Error(cleanupMessage)], proofError.message)
  }

  if (proofError !== undefined && cleanupError !== undefined)
    throw new AggregateError(
      [proofError, cleanupError],
      'Braid interactive proof failed and cleanup was incomplete',
    )
  if (cleanupError !== undefined) throw cleanupError
  if (proofError !== undefined) throw proofError
  assert.ok(proofData && cleanup, 'interactive proof completed without proof and cleanup evidence')

  return {
    status: 'passed',
    proof: 'braid-packed-binary-native-interactive',
    checks: {
      packedBinary: true,
      interactiveCommand: true,
      input: proofData.inputEvidence?.matched === true,
      detach: true,
      reconnect: true,
      providerBoundInput: proofData.inputEvidence?.matched === true,
      providerBoundReconnect: proofData.reconnectEvidence?.matched === true,
      singleProviderExecutionAttempt: proofData.executionAttempt?.lineCount === 1,
      terminalResize:
        proofData.resized.geometry?.cols === 100 && proofData.resized.geometry?.rows === 30,
      sameLocalRun: proofData.sameLocalRun === true,
      sameProviderControlRef: proofData.sameProviderControlRef === true,
      sandboxObservedBeforeStop: proofData.beforeStop.terminal?.isRunning === true,
      stopThroughBraid: RUN_STATUS_AFTER_STOP.has(proofData.stop.run.status),
      sandboxObservedStopped: cleanup.afterStop?.stopped === true,
      exactSandboxCleanup: cleanup.cleanup?.confirmed === true,
      exactOwnedResourceSetCleanup:
        cleanup.cleanup?.confirmed === true && cleanup.cleanup?.matchedCount === 1,
      accountIdentityStable: metrics.accountIdentityConsistency?.stable === true,
      activeResourceDelta: metrics.usageDelta?.activeSandboxes === 0,
      telemetryComplete: metrics.telemetry?.completeDisclosure === true,
      spendDisclosed: metrics.spend?.rows?.length === 1,
      latencyObserved: metrics.timing?.status === 'observed',
      processExitedBeforeWorkspaceCleanup: cleanup.processExited === true,
      processGroupExitedBeforeWorkspaceCleanup: cleanup.processGroupExited === true,
    },
    binary: { tarballSha256: packed.tarballSha256 },
    configuration: configEvidence(config),
    run: {
      localRunId: proofData.stop.run.id,
      controlRef: identity.controlRef,
      eventKinds: identity.eventKinds,
      stoppedStatus: proofData.stop.run.status,
    },
    sandbox: {
      initialAttach: proofData.initialAttach,
      resized: proofData.resized,
      beforeStop: proofData.beforeStop.resource,
      afterStop: cleanup.afterStop.resource,
      cleanup: cleanup.cleanup,
    },
    identityContinuity: proofData.identityContinuity,
    processCleanup: cleanup.processCleanup,
    providerEvidence: {
      input: proofData.inputEvidence,
      reconnect: proofData.reconnectEvidence,
    },
    executionAttempt: proofData.executionAttempt,
    usage: metrics.usage,
    accountIdentities: metrics.accountIdentities,
    accountIdentityConsistency: metrics.accountIdentityConsistency,
    usageDelta: metrics.usageDelta,
    telemetry: metrics.telemetry,
    spend: metrics.spend,
    timing: metrics.timing,
    markers: proofData.markers,
  }
}

export async function runInteractiveProof({
  repository: targetRepository = repository,
  environment = process.env,
  invocationId = proofInvocation('live-tangle'),
} = {}) {
  const startedAt = new Date().toISOString()
  const proof = await runProof({ repository: targetRepository, environment })
  const evidence = proofReceipt({
    invocationId,
    operation: PROOF_OPERATIONS.tangleSandboxInteractive,
    startedAt,
    completedAt: new Date().toISOString(),
    config: proof.configuration,
    runIds: [proof.run.localRunId],
    environmentId: proof.run.controlRef.environmentId,
    facts: {
      environmentId: proof.run.controlRef.environmentId,
      localRunId: proof.run.localRunId,
      stoppedStatus: proof.run.stoppedStatus,
      cloudControl: proof.run.controlRef,
      exactResource: proof.checks.exactSandboxCleanup,
      processExitedBeforeWorkspaceCleanup: proof.checks.processExitedBeforeWorkspaceCleanup,
      terminalResize: proof.checks.terminalResize,
      processGroupExitedBeforeWorkspaceCleanup:
        proof.checks.processGroupExitedBeforeWorkspaceCleanup,
      providerInput: proof.checks.providerBoundInput,
      providerReconnect: proof.checks.providerBoundReconnect,
      singleProviderExecutionAttempt: proof.checks.singleProviderExecutionAttempt,
      exactOwnedResourceSetCleanup: proof.checks.exactOwnedResourceSetCleanup,
      accountIdentityStable: proof.checks.accountIdentityStable,
      activeResourceDelta: proof.usageDelta.activeSandboxes,
      telemetryComplete: proof.checks.telemetryComplete,
      spendDisclosed: proof.checks.spendDisclosed,
      latencyObserved: proof.checks.latencyObserved,
    },
    checks: INTERACTIVE_PROOF_CHECKS,
    observations: proof,
    environment,
  })
  return {
    status: 'passed',
    measurement: scalarMeasurement('LIVE-08'),
    evidence,
  }
}

export async function main(argv = process.argv, environment = process.env) {
  const outputPath = argument('output', argv)
  try {
    if (outputPath) await rm(outputPath, { force: true })
    const result = await runProof({ environment })
    if (outputPath) await writeFile(outputPath, `${safeJson(result, environment)}\n`)
    process.stdout.write(`${safeJson(result, environment)}\n`)
    return EXIT_CODES.passed
  } catch (error) {
    const status = error?.unavailable === true ? 'unavailable' : 'failed'
    const messages = interactiveFailureMessages(error, environment)
    process.stderr.write(
      `${safeJson({ status, error: messages[0], causes: messages.slice(1) }, environment)}\n`,
    )
    return status === 'unavailable' ? EXIT_CODES.unavailable : EXIT_CODES.failed
  }
}

if (process.argv[1] === scriptPath) process.exitCode = await main()
