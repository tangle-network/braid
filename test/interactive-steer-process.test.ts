import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FileObserverJournal } from '@tangle-network/agent-runtime/durable'
import type { BraidEventEnvelope } from '../src/domain/events.js'
import type { BraidState } from '../src/domain/state.js'
import { interactiveProviderServer } from './support/interactive-provider-network.js'

interface Reply {
  readonly id?: number
  readonly ready?: boolean
  readonly error?: string
  readonly result?: {
    readonly acknowledgement?: { readonly outcome: string }
    readonly replayed?: boolean
  }
  readonly state: BraidState
  readonly events?: readonly BraidEventEnvelope[]
}

async function child(root: string, endpoint: string, timeout = 5_000) {
  const process = fork(new URL('./support/interactive-steer-child.js', import.meta.url), [], {
    env: {
      ...globalThis.process.env,
      STEER_TEST_ROOT: root,
      STEER_TEST_ENDPOINT: endpoint,
      STEER_TEST_TIMEOUT: String(timeout),
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  let stderr = ''
  process.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const pending = new Map<
    number,
    { resolve: (reply: Reply) => void; reject: (error: Error) => void }
  >()
  let nextId = 0
  let lateError: string | undefined
  let initialResolve!: (reply: Reply) => void
  let initialReject!: (error: Error) => void
  const ready = new Promise<Reply>((resolve, reject) => {
    initialResolve = resolve
    initialReject = reject
  })
  process.on('message', (reply: Reply) => {
    if (reply.ready) {
      initialResolve(reply)
      return
    }
    const waiter = pending.get(reply.id ?? -1)
    if (waiter === undefined) {
      if (reply.error) lateError = reply.error
      return
    }
    pending.delete(reply.id ?? -1)
    if (reply.error) waiter.reject(new Error(`${reply.error}\n${stderr}`))
    else waiter.resolve(reply)
  })
  const exit = once(process, 'exit')
  process.on('exit', () => {
    const error = new Error(`Braid child exited: ${stderr}`)
    initialReject(error)
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  })
  const initial = await ready
  return {
    initial,
    request: (command: string, params: Record<string, unknown> = {}) =>
      new Promise<Reply>((resolve, reject) => {
        const id = ++nextId
        pending.set(id, { resolve, reject })
        process.send({ id, command, operationId: `op-${command}-${id}`, ...params })
      }),
    kill: async () => {
      if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL')
      await exit
    },
    lateError: () => lateError,
  }
}

async function turns(root: string, sessionId: string, operationId: string) {
  return (
    await new FileObserverJournal(
      join(root, 'runtime-journal', sessionId, 'observer.jsonl'),
      sessionId,
    ).read()
  ).filter(
    (record) =>
      record.event?.target === 'agent.turn' &&
      (record.event.payload as { operationId?: string })?.operationId === operationId,
  )
}

test('live owner survives a second process steer, replay, duplicate event, disconnect and cancellation', {
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-steer-process-'))
  const server = await interactiveProviderServer()
  const children: Awaited<ReturnType<typeof child>>[] = []
  const open = async () => {
    const value = await child(root, server.endpoint)
    children.push(value)
    return value
  }
  try {
    const owner = await open()
    const started = await owner.request('send', { text: 'Inspect the workspace.' })
    const run = started.state.runs[0]
    assert.ok(run?.providerSessionId)
    const initialEvents = started.events ?? []
    const controlCalls = server.calls.length
    const steering = await open()
    assert.equal(steering.initial.state.runs[0]?.status, run.status)
    assert.equal(
      server.calls.length,
      controlCalls,
      'reading a live owner must not contact its provider',
    )
    await assert.rejects(
      steering.request('reconnect', { runId: run.id }),
      /Another live Braid process/,
    )
    const params = { runId: run.id, text: 'Run the tests.', operationId: 'op-steer-once' }
    const first = await steering.request('steer', params)
    assert.equal(first.result?.acknowledgement?.outcome, 'accepted')
    assert.equal(first.state.runs[0]?.status, run.status)
    await steering.request('shutdown')
    await steering.kill()
    const replay = await open()
    assert.equal((await replay.request('steer', params)).result?.replayed, true)
    assert.equal((await turns(root, run.providerSessionId, params.operationId)).length, 1)
    assert.deepEqual(server.fixture.prompts, ['Run the tests.'])
    await replay.request('shutdown')
    await replay.kill()
    // A stale conditional write refuses after foreign receipt sync; ordinary writes still work.
    await assert.rejects(owner.request('conditional'), /expected/)
    // The owner's next commit must absorb foreign control events without a sequence collision.
    const detached = await owner.request('detach', { runId: run.id })
    assert.equal(detached.state.runs[0]?.status, 'detached')
    await owner.kill()
    const recovered = await open()
    await recovered.request('reconnect', { runId: run.id })
    // Replay an actually observed provider event twice through the same application ingress.
    const observed = initialEvents.find((entry) => entry.event.kind === 'run.environment.observed')
    assert.ok(observed)
    const duplicate = await recovered.request('duplicate', {
      runId: run.id,
      event:
        observed.event.kind === 'run.environment.observed'
          ? {
              runId: run.id,
              eventId: observed.event.provider.eventId,
              sequence: observed.event.provider.providerSequence,
              cursor: observed.event.provider.cursor,
              receivedAt: observed.occurredAt,
              event: {
                type: 'braid.execution.observed',
                observation: observed.event.observation,
                controlRef: observed.event.controlRef,
                timestamp: observed.occurredAt,
              },
            }
          : undefined,
    })
    assert.equal(duplicate.state.runs[0]?.lastProviderSequence, 1)
    server.delay('stop', 5_500)
    const cancelled = await recovered.request('cancel', { runId: run.id })
    assert.equal(
      cancelled.result?.acknowledgement?.outcome,
      'accepted',
      JSON.stringify({
        result: cancelled.result,
        run: cancelled.state.runs[0],
        calls: server.calls,
      }),
    )
    assert.equal(cancelled.state.runs[0]?.status, 'cancelled')
    assert.equal((await turns(root, run.providerSessionId, params.operationId)).length, 1)
    assert.equal(server.fixture.creates, 1, 'recovery creates no replacement environment')
    await recovered.request('shutdown')
  } finally {
    await Promise.all(children.map((value) => value.kill()))
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('steer deadline leaves delivery alive and late acceptance settles durably through RPC shutdown', {
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-steer-late-'))
  const server = await interactiveProviderServer()
  const children: Awaited<ReturnType<typeof child>>[] = []
  try {
    const owner = await child(root, server.endpoint)
    children.push(owner)
    const started = await owner.request('send', { text: 'Inspect the workspace.' })
    const run = started.state.runs[0]
    assert.ok(run?.providerSessionId)
    server.delay('sendPrompt', 400)
    const steering = await child(root, server.endpoint, 60)
    children.push(steering)
    const params = { runId: run.id, text: 'Summarize.', operationId: 'op-late-steer' }
    const foreground = await steering.request('steer', params)
    assert.equal(foreground.result?.acknowledgement?.outcome, 'unknown')
    assert.equal(
      foreground.state.runs[0]?.status,
      run.status,
      'steer uncertainty is not run uncertainty',
    )
    await steering.request('shutdown')
    const replay = await child(root, server.endpoint)
    children.push(replay)
    assert.equal(
      (await replay.request('steer', params)).result?.acknowledgement?.outcome,
      'accepted',
    )
    assert.equal((await turns(root, run.providerSessionId, params.operationId)).length, 1)
    await replay.request('shutdown')
    const cancelled = await owner.request('cancel', { runId: run.id })
    assert.equal(cancelled.state.runs[0]?.status, 'cancelled')
    await owner.request('shutdown')
    // The journal remains readable after each process has closed its own storage.
    assert.ok(
      (
        await readFile(
          join(root, 'runtime-journal', run.providerSessionId, 'observer.jsonl'),
          'utf8',
        )
      ).includes('op-late-steer'),
    )
  } finally {
    await Promise.all(children.map((value) => value.kill()))
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

async function until(ready: () => boolean, label: string) {
  const started = Date.now()
  while (!ready()) {
    if (Date.now() - started > 15_000) throw new Error(label)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('a 1001 terminal close reattaches a live run and stop destroys that sandbox once', {
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-terminal-1001-'))
  const server = await interactiveProviderServer()
  server.fixture.attachPlan = ['shutdown', 'live']
  const children: Awaited<ReturnType<typeof child>>[] = []
  try {
    const owner = await child(root, server.endpoint)
    children.push(owner)
    const ready = await owner.request('view', { text: 'Inspect the workspace.' })
    const run = ready.state.runs[0]
    const controlRef = run?.controlRef
    assert.ok(run && controlRef, `run status before reattach ${run?.status}`)
    await until(
      () => server.fixture.attaches >= 2 || owner.lateError() !== undefined,
      'terminal did not reattach after code 1001',
    )
    assert.equal(owner.lateError(), undefined)
    assert.equal(server.fixture.attaches, 2)
    const stopper = await child(root, server.endpoint)
    children.push(stopper)
    const visible = stopper.initial.state.runs.find((candidate) => candidate.id === run.id)
    assert.ok(
      visible?.status === 'streaming' ||
        visible?.status === 'running' ||
        visible?.status === 'waiting' ||
        visible?.status === 'starting',
      `reattached run status ${visible?.status}`,
    )
    const cancelled = await stopper.request('cancel', { runId: run.id })
    assert.ok(
      cancelled.result?.acknowledgement?.outcome === 'accepted' ||
        cancelled.result?.acknowledgement?.outcome === 'already-applied',
      JSON.stringify(cancelled.result),
    )
    assert.ok(
      cancelled.state.runs[0]?.status === 'cancelled' ||
        cancelled.state.runs[0]?.status === 'aborted',
    )
    assert.deepEqual(server.fixture.stopEnvironmentIds, [controlRef.environmentId])
    assert.deepEqual(server.fixture.destroyedIds, [controlRef.environmentId])
    assert.equal(owner.lateError(), undefined, owner.lateError())
  } finally {
    await Promise.all(children.map((value) => value.kill()))
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('unknown retained run is cancelled only after stop and sandbox release are both confirmed', {
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-terminal-unknown-stop-'))
  const server = await interactiveProviderServer()
  const children: Awaited<ReturnType<typeof child>>[] = []
  const open = async () => {
    const value = await child(root, server.endpoint)
    children.push(value)
    return value
  }
  try {
    const owner = await open()
    const started = await owner.request('send', { text: 'Inspect the workspace.' })
    const run = started.state.runs[0]
    assert.ok(run?.controlRef)
    const environmentId = run.controlRef.environmentId
    server.fixture.sessionState = 'unknown'
    const stopper = await open()
    const reconciled = await stopper.request('reconcile', { runId: run.id })
    assert.equal(reconciled.state.runs[0]?.status, 'unknown')
    assert.ok(reconciled.state.runs[0]?.controlRef)
    server.fixture.stopEffect = 'unknown'
    const withheld = await stopper.request('cancel', { runId: run.id })
    assert.equal(withheld.result?.acknowledgement?.outcome, 'unknown')
    assert.equal(withheld.state.runs[0]?.status, 'unknown')
    assert.deepEqual(server.fixture.destroyedIds, [])
    assert.deepEqual(server.fixture.stopEnvironmentIds, [environmentId])
    server.fixture.stopEffect = 'stopped'
    server.fixture.destroyError = true
    const unreleased = await stopper.request('cancel', { runId: run.id })
    assert.equal(unreleased.result?.acknowledgement?.outcome, 'unknown')
    assert.equal(unreleased.state.runs[0]?.status, 'unknown')
    assert.deepEqual(server.fixture.destroyedIds, [])
    server.fixture.destroyError = false
    const released = await stopper.request('cancel', { runId: run.id })
    assert.equal(released.result?.acknowledgement?.outcome, 'accepted')
    assert.equal(released.state.runs[0]?.status, 'cancelled')
    assert.deepEqual(server.fixture.destroyedIds, [environmentId])
    assert.ok(server.fixture.stopEnvironmentIds.every((id) => id === environmentId))
  } finally {
    await Promise.all(children.map((value) => value.kill()))
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})
