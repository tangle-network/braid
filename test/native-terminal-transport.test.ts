import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  AgentTerminalSession,
  TerminalDetachAck,
  TerminalInput,
  TerminalOutputEvent,
  TerminalResize,
  TerminalSessionRef,
} from '@tangle-network/agent-interface'
import { createNativeTerminalTransport } from '../src/index.js'
import type {
  NativeTerminalHost,
  NativeTerminalSignalPort,
} from '../src/ports/native-terminal-transport.js'

const sessionId = 'terminal-transport-test'

class EventStream<T> {
  private readonly values: T[] = []
  private closed = false
  private resolveNext: ((value: T | undefined) => void) | undefined

  push(value: T): void {
    if (this.closed) throw new Error('event stream is closed')
    const resolve = this.resolveNext
    this.resolveNext = undefined
    if (resolve !== undefined) resolve(value)
    else this.values.push(value)
  }

  close(): void {
    this.closed = true
    const resolve = this.resolveNext
    this.resolveNext = undefined
    resolve?.(undefined)
  }

  async *read(signal?: AbortSignal): AsyncIterable<T> {
    while (true) {
      const value = await this.next(signal)
      if (value === undefined) return
      yield value
    }
  }

  private next(signal?: AbortSignal): Promise<T | undefined> {
    if (signal?.aborted || this.closed) return Promise.resolve(undefined)
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve(value)
    return new Promise((resolve) => {
      const onAbort = (): void => {
        if (this.resolveNext === resolveNext) this.resolveNext = undefined
        resolve(undefined)
      }
      const resolveNext = (next: T | undefined): void => {
        signal?.removeEventListener('abort', onAbort)
        resolve(next)
      }
      this.resolveNext = resolveNext
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

class FakeTerminal implements NativeTerminalHost {
  columns = 80
  rows = 24
  readonly writes: string[] = []
  startCount = 0
  stopCount = 0
  private onInputHandler: ((data: string) => void) | undefined
  private onResizeHandler: (() => void) | undefined

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.startCount += 1
    this.onInputHandler = onInput
    this.onResizeHandler = onResize
  }

  stop(): void {
    this.stopCount += 1
    this.onInputHandler = undefined
    this.onResizeHandler = undefined
  }

  write(data: string): void {
    this.writes.push(data)
  }

  input(data: string): void {
    this.onInputHandler?.(data)
  }

  resize(columns: number, rows: number): void {
    this.columns = columns
    this.rows = rows
    this.onResizeHandler?.()
  }
}

class FakeSignals implements NativeTerminalSignalPort {
  takeOverCount = 0
  releaseCount = 0
  private handler: ((exitCode: number) => void) | undefined

  takeOver(handler: (exitCode: number) => void): () => void {
    this.takeOverCount += 1
    this.handler = handler
    return () => {
      this.releaseCount += 1
      this.handler = undefined
    }
  }

  emit(exitCode: number): void {
    this.handler?.(exitCode)
  }
}

class FakeSession implements AgentTerminalSession {
  readonly ref: TerminalSessionRef = {
    terminalSessionId: sessionId,
    parentExecutionId: 'execution-transport-test',
    name: 'native transport test',
    shell: '/bin/sh',
    cwd: '/workspace',
    cols: 80,
    rows: 24,
    createdAt: '2026-08-16T00:00:00.000Z',
    lastActivityAt: '2026-08-16T00:00:00.000Z',
    expiresAt: '2026-08-17T00:00:00.000Z',
    isRunning: true,
    attachCount: 1,
  }
  readonly cursors = { earliest: 0, latest: 0 }
  readonly inputs: TerminalInput[] = []
  readonly resizes: TerminalResize[] = []
  readonly stream = new EventStream<TerminalOutputEvent>()
  detachCount = 0
  closeCount = 0
  detachAck: TerminalDetachAck = { status: 'detached', terminalSessionId: sessionId }

  input(input: TerminalInput, options?: { signal?: AbortSignal }): Promise<void> {
    if (options?.signal?.aborted) return Promise.reject(new Error('input aborted'))
    this.inputs.push(input)
    return Promise.resolve()
  }

  resize(resize: TerminalResize, options?: { signal?: AbortSignal }): Promise<void> {
    if (options?.signal?.aborted) return Promise.reject(new Error('resize aborted'))
    this.resizes.push(resize)
    return Promise.resolve()
  }

  detach(options?: { signal?: AbortSignal }): Promise<TerminalDetachAck> {
    this.detachCount += 1
    if (options?.signal?.aborted) return Promise.reject(new Error('detach aborted'))
    return Promise.resolve(this.detachAck)
  }

  close(): Promise<TerminalDetachAck> {
    this.closeCount += 1
    return Promise.resolve({ status: 'closed', terminalSessionId: sessionId })
  }

  events(options?: { signal?: AbortSignal }): AsyncIterable<TerminalOutputEvent> {
    return this.stream.read(options?.signal)
  }
}

class HungInputSession extends FakeSession {
  inputStarted: (() => void) | undefined
  inputSignal: AbortSignal | undefined

  override input(input: TerminalInput, options?: { signal?: AbortSignal }): Promise<void> {
    this.inputs.push(input)
    this.inputSignal = options?.signal
    this.inputStarted?.()
    return new Promise<void>(() => {})
  }
}

class HungResizeSession extends FakeSession {
  resizeStarted: (() => void) | undefined
  resizeSignal: AbortSignal | undefined

  override resize(resize: TerminalResize, options?: { signal?: AbortSignal }): Promise<void> {
    this.resizes.push(resize)
    this.resizeSignal = options?.signal
    this.resizeStarted?.()
    return new Promise<void>(() => {})
  }
}

function fixture(session: FakeSession = new FakeSession()) {
  const terminal = new FakeTerminal()
  const signals = new FakeSignals()
  const transport = createNativeTerminalTransport({ session, terminal, signals })
  return { session, terminal, signals, transport }
}

async function started(terminal: FakeTerminal): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (terminal.startCount === 1) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.fail('transport did not start the local terminal')
}

async function settlesWithin<T>(promise: Promise<T>, timeoutMs = 250): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`promise did not settle within ${timeoutMs}ms`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

test('forwards output and restores terminal and signal state', async () => {
  const { session, terminal, signals, transport } = fixture()
  const running = transport.run()
  await started(terminal)
  session.stream.push({ type: 'output', seq: 0, data: '\u001b[2Jremote-ui' })
  session.stream.push({ type: 'exit', exitCode: 0 })

  const result = await running
  assert.deepEqual(terminal.writes, ['\u001b[2Jremote-ui'])
  assert.deepEqual(result.outcome, {
    kind: 'remote-exit',
    sessionId,
    reason: 'exited',
    exitCode: 0,
  })
  assert.equal(result.cleanup.terminal, 'restored')
  assert.equal(result.cleanup.signal, 'restored')
  assert.equal(result.cleanup.remote, 'not-required')
  assert.equal(terminal.stopCount, 1)
  assert.equal(signals.releaseCount, 1)
  assert.equal(session.detachCount, 0)
  assert.equal(session.closeCount, 0)
})

test('forwards local input without interpreting the remote TUI', async () => {
  const { session, terminal, transport } = fixture()
  const running = transport.run()
  await started(terminal)
  terminal.input('hello remote')
  await new Promise<void>((resolve) => setImmediate(resolve))
  session.stream.push({ type: 'exit', exitCode: 0 })

  await running
  assert.deepEqual(session.inputs, [{ data: 'hello remote' }])
})

test('forwards the current local resize once', async () => {
  const { session, terminal, transport } = fixture()
  const running = transport.run()
  await started(terminal)
  terminal.resize(132, 43)
  await new Promise<void>((resolve) => setImmediate(resolve))
  session.stream.push({ type: 'exit', exitCode: 0 })

  await running
  assert.deepEqual(session.resizes, [{ cols: 132, rows: 43 }])
})

test('detaches on Ctrl+] and leaves the remote process running', async () => {
  const { session, terminal, transport } = fixture()
  const running = transport.run()
  await started(terminal)
  terminal.input('before\u001dignored')

  const result = await running
  assert.deepEqual(session.inputs, [{ data: 'before' }])
  assert.deepEqual(result.outcome, { kind: 'detached', sessionId, trigger: 'user' })
  assert.equal(result.cleanup.remote, 'detached')
  assert.equal(session.detachCount, 1)
  assert.equal(session.closeCount, 0)
  assert.equal(terminal.stopCount, 1)
})

test('detaches promptly when an in-flight input never settles', async () => {
  const session = new HungInputSession()
  const inputStarted = new Promise<void>((resolve) => {
    session.inputStarted = resolve
  })
  const { terminal, transport } = fixture(session)
  const running = transport.run()
  await started(terminal)
  terminal.input('before detach')
  await inputStarted
  terminal.input('\u001d')

  const result = await settlesWithin(running)
  assert.deepEqual(result.outcome, { kind: 'detached', sessionId, trigger: 'user' })
  assert.equal(result.cleanup.remote, 'detached')
  assert.equal(terminal.stopCount, 1)
  assert.equal(session.detachCount, 1)
  assert.equal(session.inputSignal?.aborted, true)
})

test('stops promptly and cancels queued resizes when one resize never settles', async () => {
  const session = new HungResizeSession()
  const resizeStarted = new Promise<void>((resolve) => {
    session.resizeStarted = resolve
  })
  const { terminal, transport } = fixture(session)
  const controller = new AbortController()
  const running = transport.run({ signal: controller.signal })
  await started(terminal)
  terminal.resize(132, 43)
  await resizeStarted
  terminal.resize(160, 50)
  controller.abort()

  const result = await settlesWithin(running)
  assert.deepEqual(result.outcome, { kind: 'aborted', sessionId, source: 'caller' })
  assert.equal(result.cleanup.remote, 'detached')
  assert.equal(terminal.stopCount, 1)
  assert.equal(session.detachCount, 1)
  assert.deepEqual(session.resizes, [{ cols: 132, rows: 43 }])
  assert.equal(session.resizeSignal?.aborted, true)
})

test('reports a remote exit without detaching or closing it', async () => {
  const { session, terminal, transport } = fixture()
  const running = transport.run()
  await started(terminal)
  session.stream.push({ type: 'exit', exitSignal: 'SIGTERM' })

  const result = await running
  assert.deepEqual(result.outcome, {
    kind: 'remote-exit',
    sessionId,
    reason: 'exited',
    exitSignal: 'SIGTERM',
  })
  assert.equal(session.detachCount, 0)
  assert.equal(session.closeCount, 0)
})

test('reports transport errors and preserves the remote process', async () => {
  const { session, terminal, transport } = fixture()
  const running = transport.run()
  await started(terminal)
  session.stream.push({ type: 'error', message: 'remote stream failed' })

  const result = await running
  assert.deepEqual(result.outcome, {
    kind: 'transport-error',
    sessionId,
    phase: 'events',
    message: 'remote stream failed',
  })
  assert.equal(result.cleanup.remote, 'detached')
  assert.equal(session.detachCount, 1)
  assert.equal(session.closeCount, 0)
})

test('aborts from the caller and restores every local boundary', async () => {
  const { session, terminal, signals, transport } = fixture()
  const controller = new AbortController()
  const running = transport.run({ signal: controller.signal })
  await started(terminal)
  controller.abort()

  const result = await running
  assert.deepEqual(result.outcome, { kind: 'aborted', sessionId, source: 'caller' })
  assert.equal(result.cleanup.terminal, 'restored')
  assert.equal(result.cleanup.signal, 'restored')
  assert.equal(result.cleanup.remote, 'detached')
  assert.equal(signals.releaseCount, 1)
  assert.equal(session.closeCount, 0)
})

test('aborts from the process signal latch with a typed exit code', async () => {
  const { session, terminal, signals, transport } = fixture()
  const running = transport.run()
  await started(terminal)
  signals.emit(130)

  const result = await running
  assert.deepEqual(result.outcome, { kind: 'aborted', sessionId, source: 'signal', exitCode: 130 })
  assert.equal(result.cleanup.signal, 'restored')
  assert.equal(signals.takeOverCount, 1)
  assert.equal(signals.releaseCount, 1)
  assert.equal(session.closeCount, 0)
})

test('memoizes the run and makes cleanup idempotent', async () => {
  const { session, terminal, signals, transport } = fixture()
  const first = transport.run()
  const second = transport.run()
  assert.equal(first, second)
  await started(terminal)
  session.stream.push({ type: 'exit', exitCode: 0 })

  const result = await first
  assert.equal(await transport.run(), result)
  assert.equal(terminal.stopCount, 1)
  assert.equal(signals.takeOverCount, 1)
  assert.equal(signals.releaseCount, 1)
  assert.equal(session.detachCount, 0)
})
