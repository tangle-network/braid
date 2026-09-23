import assert from 'node:assert/strict'
import test from 'node:test'
import { TUI } from '@earendil-works/pi-tui'
import type { InteractionRequest } from '@tangle-network/agent-interface'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import { AppError } from '../src/app/application.js'
import { buildAppView } from '../src/app/view-model.js'
import { createBraidApplication } from '../src/app/composition.js'
import {
  MAX_INTERACTION_FIELDS,
  MAX_ERROR_BYTES,
  MAX_ID_BYTES,
  MAX_OUTPUT_QUEUE_BYTES,
  MAX_PROVIDER_EVENTS,
  MAX_RPC_LINE_BYTES,
  MAX_TEXT_BYTES,
  truncateUtf8,
  redactSensitiveText,
} from '../src/domain/bounds.js'
import { parseInteractionRequest } from '../src/domain/interaction.js'
import { runtimeQuestionRequest } from '../src/app/runtime-interaction.js'
import { OutputQueue } from '../src/views/headless/rpc.js'
import { RpcEventBuffer } from '../src/views/headless/rpc-event-buffer.js'
import { parseRpcRequest } from '../src/views/headless/rpc-request.js'
import { linesOf } from '../src/views/headless/rpc-lines.js'
import { RuntimeStreamBudget } from '../src/app/runtime-stream-budget.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { DeterministicInteractionRuntime } from '../src/testing/deterministic-interaction-runtime.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

function question(id: string, answerSpec: InteractionRequest['answerSpec']): InteractionRequest {
  return { id, kind: 'question', title: id, answerSpec }
}

test('W14 JSONL lines are bounded in UTF-8 bytes before parsing', async () => {
  async function* exact(): AsyncGenerator<string> {
    yield `${'x'.repeat(MAX_RPC_LINE_BYTES)}\n`
  }
  const exactLines: string[] = []
  for await (const line of linesOf(exact())) exactLines.push(line)
  assert.equal(exactLines[0]?.length, MAX_RPC_LINE_BYTES)

  async function* oversized(): AsyncGenerator<string> {
    yield `${'x'.repeat(MAX_RPC_LINE_BYTES + 1)}\n`
  }
  await assert.rejects(
    async () => {
      for await (const _line of linesOf(oversized())) {
        // The generator must reject before yielding the oversized line.
      }
    },
    (error: unknown) => error instanceof AppError && error.code === 'INPUT_TOO_LARGE',
  )
  assert.equal(Buffer.byteLength(truncateUtf8('é', 1)), 0)
  assert.equal(truncateUtf8('éa', 2), 'é')
  assert.throws(
    () =>
      parseRpcRequest(
        JSON.stringify({
          version: 1,
          requestId: 'x'.repeat(MAX_ID_BYTES + 1),
          command: 'initialize',
          params: { workspace: '/workspace' },
        }),
      ),
    (error: unknown) => error instanceof AppError && error.code === 'INPUT_TOO_LARGE',
  )
})

test('W15 interaction fields are bounded at 1000', () => {
  const parsed = parseInteractionRequest(
    question('too-many-fields', {
      fields: Array.from({ length: MAX_INTERACTION_FIELDS + 1 }, (_, index) => ({
        type: 'text' as const,
        name: `field-${index}`,
        label: `Field ${index}`,
      })),
    }),
  )
  assert.equal(parsed.ok, false)
})

test('interaction timeouts and redaction remain bounded at the byte boundary', () => {
  const invalidTimeout = parseInteractionRequest({
    ...question('unsafe-timeout', {
      fields: [{ type: 'text', name: 'value', label: 'Value', required: true }],
    }),
    timeoutMs: Number.MAX_SAFE_INTEGER,
  })
  assert.equal(invalidTimeout.ok, false)

  const secret = 'S'.repeat(MAX_ERROR_BYTES + 1)
  const redacted = redactSensitiveText(secret, [secret])
  assert.equal(redacted, '<REDACTED>')
  assert.equal(Buffer.byteLength(redacted) <= MAX_ERROR_BYTES, true)
})

test('direct interaction responses are bounded before fingerprinting or provider effects', async () => {
  const runtime = new DeterministicInteractionRuntime()
  const app = createBraidApplication({ fixture: 'deterministic', interactionRuntime: runtime })
  app.receiveInteraction({
    runId: 'run-response-bound',
    request: question('response-bound', {
      fields: [{ type: 'text', name: 'value', label: 'Value', required: true }],
    }),
  })
  const view = app.interactionController().views()[0]
  assert.ok(view)
  await assert.rejects(
    app.respondInteraction({
      runId: view.runId,
      interactionId: view.interactionId,
      ...(view.providerSessionId === undefined
        ? {}
        : { providerSessionId: view.providerSessionId }),
      ...(view.profileDigest === undefined ? {} : { profileDigest: view.profileDigest }),
      ...(view.connectionId === undefined ? {} : { connectionId: view.connectionId }),
      ...(view.workspaceId === undefined ? {} : { workspaceId: view.workspaceId }),
      ...(view.conversationId === undefined ? {} : { conversationId: view.conversationId }),
      ...(view.branchId === undefined ? {} : { branchId: view.branchId }),
      ...(view.model === undefined ? {} : { model: view.model }),
      ...(view.runner === undefined ? {} : { runner: view.runner }),
      ...(view.requestRevision === undefined ? {} : { requestRevision: view.requestRevision }),
      operationId: 'operation-response-bound',
      response: {
        id: view.interactionId,
        outcome: 'accepted',
        data: { value: 'x'.repeat(MAX_TEXT_BYTES + 1) },
      },
    }),
    /UTF-8 byte limit/u,
  )
  assert.equal(runtime.calls.length, 0)
  assert.equal(app.state().interactions[0]?.status, 'pending')
  app.shutdown()
})

test('W16 select options require non-empty labels and bounded structure', () => {
  const emptyLabel = parseInteractionRequest(
    question('empty-option-label', {
      fields: [
        {
          type: 'select',
          name: 'choice',
          label: 'Choice',
          options: [{ value: 'a', label: '' }],
        },
      ],
    }),
  )
  assert.equal(emptyLabel.ok, false)

  let nested: unknown = 'leaf'
  for (let index = 0; index < 40; index += 1) nested = { nested }
  const line = JSON.stringify({
    version: 1,
    requestId: 'deep',
    command: 'initialize',
    params: { workspace: nested },
  })
  assert.throws(
    () => parseRpcRequest(line),
    (error: unknown) => error instanceof AppError && error.code === 'INPUT_TOO_LARGE',
  )
  assert.equal(Buffer.byteLength('é'.repeat(MAX_TEXT_BYTES / 2 + 1)) > MAX_TEXT_BYTES, true)
  assert.equal(
    parseInteractionRequest(
      question('\u0000', {
        fields: [{ type: 'text', name: 'value', label: 'Value' }],
      }),
    ).ok,
    false,
  )
})

test('runtime questions reject oversized choices, unknown answer types, and invalid defaults', () => {
  assert.throws(() =>
    runtimeQuestionRequest({
      id: 'runtime-options',
      question: 'Choose',
      reason: 'Needed',
      answerType: 'select_one',
      impactIfUnknown: 'Cannot continue',
      options: Array.from({ length: 257 }, (_, index) => `option-${index}`),
    }),
  )
  assert.throws(() =>
    runtimeQuestionRequest({
      id: 'runtime-empty-option',
      question: 'Choose',
      reason: 'Needed',
      answerType: 'select_one',
      impactIfUnknown: 'Cannot continue',
      options: ['valid', ''],
    }),
  )
  assert.throws(() =>
    runtimeQuestionRequest({
      id: 'runtime-unknown',
      question: 'Unknown',
      reason: 'Needed',
      answerType: 'future-answer',
      impactIfUnknown: 'Cannot continue',
    }),
  )
  const invalidDefault = parseInteractionRequest({
    ...question('invalid-default', {
      fields: [{ type: 'text', name: 'value', label: 'Value', required: true }],
    }),
    default: { outcome: 'accepted', data: {} },
  })
  assert.equal(invalidDefault.ok, false)
})

test('W19 JSONL output waits for drain and preserves order', async () => {
  let blocked = true
  let release!: () => void
  const writes: string[] = []
  const queue = new OutputQueue({
    write(chunk) {
      writes.push(chunk)
      return !blocked
    },
    waitForDrain() {
      return new Promise<void>((resolve) => {
        release = () => {
          blocked = false
          resolve()
        }
      })
    },
  })
  queue.enqueue('first')
  queue.enqueue('second')
  await Promise.resolve()
  assert.deepEqual(writes, ['first'])
  release()
  await queue.flush()
  assert.deepEqual(writes, ['first', 'second'])
  assert.throws(
    () => queue.enqueue('x'.repeat(MAX_OUTPUT_QUEUE_BYTES + 1)),
    (error: unknown) => error instanceof AppError && error.code === 'OUTPUT_BACKPRESSURE',
  )
})

test('provider and buffered event streams reject bounded-resource exhaustion', () => {
  const budget = new RuntimeStreamBudget()
  const event = { type: 'text_delta', text: 'x' } as RuntimeStreamEvent
  for (let index = 0; index < MAX_PROVIDER_EVENTS; index += 1) budget.accept(event)
  assert.throws(() => budget.accept(event), /too many events/u)

  const buffer = new RpcEventBuffer()
  buffer.begin()
  for (let index = 0; index < 256; index += 1) {
    buffer.add({
      eventId: `event-${index}`,
      sequence: index + 1,
      revision: index + 1,
      occurredAt: '2026-08-01T00:00:00.000Z',
      event: { kind: 'workspace.opened', workspace: '/workspace' },
    })
  }
  assert.throws(
    () =>
      buffer.add({
        eventId: 'event-overflow',
        sequence: 257,
        revision: 257,
        occurredAt: '2026-08-01T00:00:00.000Z',
        event: { kind: 'workspace.opened', workspace: '/workspace' },
      }),
    (error: unknown) => error instanceof AppError && error.code === 'OUTPUT_BACKPRESSURE',
  )
  assert.equal(buffer.take().length, 256)
})

test('W25 invalid mixed secret terminal input is cleared from the editor and viewport', async () => {
  const terminal = new VirtualTerminal(80, 24)
  const tui = new TUI(terminal)
  const runtime = new DeterministicInteractionRuntime()
  const app = createBraidApplication({ fixture: 'deterministic', interactionRuntime: runtime })
  app.initialize('/workspace')
  app.receiveInteraction({
    runId: 'run-secret-terminal',
    request: question('secret-terminal', {
      fields: [
        {
          type: 'select',
          name: 'choice',
          label: 'Choice',
          required: true,
          options: [{ value: 'safe', label: 'Safe' }],
        },
        { type: 'secret', name: 'token', label: 'Token', required: true },
      ],
    }),
  })
  const view = new BraidTerminalApp({
    app,
    tui,
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => 'terminal-secret-operation',
  })
  const done = view.start()
  await terminal.waitForRender()
  view.editor.setText('choice=invalid\ntoken=CANARY-SECRET-1234')
  terminal.sendInput('\r')
  await terminal.waitForRender()
  assert.equal(view.editor.getText(), '')
  assert.equal(terminal.getViewport().join('\n').includes('CANARY-SECRET-1234'), false)
  view.stop()
  await done
  app.shutdown()
})

test('W26 unknown interaction and run results remain typed', async () => {
  for (const status of ['unknown_interaction', 'unknown_run'] as const) {
    const runtime = new DeterministicInteractionRuntime({ responseStatus: status })
    const app = createBraidApplication({
      fixture: 'deterministic',
      interactionRuntime: runtime,
    })
    const runId = `run-typed-${status}`
    const interactionId = `typed-${status}`
    app.receiveInteraction({
      runId,
      request: question(interactionId, {
        fields: [{ type: 'text', name: 'value', label: 'Value', required: true }],
      }),
    })
    runtime.registerPending(runId, interactionId)
    const view = app.interactionController().views()[0]
    assert.ok(view)
    const result = await app.respondInteraction({
      runId,
      interactionId,
      ...(view.profileDigest === undefined ? {} : { profileDigest: view.profileDigest }),
      ...(view.conversationId === undefined ? {} : { conversationId: view.conversationId }),
      ...(view.branchId === undefined ? {} : { branchId: view.branchId }),
      ...(view.model === undefined ? {} : { model: view.model }),
      ...(view.runner === undefined ? {} : { runner: view.runner }),
      ...(view.requestRevision === undefined ? {} : { requestRevision: view.requestRevision }),
      operationId: `operation-${status}`,
      response: {
        id: interactionId,
        outcome: 'accepted',
        data: { value: 'answer' },
      },
    })
    assert.equal(result.status, status)
    assert.equal(app.state().interactions[0]?.status, status)
    app.shutdown()
  }
})

test('W28 concurrent interactions render every request and every option', async () => {
  const terminal = new VirtualTerminal(120, 40)
  const tui = new TUI(terminal)
  const app = createBraidApplication({
    fixture: 'deterministic',
    interactionRuntime: new DeterministicInteractionRuntime(),
  })
  app.initialize('/workspace')
  for (const [runId, id, label] of [
    ['run-concurrent-a', 'interaction-a', 'First choice'],
    ['run-concurrent-b', 'interaction-b', 'Second choice'],
  ] as const) {
    app.receiveInteraction({
      runId,
      request: question(id, {
        fields: [
          {
            type: 'select',
            name: 'choice',
            label,
            options: [
              { value: 'one', label: `${label} one` },
              { value: 'two', label: `${label} two` },
            ],
          },
        ],
      }),
    })
  }
  const view = new BraidTerminalApp({
    app,
    tui,
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => 'concurrent-operation',
  })
  const done = view.start()
  await terminal.waitForRender()
  const appView = buildAppView(app.state(), app.interactionCapabilities(), app.now())
  assert.equal(appView.interactions.length, 2)
  assert.equal(
    appView.interactions.every((item) => item.answerSpec.fields[0]?.type === 'select'),
    true,
  )
  const screen = terminal.getScrollBuffer().join('\n')
  assert.match(screen, /First choice/u)
  assert.match(screen, /Second choice/u)
  assert.match(screen, /First choice one/u)
  assert.match(screen, /Second choice two/u)
  view.stop()
  await done
  app.shutdown()
})
