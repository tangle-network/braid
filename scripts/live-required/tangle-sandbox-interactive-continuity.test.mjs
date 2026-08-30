import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertControlForRef,
  assertPublicInteractiveSurface,
  assertSameInteractiveRef,
  assertStatusForRef,
  buildExactInteractiveStart,
  isStaleInteractiveIdentityError,
  safeErrorRecord,
} from './tangle-sandbox-interactive-continuity.mjs'

function exactControl(refDigest, generation = 1) {
  return {
    refDigest,
    generation,
    leaseId: `lease-${generation}`,
    holderId: `holder-${generation}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
}

function fakeSandboxModule({ exact = true } = {}) {
  class Sandbox {}
  class InteractiveSessionHandle {}
  class TerminalStream {}
  for (const name of ['create', 'get']) Sandbox.prototype[name] = () => {}
  for (const name of exact
    ? ['start', 'attach', 'status', 'claimControl', 'sendPrompt', 'stop', 'stopLifecycle']
    : ['start', 'attach', 'status', 'sendPrompt', 'stop']) {
    InteractiveSessionHandle.prototype[name] = () => {}
  }
  for (const name of ['write', 'close', 'reconnect']) TerminalStream.prototype[name] = () => {}
  TerminalStream.connect = () => {}
  return { Sandbox, InteractiveSessionHandle, TerminalStream }
}

function fakeInterfaceModule() {
  return {
    agentInteractiveSessionRunRef: () => {},
    agentInteractiveSessionRefMatchesStart: () => true,
    agentInteractiveSessionStatusMatchesRef: () => true,
    agentInteractiveSessionControlClaimMatchesRef: () => true,
    agentInteractiveSessionPromptRequestDigest: () => `sha256:${'a'.repeat(64)}`,
    agentInteractiveSessionStopRequestDigest: () => `sha256:${'b'.repeat(64)}`,
    canonicalAgentProfileDigest: () => `sha256:${'c'.repeat(64)}`,
    canonicalCandidateDigest: (value) => JSON.stringify(value),
    exactAgentInteractiveSessionStart: (value) => value,
  }
}

class FakeTerminalWebSocket {
  static OPEN = 1

  static CLOSED = 3

  static frames = []

  static sockets = []

  constructor(url, protocols) {
    this.url = url
    this.protocols = protocols
    this.readyState = 0
    this.binaryType = 'blob'
    this.listeners = new Map()
    FakeTerminalWebSocket.sockets.push(this)
    queueMicrotask(() => {
      this.readyState = FakeTerminalWebSocket.OPEN
      this.emit('open', {})
    })
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  send(payload) {
    const frame = JSON.parse(payload)
    FakeTerminalWebSocket.frames.push({ socket: this, frame })
    if (frame.type === 'init') {
      const initCount = FakeTerminalWebSocket.frames.filter(
        ({ frame: candidate }) => candidate.type === 'init',
      ).length
      queueMicrotask(() =>
        this.emit('message', {
          data: JSON.stringify({
            type: 'ready',
            connectionId: frame.connectionId,
            sessionId: frame.connectionId,
            restored: initCount > 1,
            detachTimeoutMs: 5_000,
          }),
        }),
      )
      queueMicrotask(() =>
        this.emit('message', {
          data: new TextEncoder().encode(`replay-${frame.connectionId}`).buffer,
        }),
      )
    }
    if (frame.type === 'input') {
      queueMicrotask(() =>
        this.emit('message', {
          data: new TextEncoder().encode(`echo-${frame.data}`).buffer,
        }),
      )
    }
  }

  close(code = 1000, reason = '') {
    if (this.readyState === FakeTerminalWebSocket.CLOSED) return
    this.readyState = FakeTerminalWebSocket.CLOSED
    queueMicrotask(() => this.emit('close', { code, reason }))
  }
}

const EXACT_INCARNATION_ID = '00000000-0000-4000-8000-000000000001'

test('missing exact public methods are a hard unavailable result', () => {
  assert.throws(
    () =>
      assertPublicInteractiveSurface(fakeSandboxModule({ exact: false }), fakeInterfaceModule()),
    (error) =>
      error.unavailable === true &&
      error.code === 'SANDBOX_INTERACTIVE_EXACT_SURFACE_UNAVAILABLE' &&
      error.details.missing.includes('InteractiveSessionHandle.prototype.claimControl'),
  )
})

test('the installed public package either satisfies the exact surface or reports its blocker', async () => {
  const sandboxModule = await import('@tangle-network/sandbox')
  const interfaceModule = await import('@tangle-network/agent-interface')
  try {
    const surface = assertPublicInteractiveSurface(sandboxModule, interfaceModule)
    assert.equal(surface.sandbox, sandboxModule)
  } catch (error) {
    assert.equal(error.unavailable, true)
    assert.equal(error.code, 'SANDBOX_INTERACTIVE_EXACT_SURFACE_UNAVAILABLE')
  }
})

test('exact start material binds one run to one profile and session', () => {
  const interfaceModule = {
    ...fakeInterfaceModule(),
    canonicalAgentProfileDigest: () => `sha256:${'1'.repeat(64)}`,
    agentInteractiveSessionRunRef: (coordinates, _input) => ({
      ...coordinates,
      runId: 'interactive-run-test',
      requestDigest: `sha256:${'2'.repeat(64)}`,
    }),
  }
  const exact = buildExactInteractiveStart({
    interfaceModule,
    environmentId: 'sandbox-1',
    sessionId: 'session-1',
    executionId: 'execution-1',
    proofId: 'proof-1',
    runner: 'pi',
    model: 'test-model',
    modelProvider: 'tangle-router',
  })
  assert.equal(exact.start.run.environmentId, 'sandbox-1')
  assert.equal(exact.start.run.sessionId, 'session-1')
  assert.equal(exact.start.run.executionId, 'execution-1')
  assert.equal(exact.start.profile.harness, 'pi')
  assert.match(exact.start.initialPrompt, /BRAID_NATIVE_OUTPUT_proof-1/u)
})

test('same-ref assertions reject a changed incarnation and accept an exact replay', () => {
  const interfaceModule = {
    canonicalCandidateDigest: (value) => JSON.stringify(value),
  }
  const expected = {
    run: {
      runId: 'run-1',
      provider: 'tangle-sandbox',
      environmentId: 'sandbox-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      requestDigest: `sha256:${'a'.repeat(64)}`,
    },
    incarnationId: 'incarnation-1',
  }
  assert.doesNotThrow(() =>
    assertSameInteractiveRef(interfaceModule, expected, structuredClone(expected), 'reconnect'),
  )
  assert.throws(
    () =>
      assertSameInteractiveRef(
        interfaceModule,
        expected,
        { ...structuredClone(expected), incarnationId: 'incarnation-stale' },
        'stale identity',
      ),
    /changed its exact process reference/u,
  )
})

test('stale identity requires the explicit sidecar conflict code', () => {
  const stale = Object.assign(new Error('Interactive session incarnation is stale'), {
    code: 'STALE_INCARNATION',
  })
  assert.equal(isStaleInteractiveIdentityError(stale), true)
  assert.equal(
    isStaleInteractiveIdentityError(new Error('Interactive session identity is stale')),
    false,
  )
  assert.equal(
    isStaleInteractiveIdentityError(
      Object.assign(new Error('stale'), { code: 'stale_incarnation' }),
    ),
    false,
  )
  assert.equal(isStaleInteractiveIdentityError(new Error('Interactive session not found')), false)
  assert.equal(
    isStaleInteractiveIdentityError(
      Object.assign(new Error('identity service unavailable'), { code: 'TRANSPORT' }),
    ),
    false,
  )
})

test('status and control assertions stay bound to the exact process', () => {
  const ref = {
    run: {
      runId: 'run-2',
      provider: 'tangle-sandbox',
      environmentId: 'sandbox-2',
      sessionId: 'session-2',
      executionId: 'execution-2',
      requestDigest: `sha256:${'b'.repeat(64)}`,
    },
    incarnationId: 'incarnation-2',
  }
  const interfaceModule = {
    canonicalCandidateDigest: (value) => JSON.stringify(value),
    agentInteractiveSessionStatusMatchesRef: () => true,
    agentInteractiveSessionControlClaimMatchesRef: () => true,
  }
  assertStatusForRef(
    interfaceModule,
    ref,
    { state: 'running', ref: structuredClone(ref) },
    'status',
  )
  assertControlForRef(interfaceModule, ref, exactControl(`sha256:${'c'.repeat(64)}`), 'control')
})

test('error evidence does not expose a credential', () => {
  const secret = 'sk-test-continuity-secret'
  const record = safeErrorRecord(new Error(`upstream rejected ${secret}`), {
    BRAID_TANGLE_SANDBOX_API_KEY: secret,
  })
  assert.equal(record.message.includes(secret), false)
})

test('public TerminalStream proves input, detach, and same-connection replay with a fake server', async () => {
  const { TerminalStream } = await import('@tangle-network/sandbox')
  const previousWebSocket = globalThis.WebSocket
  FakeTerminalWebSocket.frames = []
  FakeTerminalWebSocket.sockets = []
  globalThis.WebSocket = FakeTerminalWebSocket
  const output = []
  const control = {
    refDigest: `sha256:${'d'.repeat(64)}`,
    generation: 1,
    leaseId: 'lease-unit',
    holderId: 'holder-unit',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
  try {
    const first = await TerminalStream.connect({
      url: 'https://sandbox.test/terminals/session-unit/ws',
      token: 'unit-token',
      connectionId: 'session-unit',
      incarnationId: EXACT_INCARNATION_ID,
      control,
      handlers: {
        onData(data) {
          output.push(new TextDecoder().decode(data))
        },
      },
    })
    assert.equal(first.ready.connectionId, 'session-unit')
    assert.equal(first.ready.restored, false)
    first.write('input-unit\r')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await first.close()

    const second = await first.reconnect({
      handlers: {
        onData(data) {
          output.push(new TextDecoder().decode(data))
        },
      },
    })
    assert.equal(second.ready.connectionId, 'session-unit')
    assert.equal(second.ready.restored, true)
    second.write('reconnect-unit\r')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await second.close()

    const initFrames = FakeTerminalWebSocket.frames.filter(({ frame }) => frame.type === 'init')
    assert.equal(initFrames.length, 2)
    assert.deepEqual(
      initFrames.map(({ frame }) => frame.connectionId),
      ['session-unit', 'session-unit'],
    )
    assert.deepEqual(
      FakeTerminalWebSocket.frames
        .filter(({ frame }) => frame.type === 'input')
        .map(({ frame }) => frame.data),
      ['input-unit\r', 'reconnect-unit\r'],
    )
    assert.equal(
      output.some((chunk) => chunk.includes('echo-input-unit')),
      true,
    )
    assert.equal(
      output.some((chunk) => chunk.includes('replay-session-unit')),
      true,
    )
    if (Object.hasOwn(initFrames[0].frame, 'incarnationId')) {
      assert.equal(initFrames[0].frame.incarnationId, EXACT_INCARNATION_ID)
      assert.deepEqual(initFrames[0].frame.control, control)
      assert.equal(initFrames[1].frame.incarnationId, EXACT_INCARNATION_ID)
      assert.deepEqual(initFrames[1].frame.control, control)
    }
  } finally {
    globalThis.WebSocket = previousWebSocket
  }
})
