import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { connectionConfiguration } from './configuration.mjs'
import {
  EXIT_CODES,
  endpointEvidence,
  LiveRequiredError,
  safeJson,
  safeMessage,
} from './contracts.mjs'

const OPERATION = 'tangle.sandbox.interactive-continuity'
const SANDBOX_PROVIDER = 'tangle-sandbox'
const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 36
const EXACT_HANDLE_METHODS = [
  'start',
  'attach',
  'status',
  'claimControl',
  'sendPrompt',
  'stop',
  'stopLifecycle',
]
const EXACT_STREAM_METHODS = ['write', 'close', 'reconnect']
const EXACT_INTERFACE_FUNCTIONS = [
  'agentInteractiveSessionRunRef',
  'agentInteractiveSessionRefMatchesStart',
  'agentInteractiveSessionStatusMatchesRef',
  'agentInteractiveSessionControlClaimMatchesRef',
  'agentInteractiveSessionPromptRequestDigest',
  'agentInteractiveSessionStopRequestDigest',
  'canonicalAgentProfileDigest',
  'canonicalCandidateDigest',
  'exactAgentInteractiveSessionStart',
]

function hasMethod(value, name) {
  return typeof value?.[name] === 'function'
}

function capabilityUnavailable(code, message, details = {}) {
  const error = new LiveRequiredError(code, message, { unavailable: true })
  error.details = details
  return error
}

function identityText(ref) {
  return [
    ref?.run?.runId,
    ref?.run?.provider,
    ref?.run?.environmentId,
    ref?.run?.sessionId,
    ref?.run?.executionId,
    ref?.incarnationId,
  ]
    .map((value) => (typeof value === 'string' ? value : '<missing>'))
    .join('/')
}

/**
 * Accept the explicit identity conflict returned by the Sandbox sidecar.
 * A mismatched incarnation is a rejected lookup, not an absent session.
 */
export function isStaleInteractiveIdentityError(error) {
  return error?.code === 'STALE_INCARNATION'
}

function directCredentialEnvironment(environment) {
  const hasSandboxCredential = [
    'BRAID_TANGLE_SANDBOX_AUTH',
    'BRAID_TANGLE_SANDBOX_API_KEY',
    'BRAID_TANGLE_SANDBOX_BEARER',
  ].some((name) => typeof environment[name] === 'string' && environment[name].trim())
  if (!hasSandboxCredential && environment.TANGLE_API_KEY) {
    return {
      ...environment,
      BRAID_TANGLE_SANDBOX_API_KEY: environment.TANGLE_API_KEY,
    }
  }
  return environment
}

function safeIdentifier(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 120 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw new Error(`${label} must be a bounded public identifier`)
  }
  return value
}

function argument(name, argv = process.argv) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

async function bounded(label, task, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} exceeded ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function waitFor(label, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await sleep(100)
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`)
}

function requireExactMethods(value, methods, label) {
  return methods.filter((method) => !hasMethod(value, method)).map((method) => `${label}.${method}`)
}

/**
 * Check the package-level public contract before creating a cloud resource.
 * The old Sandbox release is intentionally rejected because it cannot carry
 * exact process receipts or control claims.
 */
export function assertPublicInteractiveSurface(sandboxModule, interfaceModule) {
  const missing = [
    ...(typeof sandboxModule?.Sandbox !== 'function' ? ['Sandbox'] : []),
    ...(typeof sandboxModule?.TerminalStream !== 'function' ? ['TerminalStream'] : []),
    ...requireExactMethods(
      sandboxModule?.Sandbox?.prototype,
      ['create', 'get'],
      'Sandbox.prototype',
    ),
    ...requireExactMethods(
      sandboxModule?.InteractiveSessionHandle?.prototype,
      EXACT_HANDLE_METHODS,
      'InteractiveSessionHandle.prototype',
    ),
    ...requireExactMethods(
      sandboxModule?.TerminalStream?.prototype,
      EXACT_STREAM_METHODS,
      'TerminalStream.prototype',
    ),
    ...(typeof sandboxModule?.TerminalStream?.connect !== 'function'
      ? ['TerminalStream.connect']
      : []),
    ...EXACT_INTERFACE_FUNCTIONS.filter(
      (name) => typeof interfaceModule?.[name] !== 'function',
    ).map((name) => `agent-interface.${name}`),
  ]
  if (missing.length > 0) {
    throw capabilityUnavailable(
      'SANDBOX_INTERACTIVE_EXACT_SURFACE_UNAVAILABLE',
      `The public Sandbox interactive continuity contract is unavailable: ${missing.join(', ')}`,
      { missing },
    )
  }
  return Object.freeze({
    sandbox: sandboxModule,
    agentInterface: interfaceModule,
  })
}

export function assertSandboxSurface(box) {
  const missing = [
    ...requireExactMethods(
      box,
      ['session', 'capabilities', 'waitFor', 'delete'],
      'SandboxInstance',
    ),
    ...(box?.terminals === undefined ? ['SandboxInstance.terminals'] : []),
    ...requireExactMethods(box?.terminals, ['attach', 'get'], 'SandboxInstance.terminals'),
  ]
  if (missing.length > 0) {
    throw capabilityUnavailable(
      'SANDBOX_INTERACTIVE_RUNTIME_SURFACE_UNAVAILABLE',
      `The deployed Sandbox does not expose the native terminal surface: ${missing.join(', ')}`,
      { missing },
    )
  }
}

function configuration(environment) {
  const values = connectionConfiguration(directCredentialEnvironment(environment), {
    prefix: 'BRAID_TANGLE_SANDBOX',
    kind: 'tangle-sandbox-interactive-continuity',
    endpointNames: ['BRAID_TANGLE_ENDPOINT'],
    modelNames: ['BRAID_TANGLE_MODEL'],
    runnerNames: ['BRAID_TANGLE_RUNNER'],
    providerNames: ['BRAID_TANGLE_SANDBOX_PROVIDER'],
  })
  if (!values.credentialValue?.trim()) {
    throw capabilityUnavailable(
      'PROTECTED_CREDENTIAL_VALUE_REQUIRED',
      'The direct Sandbox continuity proof requires a raw API key for the public SDK client; a protected reference alone is insufficient.',
      { required: 'BRAID_TANGLE_SANDBOX_API_KEY or TANGLE_API_KEY' },
    )
  }
  return values
}

async function loadPublicApis(environment) {
  try {
    const [sandboxModule, interfaceModule] = await Promise.all([
      import('@tangle-network/sandbox'),
      import('@tangle-network/agent-interface'),
    ])
    return assertPublicInteractiveSurface(sandboxModule, interfaceModule)
  } catch (error) {
    if (error?.unavailable === true) throw error
    throw capabilityUnavailable(
      'SANDBOX_PUBLIC_PACKAGE_UNAVAILABLE',
      `The public Sandbox or Agent Interface package could not be loaded: ${safeMessage(error, environment)}`,
    )
  }
}

function markers(proofId) {
  const safe = safeIdentifier(proofId, 'proofId').replaceAll(':', '_')
  return {
    output: `BRAID_NATIVE_OUTPUT_${safe}`,
    input: `BRAID_NATIVE_INPUT_${safe}`,
    reconnect: `BRAID_NATIVE_RECONNECT_${safe}`,
  }
}

/** Build one exact AgentProfile-backed native start request. */
export function buildExactInteractiveStart({
  interfaceModule,
  environmentId,
  sessionId,
  executionId,
  proofId,
  runner,
  model,
  modelProvider = 'tangle',
  cols = DEFAULT_COLS,
  rows = DEFAULT_ROWS,
}) {
  const exactEnvironmentId = safeIdentifier(environmentId, 'environmentId')
  const exactSessionId = safeIdentifier(sessionId, 'sessionId')
  const exactExecutionId = safeIdentifier(executionId, 'executionId')
  const exactProofId = safeIdentifier(proofId, 'proofId')
  const profile = {
    name: `braid-native-continuity-${exactProofId}`,
    harness: runner,
    model: {
      default: model,
      provider: modelProvider,
    },
  }
  const requestedProfileDigest = interfaceModule.canonicalAgentProfileDigest(profile)
  const input = {
    profile,
    requestedProfileDigest,
    initialPrompt: `Reply with exactly ${markers(exactProofId).output}, then wait for my next terminal input.`,
    cwd: '.',
    cols,
    rows,
  }
  const run = interfaceModule.agentInteractiveSessionRunRef(
    {
      provider: SANDBOX_PROVIDER,
      environmentId: exactEnvironmentId,
      sessionId: exactSessionId,
      executionId: exactExecutionId,
    },
    input,
  )
  const start = interfaceModule.exactAgentInteractiveSessionStart({
    run,
    ...input,
  })
  return Object.freeze({
    start,
    run,
    profile,
    requestedProfileDigest,
    markers: markers(exactProofId),
  })
}

export function assertSameInteractiveRun(interfaceModule, expected, observed, label) {
  const context = `${label} [${expected?.runId ?? '<missing>'}/${expected?.sessionId ?? '<missing>'}/${expected?.executionId ?? '<missing>'}]`
  assert.ok(observed, `${context} returned no run reference`)
  assert.equal(
    interfaceModule.canonicalCandidateDigest(observed),
    interfaceModule.canonicalCandidateDigest(expected),
    `${context} changed its exact run reference`,
  )
  assert.equal(observed.runId, expected.runId, `${context} changed runId`)
  assert.equal(observed.provider, expected.provider, `${context} changed provider`)
  assert.equal(observed.environmentId, expected.environmentId, `${context} changed environmentId`)
  assert.equal(observed.sessionId, expected.sessionId, `${context} changed sessionId`)
  assert.equal(observed.executionId, expected.executionId, `${context} changed executionId`)
  assert.equal(observed.requestDigest, expected.requestDigest, `${context} changed requestDigest`)
}

export function assertSameInteractiveRef(interfaceModule, expected, observed, label) {
  const context = `${label} [${identityText(expected)}]`
  assert.ok(observed, `${context} returned no process reference`)
  assert.equal(
    interfaceModule.canonicalCandidateDigest(observed),
    interfaceModule.canonicalCandidateDigest(expected),
    `${context} changed its exact process reference`,
  )
  assert.equal(observed.run.runId, expected.run.runId, `${context} changed runId`)
  assert.equal(observed.run.provider, expected.run.provider, `${context} changed provider`)
  assert.equal(
    observed.run.environmentId,
    expected.run.environmentId,
    `${context} changed environmentId`,
  )
  assert.equal(observed.run.sessionId, expected.run.sessionId, `${context} changed sessionId`)
  assert.equal(observed.run.executionId, expected.run.executionId, `${context} changed executionId`)
  assert.equal(
    observed.run.requestDigest,
    expected.run.requestDigest,
    `${context} changed requestDigest`,
  )
  assert.equal(observed.incarnationId, expected.incarnationId, `${context} changed incarnationId`)
}

export function assertStatusForRef(interfaceModule, ref, status, label) {
  const context = `${label} [${identityText(ref)}]`
  assert.ok(status, `${context} returned no status`)
  assert.equal(status.state, 'running', `${context} is not running`)
  assert.equal(
    interfaceModule.agentInteractiveSessionStatusMatchesRef(ref, status),
    true,
    `${context} returned a status for a different process`,
  )
  assertSameInteractiveRef(interfaceModule, ref, status.ref, label)
  return status
}

export function assertControlForRef(interfaceModule, ref, control, label) {
  const context = `${label} [${identityText(ref)}]`
  assert.ok(control, `${context} returned no control claim`)
  assert.equal(
    interfaceModule.agentInteractiveSessionControlClaimMatchesRef(ref, control),
    true,
    `${context} returned a control claim for a different process`,
  )
  assert.ok(control.generation > 0, `${context} returned an invalid control generation`)
  assert.ok(
    Date.parse(control.expiresAt) > Date.now(),
    `${context} returned an expired control claim`,
  )
  return control
}

function checkRecord(name, boxId, ref, detail = {}) {
  return {
    name,
    status: 'passed',
    environmentId: boxId,
    runId: ref.run.runId,
    provider: ref.run.provider,
    sessionId: ref.run.sessionId,
    executionId: ref.run.executionId,
    incarnationId: ref.incarnationId,
    ...detail,
  }
}

function terminalCollector(environment) {
  let text = ''
  let bytes = 0
  const errors = []
  const decoder = new TextDecoder()
  const handlers = {
    onData(data) {
      bytes += data.byteLength
      text += decoder.decode(data, { stream: true })
    },
    onError(error) {
      errors.push({
        code: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
        message: safeMessage(error, environment),
      })
    },
  }
  return {
    handlers,
    get text() {
      return text
    },
    get bytes() {
      return bytes
    },
    get errors() {
      return [...errors]
    },
  }
}

async function waitForMarker(collector, marker, label, timeoutMs, from = 0) {
  return waitFor(
    label,
    () => {
      if (collector.errors.length > 0) {
        throw new Error(`${label} terminal stream error ${collector.errors[0].code}`)
      }
      return collector.text.slice(from).includes(marker)
    },
    timeoutMs,
  )
}

function assertReady(stream, sessionId, label) {
  const ready = stream.ready
  const context = `${label} [${sessionId}]`
  assert.equal(ready.connectionId, sessionId, `${context} changed terminal connectionId`)
  assert.equal(ready.sessionId, sessionId, `${context} changed terminal sessionId`)
  assert.equal(typeof ready.restored, 'boolean', `${context} omitted restored state`)
  assert.ok(
    Number.isSafeInteger(ready.detachTimeoutMs) && ready.detachTimeoutMs > 0,
    `${context} omitted the bounded detach timeout`,
  )
  return ready
}

function ownedBox(box, options, proofId) {
  return (
    box?.id &&
    box.name === options.name &&
    box.metadata?.owner === 'braid' &&
    box.metadata?.lifecycle === 'interactive-continuity' &&
    box.metadata?.proofId === proofId
  )
}

async function waitForDeleted(client, boxId, timeoutMs) {
  return waitFor(
    `Sandbox ${boxId} deletion`,
    async () => {
      const current = await client.get(boxId)
      if (current !== null) {
        assert.equal(current.id, boxId, `deletion lookup returned a different Sandbox for ${boxId}`)
        return false
      }
      return true
    },
    timeoutMs,
  )
}

async function waitForTerminalReaped(box, sessionId, ref, timeoutMs) {
  return waitFor(
    `PTY cleanup [${identityText(ref)}]`,
    async () => {
      const terminal = await box.terminals.get(sessionId)
      if (terminal === null) return { terminal: null }
      assert.equal(
        terminal.sessionId,
        sessionId,
        `PTY cleanup [${identityText(ref)}] returned a different session`,
      )
      assert.equal(
        terminal.isRunning,
        false,
        `PTY cleanup [${identityText(ref)}] still reports a running terminal`,
      )
      return { terminal }
    },
    timeoutMs,
  )
}

function createOptions(values, profile, proofId) {
  const name = `braid-native-continuity-${proofId}`
  return {
    environment: 'universal',
    agent: true,
    backend: {
      type: values.runner,
      profile,
    },
    name,
    metadata: {
      owner: 'braid',
      lifecycle: 'interactive-continuity',
      proofId,
      provider: SANDBOX_PROVIDER,
    },
    idempotencyKey: name,
    maxLifetimeSeconds: 900,
    idleTimeoutSeconds: 600,
  }
}

/**
 * Run the real native Sandbox continuity proof.
 *
 * This function never falls back to a shell, headless turn, direct WebSocket,
 * or private Sandbox route when the exact public contract is unavailable.
 */
export async function runInteractiveContinuityProof({
  environment = process.env,
  proofId = `run-${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`,
  timeoutMs = positiveInteger(
    environment.BRAID_TANGLE_SANDBOX_INTERACTIVE_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  ),
  sandboxModule,
  interfaceModule,
  clientFactory,
} = {}) {
  const startedAt = new Date().toISOString()
  const exactProofId = safeIdentifier(proofId, 'proofId')
  const values = configuration(environment)
  const apis =
    sandboxModule && interfaceModule
      ? assertPublicInteractiveSurface(sandboxModule, interfaceModule)
      : await loadPublicApis(environment)
  const client = clientFactory
    ? clientFactory({ values, sandbox: apis.sandbox })
    : new apis.sandbox.Sandbox({
        baseUrl: values.endpoint,
        apiKey: values.credentialValue,
      })
  if (!client || !hasMethod(client, 'create') || !hasMethod(client, 'get')) {
    throw capabilityUnavailable(
      'SANDBOX_CLIENT_SURFACE_UNAVAILABLE',
      'The public Sandbox client does not expose create() and get() required for exact resource ownership.',
    )
  }

  const sessionId = safeIdentifier(`session-${exactProofId}`, 'sessionId')
  const executionId = safeIdentifier(`execution-${exactProofId}`, 'executionId')
  let box
  let boxWasOwned = false
  let boxWasDeleted = false
  let handle
  let stream
  let startInfo
  let failure
  const checks = []
  const cleanupErrors = []
  const createProfile = {
    name: `braid-native-continuity-${exactProofId}`,
    harness: values.runner,
    model: {
      default: values.model,
      provider: values.provider,
    },
  }
  const options = createOptions(values, createProfile, exactProofId)
  try {
    box = await bounded('Sandbox create', () => client.create(options), timeoutMs)
    assertSandboxSurface(box)
    if (!ownedBox(box, options, exactProofId)) {
      throw new Error(
        `Created Sandbox ${box.id} did not retain the exact Braid ownership metadata for ${exactProofId}`,
      )
    }
    boxWasOwned = true
    await bounded('Sandbox waitFor running', () => box.waitFor('running', { timeoutMs }), timeoutMs)

    const capabilities = await bounded(
      'Sandbox capability document',
      () => box.capabilities(),
      timeoutMs,
    )
    if (capabilities?.schema !== 1) {
      throw capabilityUnavailable(
        'SANDBOX_CAPABILITIES_UNKNOWN',
        `Sandbox ${box.id} did not provide a recognized runtime capability document; native interactive support is not proven.`,
        { environmentId: box.id },
      )
    }

    const session = box.session(sessionId)
    if (!session || !hasMethod(session, 'interactive')) {
      throw capabilityUnavailable(
        'SANDBOX_INTERACTIVE_SESSION_UNAVAILABLE',
        `Sandbox ${box.id} does not expose the public interactive session controller for ${sessionId}.`,
        { environmentId: box.id, sessionId },
      )
    }
    handle = session.interactive()
    if (!handle || !EXACT_HANDLE_METHODS.every((method) => hasMethod(handle, method))) {
      throw capabilityUnavailable(
        'SANDBOX_INTERACTIVE_HANDLE_UNAVAILABLE',
        `Sandbox ${box.id} returned an incomplete interactive controller for ${sessionId}.`,
        { environmentId: box.id, sessionId },
      )
    }

    const exact = buildExactInteractiveStart({
      interfaceModule: apis.agentInterface,
      environmentId: box.id,
      sessionId,
      executionId,
      proofId: exactProofId,
      runner: values.runner,
      model: values.model,
      modelProvider: values.provider,
    })
    startInfo = await bounded(
      `Interactive start [${identityText(exact.start)}]`,
      () => handle.start(exact.start),
      timeoutMs,
    )
    assert.equal(
      startInfo.state,
      'running',
      `Interactive start [${identityText(exact.start)}] did not remain running`,
    )
    assert.equal(
      typeof startInfo.streamUrl,
      'string',
      `Interactive start [${identityText(exact.start)}] returned no terminal stream URL`,
    )
    assert.equal(
      apis.agentInterface.agentInteractiveSessionRefMatchesStart(exact.start, startInfo.ref),
      true,
      `Interactive start [${identityText(exact.start)}] returned an inexact process ref`,
    )
    assertSameInteractiveRun(apis.agentInterface, exact.start.run, startInfo.ref.run, 'start run')
    assertControlForRef(apis.agentInterface, startInfo.ref, startInfo.control, 'start control')
    const ref = startInfo.ref
    checks.push(
      checkRecord('start-identify-exact-process', box.id, ref, {
        refDigest: apis.agentInterface.canonicalCandidateDigest(ref),
        controlGeneration: startInfo.control.generation,
        preparationReceiptDigest: ref.preparationReceipt.digest,
      }),
    )

    const initialStatus = await bounded(
      `Interactive status after start [${identityText(ref)}]`,
      () => handle.status(),
      timeoutMs,
    )
    assertStatusForRef(apis.agentInterface, ref, initialStatus, 'status after start')

    const firstOutput = terminalCollector(environment)
    stream = await bounded(
      `Interactive attach [${identityText(ref)}]`,
      () =>
        handle.attach({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS, handlers: firstOutput.handlers }),
      timeoutMs,
    )
    assert.ok(
      stream && EXACT_STREAM_METHODS.every((method) => hasMethod(stream, method)),
      `Interactive attach [${identityText(ref)}] returned an incomplete terminal stream`,
    )
    const firstReady = assertReady(stream, sessionId, 'initial attach')
    checks.push(
      checkRecord('attach-exact-process', box.id, ref, {
        connectionId: firstReady.connectionId,
        restored: firstReady.restored,
        controlGeneration: startInfo.control.generation,
      }),
    )

    await waitForMarker(
      firstOutput,
      exact.markers.output,
      `native output [${identityText(ref)}]`,
      timeoutMs,
    )
    checks.push(
      checkRecord('receive-output', box.id, ref, {
        marker: exact.markers.output,
        bytes: firstOutput.bytes,
      }),
    )

    const inputStart = firstOutput.text.length
    stream.write(`${exact.markers.input}\r`)
    await waitForMarker(
      firstOutput,
      exact.markers.input,
      `native input echo [${identityText(ref)}]`,
      timeoutMs,
      inputStart,
    )
    checks.push(
      checkRecord('send-input', box.id, ref, {
        marker: exact.markers.input,
        inputBytes: Buffer.byteLength(`${exact.markers.input}\r`),
      }),
    )

    await bounded(`Interactive detach [${identityText(ref)}]`, () => stream.close(), timeoutMs)
    assert.equal(
      stream.isOpen,
      false,
      `Interactive detach [${identityText(ref)}] left the terminal socket open`,
    )
    const detachedStatus = await bounded(
      `Interactive status after detach [${identityText(ref)}]`,
      () => handle.status(),
      timeoutMs,
    )
    assertStatusForRef(apis.agentInterface, ref, detachedStatus, 'status after detach')
    checks.push(checkRecord('detach-preserves-process', box.id, ref))

    const reconnectedOutput = terminalCollector(environment)
    const reconnected = await bounded(
      `Interactive reconnect [${identityText(ref)}]`,
      () => stream.reconnect({ handlers: reconnectedOutput.handlers }),
      timeoutMs,
    )
    stream = reconnected
    const reconnectedReady = assertReady(stream, sessionId, 'reconnect')
    assert.equal(
      reconnectedReady.restored,
      true,
      `Interactive reconnect [${identityText(ref)}] created a new PTY instead of restoring the same one`,
    )
    await waitForMarker(
      reconnectedOutput,
      exact.markers.output,
      `reconnect replay [${identityText(ref)}]`,
      timeoutMs,
    )
    const reconnectInputStart = reconnectedOutput.text.length
    stream.write(`${exact.markers.reconnect}\r`)
    await waitForMarker(
      reconnectedOutput,
      exact.markers.reconnect,
      `reconnect input [${identityText(ref)}]`,
      timeoutMs,
      reconnectInputStart,
    )
    const reconnectedStatus = await bounded(
      `Interactive status after reconnect [${identityText(ref)}]`,
      () => handle.status(),
      timeoutMs,
    )
    assertStatusForRef(apis.agentInterface, ref, reconnectedStatus, 'status after reconnect')
    checks.push(
      checkRecord('reconnect-same-incarnation-control', box.id, ref, {
        connectionId: reconnectedReady.connectionId,
        restored: reconnectedReady.restored,
        replayedMarker: exact.markers.output,
        controlContinuity: 'TerminalStream.reconnect reused the attached exact control claim',
      }),
    )

    const staleRef = {
      ...ref,
      incarnationId: `${ref.incarnationId}-stale`,
    }
    const staleHandle = session.interactive({ ref: staleRef, control: startInfo.control })
    let staleStatusError
    await assert.rejects(
      () =>
        bounded(
          `Stale identity status [${identityText(staleRef)}]`,
          () => staleHandle.status(),
          timeoutMs,
        ),
      (error) => {
        staleStatusError = error
        assert.equal(
          isStaleInteractiveIdentityError(error),
          true,
          `Stale identity [${identityText(staleRef)}] returned an unrelated status error`,
        )
        return true
      },
    )
    await assert.rejects(
      () => staleHandle.attach({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS }),
      (error) => {
        return isStaleInteractiveIdentityError(error)
      },
    )
    checks.push(
      checkRecord('stale-identity-rejected', box.id, ref, {
        rejectedIncarnationId: staleRef.incarnationId,
        statusErrorCode:
          typeof staleStatusError?.code === 'string' ? staleStatusError.code : null,
      }),
    )

    await bounded(
      `Interactive second detach [${identityText(ref)}]`,
      () => stream.close(),
      timeoutMs,
    )
    const stopAcknowledgement = await bounded(
      `Interactive lifecycle stop [${identityText(ref)}]`,
      () => handle.stopLifecycle(),
      timeoutMs,
    )
    assert.ok(
      stopAcknowledgement.status === 'accepted' || stopAcknowledgement.status === 'replayed',
      `Interactive lifecycle stop [${identityText(ref)}] was not acknowledged`,
    )
    assert.notEqual(
      stopAcknowledgement.effect,
      'unknown',
      `Interactive lifecycle stop [${identityText(ref)}] returned an unknown effect`,
    )
    assertSameInteractiveRef(
      apis.agentInterface,
      ref,
      stopAcknowledgement.ref,
      'lifecycle stop ref',
    )
    assertControlForRef(
      apis.agentInterface,
      ref,
      stopAcknowledgement.control,
      'lifecycle stop control',
    )
    const exitedStatus = await waitFor(
      `Interactive exit [${identityText(ref)}]`,
      async () => {
        const status = await handle.status()
        if (!status) return false
        assertSameInteractiveRef(apis.agentInterface, ref, status.ref, 'exit status ref')
        return status.state === 'exited' ? status : false
      },
      timeoutMs,
    )
    assert.equal(
      exitedStatus.reason,
      'stopped',
      `Interactive exit [${identityText(ref)}] was not caused by the exact stop request`,
    )
    checks.push(
      checkRecord('stop-exact-process', box.id, ref, {
        acknowledgementStatus: stopAcknowledgement.status,
        effect: stopAcknowledgement.effect,
        reason: exitedStatus.reason,
      }),
    )

    const reaped = await waitForTerminalReaped(box, sessionId, ref, timeoutMs)
    checks.push(
      checkRecord('stop-reaps-pty', box.id, ref, {
        terminalPresentAfterStop: reaped.terminal !== null,
      }),
    )

    await bounded(`Sandbox delete ${box.id}`, () => box.delete(), timeoutMs)
    boxWasDeleted = true
    await waitForDeleted(client, box.id, timeoutMs)
    checks.push(checkRecord('delete-exact-sandbox', box.id, ref))

    return {
      schema: 'braid.live-required.interactive-continuity.v1',
      operation: OPERATION,
      status: 'passed',
      startedAt,
      completedAt: new Date().toISOString(),
      connection: {
        endpoint: endpointEvidence(values.endpoint),
        connectionKind: 'tangle-sandbox-public-sdk',
        credentialConfigured: true,
        model: values.model,
        runner: values.runner,
        provider: values.provider,
      },
      run: {
        environmentId: box.id,
        runId: startInfo.ref.run.runId,
        provider: startInfo.ref.run.provider,
        sessionId,
        executionId,
        incarnationId: startInfo.ref.incarnationId,
        refDigest: apis.agentInterface.canonicalCandidateDigest(startInfo.ref),
        preparationReceiptDigest: startInfo.ref.preparationReceipt.digest,
      },
      capabilities: {
        schema: capabilities.schema,
        agentInterface: capabilities.agentInterface,
        sidecarVersion: capabilities.sidecarVersion,
        image: capabilities.image,
      },
      checks,
      observations: {
        outputMarker: exact.markers.output,
        inputMarker: exact.markers.input,
        reconnectMarker: exact.markers.reconnect,
        ptyDeleted: reaped.terminal === null,
      },
    }
  } catch (error) {
    failure = error
  } finally {
    if (stream?.isOpen) {
      try {
        await bounded('failure detach', () => stream.close(), timeoutMs)
      } catch (error) {
        cleanupErrors.push(safeMessage(error, environment))
      }
    }
    if (box && boxWasOwned && !boxWasDeleted) {
      if (handle && startInfo) {
        try {
          await bounded(
            `failure lifecycle stop [${identityText(startInfo.ref)}]`,
            () => handle.stopLifecycle(),
            timeoutMs,
          )
        } catch (error) {
          cleanupErrors.push(safeMessage(error, environment))
        }
      }
      try {
        await bounded(
          `failure PTY cleanup [${box.id}/${sessionId}]`,
          () =>
            waitForTerminalReaped(
              box,
              sessionId,
              startInfo?.ref ?? { run: { runId: '<not-started>' }, incarnationId: '<not-started>' },
              timeoutMs,
            ),
          timeoutMs,
        )
      } catch (error) {
        cleanupErrors.push(safeMessage(error, environment))
      }
      try {
        await bounded(`failure Sandbox delete ${box.id}`, () => box.delete(), timeoutMs)
        boxWasDeleted = true
        await waitForDeleted(client, box.id, timeoutMs)
      } catch (error) {
        cleanupErrors.push(safeMessage(error, environment))
      }
    }
  }

  if (failure) {
    if (cleanupErrors.length > 0) {
      failure.cleanupErrors = cleanupErrors
    }
    throw failure
  }
  throw new Error('Interactive continuity proof ended without a result')
}

export function safeErrorRecord(error, environment = process.env) {
  let details
  if (error?.details && typeof error.details === 'object') {
    try {
      details = JSON.parse(safeJson(error.details, environment))
    } catch {
      details = '[REDACTED]'
    }
  }
  return {
    name: error instanceof Error ? error.name : 'Error',
    code: typeof error?.code === 'string' ? error.code : 'BRAID_INTERACTIVE_CONTINUITY_FAILED',
    unavailable: error?.unavailable === true,
    message: safeMessage(error, environment),
    ...(details === undefined ? {} : { details }),
    ...(Array.isArray(error?.cleanupErrors) ? { cleanupErrors: error.cleanupErrors } : {}),
  }
}

export async function main(argv = process.argv, environment = process.env) {
  const proofId = argument('proof-id', argv)
  try {
    const result = await runInteractiveContinuityProof({
      environment,
      ...(proofId === undefined ? {} : { proofId }),
    })
    process.stdout.write(`${safeJson(result, environment)}\n`)
    return EXIT_CODES.passed
  } catch (error) {
    const unavailable = error?.unavailable === true
    const report = {
      schema: 'braid.live-required.interactive-continuity.v1',
      operation: OPERATION,
      status: unavailable ? 'unavailable' : 'failed',
      error: safeErrorRecord(error, environment),
    }
    process.stderr.write(`${safeJson(report, environment)}\n`)
    return unavailable ? EXIT_CODES.unavailable : EXIT_CODES.failed
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code
  })
}
