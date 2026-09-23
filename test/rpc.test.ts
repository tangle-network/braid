import assert from 'node:assert/strict'
import test from 'node:test'
import { createBraidApplication, DETERMINISTIC_PROFILE } from '../src/app/composition.js'
import { FixedClock } from '../src/ports/clock.js'
import { SequenceIds } from '../src/ports/ids.js'
import { DeterministicInteractionRuntime } from '../src/testing/deterministic-interaction-runtime.js'
import {
  keyboardAnswerForView,
  responseForInteractionIntent,
} from '../src/views/shared/interaction-intent.js'
import type { BraidResponse } from '../src/views/headless/protocol.js'
import { RPC_REPLAY_MAX_BYTES, RPC_REPLAY_MAX_ENTRIES, runRpc } from '../src/views/headless/rpc.js'

async function* requestInput(lines: readonly object[]): AsyncGenerator<string> {
  yield `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
}

test('keyboard and headless interaction submission share one canonical response', async () => {
  const runtime = new DeterministicInteractionRuntime()
  const app = createBraidApplication({
    fixture: 'deterministic',
    interactionRuntime: runtime,
    clock: new FixedClock(),
    ids: new SequenceIds(),
  })
  runtime.registerPending('run-equivalence', 'interaction-equivalence')
  app.receiveInteraction({
    runId: 'run-equivalence',
    request: {
      id: 'interaction-equivalence',
      kind: 'question',
      title: 'Provide a value',
      answerSpec: {
        fields: [{ type: 'text', name: 'value', label: 'Value', required: true }],
      },
    },
  })
  const view = app.interactionController()?.views()[0]
  assert.ok(view)
  const keyboardResponse = responseForInteractionIntent(
    view.interactionId,
    keyboardAnswerForView(view, 'same answer'),
  )
  let output = ''
  const code = await runRpc(
    app,
    requestInput([
      {
        version: 1,
        requestId: 'req-init-equivalence',
        command: 'initialize',
        params: { workspace: '/workspace' },
      },
      {
        version: 1,
        requestId: 'req-respond-equivalence',
        operationId: 'op-equivalence',
        command: 'respond_interaction',
        params: {
          runId: 'run-equivalence',
          interactionId: 'interaction-equivalence',
          ...(view.profileDigest === undefined ? {} : { profileDigest: view.profileDigest }),
          ...(view.conversationId === undefined ? {} : { conversationId: view.conversationId }),
          ...(view.branchId === undefined ? {} : { branchId: view.branchId }),
          ...(view.model === undefined ? {} : { model: view.model }),
          ...(view.runner === undefined ? {} : { runner: view.runner }),
          ...(view.requestRevision === undefined ? {} : { requestRevision: view.requestRevision }),
          response: keyboardResponse,
        },
      },
      { version: 1, requestId: 'req-stop-equivalence', command: 'shutdown' },
    ]),
    {
      write: (chunk) => {
        output += chunk
        return true
      },
    },
  )
  const responses = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as BraidResponse)
  const acknowledgement = responses.find(
    (response) => response.type === 'ack' && response.requestId === 'req-respond-equivalence',
  )
  assert.equal(code, 0)
  assert.equal(acknowledgement?.type, 'ack')
  if (acknowledgement?.type !== 'ack') assert.fail('missing interaction acknowledgement')
  assert.equal(acknowledgement.interactionStatus, 'accepted')
  assert.equal(app.state().interactions[0]?.status, 'resolved')
  assert.deepEqual(runtime.calls, [
    {
      key: '15:run-equivalence|23:interaction-equivalence',
      operationId: 'op-equivalence',
      outcome: 'accepted',
    },
  ])
})

test('JSONL send acknowledges before events and returns final semantic state', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  let output = ''
  const code = await runRpc(
    app,
    requestInput([
      {
        version: 1,
        requestId: 'req-init',
        command: 'initialize',
        params: { workspace: '/workspace', subscribe: true },
      },
      {
        version: 1,
        requestId: 'req-send',
        operationId: 'op-rpc',
        command: 'send',
        params: {
          conversationId: 'conv-1',
          branchId: 'branch-1',
          text: 'hello Braid',
        },
      },
      { version: 1, requestId: 'req-stop', command: 'shutdown' },
    ]),
    {
      write: (chunk) => {
        output += chunk
        return true
      },
    },
  )
  const responses = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as BraidResponse)
  const sendAck = responses.findIndex(
    (response) => response.type === 'ack' && response.requestId === 'req-send',
  )
  const firstRunEvent = responses.findIndex(
    (response) => response.type === 'event' && response.event.kind === 'run.requested',
  )
  const finalState = responses.find(
    (response) => response.type === 'state' && response.requestId === 'req-send',
  )

  assert.equal(code, 0)
  assert.ok(sendAck >= 0)
  assert.ok(firstRunEvent > sendAck)
  assert.equal(finalState?.type, 'state')
  if (finalState?.type !== 'state') assert.fail('missing final state')
  assert.equal(finalState.state.messages[1]?.text, 'Fixture response through pi: hello Braid')
  assert.equal(finalState.state.runs[0]?.status, 'completed')
})

test('JSONL requires initialize and stable operation identity', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  let output = ''
  await runRpc(
    app,
    requestInput([
      {
        version: 1,
        requestId: 'req-send',
        operationId: 'op-rpc',
        command: 'send',
        params: { text: 'too early' },
      },
    ]),
    {
      write: (chunk) => {
        output += chunk
        return true
      },
    },
  )
  const response = JSON.parse(output) as BraidResponse
  assert.equal(response.type, 'error')
  if (response.type !== 'error') assert.fail('missing error')
  assert.equal(response.code, 'INITIALIZE_REQUIRED')
})

test('JSONL replays identical request IDs and rejects changed bodies', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  let output = ''
  await runRpc(
    app,
    requestInput([
      {
        version: 1,
        requestId: 'req-init',
        command: 'initialize',
        params: { workspace: '/workspace' },
      },
      { version: 1, requestId: 'req-state', command: 'get_state' },
      { version: 1, requestId: 'req-state', command: 'get_state' },
      { version: 1, requestId: 'req-state', command: 'shutdown' },
      { version: 1, requestId: 'req-stop', command: 'shutdown' },
    ]),
    {
      write: (chunk) => {
        output += chunk
        return true
      },
    },
  )
  const responses = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as BraidResponse)
  const replayed = responses.filter(
    (response) => response.type === 'state' && response.requestId === 'req-state',
  )
  const conflict = responses.find(
    (response) => response.type === 'error' && response.requestId === 'req-state',
  )

  assert.equal(replayed.length, 2)
  assert.deepEqual(replayed[1], replayed[0])
  assert.equal(conflict?.type, 'error')
  if (conflict?.type !== 'error') assert.fail('missing request ID conflict')
  assert.equal(conflict.code, 'REQUEST_ID_CONFLICT')
})

test('JSONL rejects wrong optional types and unknown fields', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  let output = ''
  await runRpc(
    app,
    requestInput([
      {
        version: 1,
        requestId: 'req-bad-init',
        command: 'initialize',
        params: { workspace: '/workspace', subscribe: 'yes' },
      },
      {
        version: 1,
        requestId: 'req-init',
        command: 'initialize',
        params: { workspace: '/workspace' },
      },
      {
        version: 1,
        requestId: 'req-bad-branch',
        operationId: 'op-bad-branch',
        command: 'send',
        params: { text: 'wrong branch type', branchId: 42 },
      },
      {
        version: 1,
        requestId: 'req-extra',
        command: 'get_state',
        params: { extra: true },
      },
      { version: 1, requestId: 'req-stop', command: 'shutdown' },
    ]),
    {
      write: (chunk) => {
        output += chunk
        return true
      },
    },
  )
  const errors = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as BraidResponse)
    .filter((response) => response.type === 'error')

  assert.deepEqual(
    errors.map((error) => error.code),
    ['INVALID_PARAMS', 'INVALID_PARAMS', 'INVALID_PARAMS'],
  )
  assert.equal(app.state().messages.length, 0)
})

test('JSONL operation replay returns current state after later sends', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  let output = ''
  await runRpc(
    app,
    requestInput([
      {
        version: 1,
        requestId: 'req-init',
        command: 'initialize',
        params: { workspace: '/workspace' },
      },
      {
        version: 1,
        requestId: 'req-a',
        operationId: 'op-a',
        command: 'send',
        params: { text: 'first' },
      },
      {
        version: 1,
        requestId: 'req-b',
        operationId: 'op-b',
        command: 'send',
        params: { text: 'second' },
      },
      {
        version: 1,
        requestId: 'req-a-replay',
        operationId: 'op-a',
        command: 'send',
        params: { text: 'first' },
      },
      { version: 1, requestId: 'req-stop', command: 'shutdown' },
    ]),
    {
      write: (chunk) => {
        output += chunk
        return true
      },
    },
  )
  const replayState = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as BraidResponse)
    .find((response) => response.type === 'state' && response.requestId === 'req-a-replay')

  assert.equal(replayState?.type, 'state')
  if (replayState?.type !== 'state') assert.fail('missing replay state')
  assert.equal(replayState.state.messages.length, 4)
  assert.equal(replayState.state.revision, app.state().revision)
})

test('JSONL bounds direct-response replay while operation replay stays safe', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  let output = ''
  const filler = Array.from({ length: RPC_REPLAY_MAX_ENTRIES }, (_, index) => ({
    version: 1,
    requestId: `req-filler-${index}`,
    command: 'get_state',
  }))
  await runRpc(
    app,
    requestInput([
      {
        version: 1,
        requestId: 'req-init',
        command: 'initialize',
        params: { workspace: '/workspace' },
      },
      {
        version: 1,
        requestId: 'req-send-old',
        operationId: 'op-once',
        command: 'send',
        params: { text: 'execute once' },
      },
      ...filler,
      {
        version: 1,
        requestId: 'req-send-retry',
        operationId: 'op-once',
        command: 'send',
        params: { text: 'execute once' },
      },
      {
        version: 1,
        requestId: 'req-send-retry',
        operationId: 'op-once',
        command: 'send',
        params: { text: 'execute once' },
      },
      { version: 1, requestId: 'req-stop', command: 'shutdown' },
    ]),
    {
      write: (chunk) => {
        output += chunk
        return true
      },
    },
  )
  const responses = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as BraidResponse)
  const replayAcks = responses.filter(
    (response) => response.type === 'ack' && response.requestId === 'req-send-retry',
  )

  assert.equal(app.state().runs.length, 1)
  assert.equal(app.state().messages.length, 2)
  assert.equal(replayAcks.length, 2)
  assert.equal(replayAcks[0]?.type, 'ack')
  if (replayAcks[0]?.type !== 'ack') assert.fail('missing operation replay acknowledgement')
  assert.equal(replayAcks[0].replayed, true)
  assert.deepEqual(replayAcks[1], replayAcks[0])
})

test('JSONL replays bounded state without duplicating the operation', async () => {
  const app = createBraidApplication({
    fixture: 'deterministic',
    profile: {
      ...DETERMINISTIC_PROFILE,
      description: 'x'.repeat(256 * 1024),
    },
  })
  const states: Array<{ readonly requestId: string; readonly revision: number }> = []
  async function* input(): AsyncGenerator<string> {
    yield `${JSON.stringify({
      version: 1,
      requestId: 'req-init',
      command: 'initialize',
      params: { workspace: '/workspace' },
    })}\n`
    for (const requestId of ['req-a', 'req-b', 'req-c']) {
      yield `${JSON.stringify({ version: 1, requestId, command: 'get_state' })}\n`
    }
    await app.send({ operationId: 'op-after-cache', text: 'advance state' }).completion
    yield `${JSON.stringify({ version: 1, requestId: 'req-c', command: 'get_state' })}\n`
    yield `${JSON.stringify({ version: 1, requestId: 'req-a', command: 'get_state' })}\n`
    yield `${JSON.stringify({ version: 1, requestId: 'req-stop', command: 'shutdown' })}\n`
  }

  await runRpc(app, input(), {
    write: (chunk) => {
      const response = JSON.parse(chunk) as BraidResponse
      if (
        response.type === 'state' &&
        (response.requestId === 'req-a' || response.requestId === 'req-c')
      ) {
        states.push({ requestId: response.requestId, revision: response.revision })
      }
      return true
    },
  })
  const a = states.filter((state) => state.requestId === 'req-a')
  const c = states.filter((state) => state.requestId === 'req-c')

  assert.equal(a.length, 2)
  assert.equal(c.length, 2)
  assert.equal(a[1]?.revision, a[0]?.revision)
  assert.equal(c[1]?.revision, c[0]?.revision)
})

test('profiles exceeding the external string bound are rejected before JSONL state exists', () => {
  assert.throws(
    () =>
      createBraidApplication({
        fixture: 'deterministic',
        profile: {
          ...DETERMINISTIC_PROFILE,
          description: 'x'.repeat(RPC_REPLAY_MAX_BYTES),
        },
      }),
    /UTF-8 byte limit/u,
  )
})
