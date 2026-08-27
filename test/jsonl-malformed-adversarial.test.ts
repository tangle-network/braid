import assert from 'node:assert/strict'
import test from 'node:test'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
import { HEADLESS_COMMAND_NAMES } from '../src/views/shared/headless-commands.js'
import type { BraidResponse } from '../src/views/headless/protocol.js'
import {
  linesOf,
  MAX_RPC_COMMAND_TEXT_BYTES,
  MAX_RPC_FIELD_BYTES,
  MAX_RPC_LINE_BYTES,
  MAX_RPC_OPERATION_ID_BYTES,
  MAX_RPC_REQUEST_ID_BYTES,
  parseRequest,
  RpcParseError,
} from '../src/views/headless/rpc-parser.js'
import { runRpc } from '../src/views/headless/rpc.js'

function line(body: Record<string, unknown>): string {
  return JSON.stringify(body)
}

function expectError(raw: string): RpcParseError {
  try {
    parseRequest(raw)
  } catch (error) {
    assert.ok(error instanceof RpcParseError, `expected RpcParseError for ${raw}`)
    return error as RpcParseError
  }
  assert.fail(`expected parse failure for ${raw}`)
}

test('parseRequest rejects every shape of unsupported or missing protocol version', () => {
  for (const version of [2, '1', null]) {
    const error = expectError(
      line({ version, requestId: 'r', command: 'initialize', params: { workspace: '/w' } }),
    )
    assert.equal(error.code, 'UNSUPPORTED_VERSION')
  }
  const missing = expectError(
    line({ requestId: 'r', command: 'initialize', params: { workspace: '/w' } }),
  )
  assert.equal(missing.code, 'UNSUPPORTED_VERSION')
})

test('parseRequest rejects a missing, empty, or non-string requestId', () => {
  for (const requestId of ['', 5, null]) {
    const error = expectError(
      line({ version: 1, requestId, command: 'initialize', params: { workspace: '/w' } }),
    )
    assert.equal(error.code, 'INVALID_PARAMS')
    assert.match(error.message, /requestId/u)
  }
})

test('parseRequest rejects a non-object request body with INVALID_REQUEST', () => {
  for (const raw of ['[1, 2, 3]', '5', '"a string"', 'true']) {
    const error = expectError(raw)
    assert.equal(error.code, 'INVALID_REQUEST')
  }
})

test('an unknown command reports choices covering the full headless registry', () => {
  const error = expectError(line({ version: 1, requestId: 'r', command: 'frobnicate', params: {} }))
  assert.equal(error.code, 'UNKNOWN_COMMAND')
  assert.deepEqual([...(error.choices ?? [])], [...HEADLESS_COMMAND_NAMES])
})

test('unknown top-level fields and array params are rejected as INVALID_PARAMS', () => {
  const unknownField = expectError(
    line({
      version: 1,
      requestId: 'r',
      foo: 1,
      command: 'initialize',
      params: { workspace: '/w' },
    }),
  )
  assert.equal(unknownField.code, 'INVALID_PARAMS')
  assert.match(unknownField.message, /unknown field foo/u)

  const arrayParams = expectError(
    line({ version: 1, requestId: 'r', command: 'initialize', params: [1, 2] }),
  )
  assert.equal(arrayParams.code, 'INVALID_PARAMS')
  assert.match(arrayParams.message, /params must be an object/u)
})

test('a non-string operationId is rejected before any mutation is considered', () => {
  const error = expectError(
    line({ version: 1, requestId: 'r', operationId: 42, command: 'send', params: { text: 'x' } }),
  )
  assert.equal(error.code, 'INVALID_OPERATION_ID')
})

test('a blank line is malformed JSON, not an empty request', () => {
  const error = expectError('')
  assert.equal(error.code, 'MALFORMED_JSON')
})

test('linesOf decodes binary chunks, strips carriage returns, and flushes a final line', async () => {
  async function* chunks(): AsyncGenerator<string | Uint8Array> {
    yield new TextEncoder().encode('line-a\r\n')
    yield 'line-b\n'
    yield new TextEncoder().encode('line-c-no-newline')
  }
  const collected: string[] = []
  for await (const line of linesOf(chunks())) collected.push(line)
  assert.deepEqual(collected, ['line-a', 'line-b', 'line-c-no-newline'])
})

test('linesOf preserves UTF-8 split across binary and string chunks', async () => {
  async function* chunks(): AsyncGenerator<string | Uint8Array> {
    yield new Uint8Array([0xf0, 0x9f])
    yield new Uint8Array([0x98, 0x80, 0x0a])
    yield '\ud83d'
    yield '\ude00\n'
  }
  const collected: string[] = []
  for await (const line of linesOf(chunks())) collected.push(line)
  assert.deepEqual(collected, ['😀', '😀'])
})

test('linesOf accepts exactly the byte limit and rejects the next byte incrementally', async () => {
  async function* exactChunks(): AsyncGenerator<Uint8Array> {
    let remaining = MAX_RPC_LINE_BYTES
    while (remaining > 0) {
      const size = Math.min(32 * 1024, remaining)
      yield new Uint8Array(size).fill(0x78)
      remaining -= size
    }
    yield new Uint8Array([0x0a])
  }
  const exact: string[] = []
  for await (const line of linesOf(exactChunks())) exact.push(line)
  assert.equal(exact.length, 1)
  assert.equal(exact[0]?.length, MAX_RPC_LINE_BYTES)

  async function* overlongChunks(): AsyncGenerator<Uint8Array> {
    let remaining = MAX_RPC_LINE_BYTES + 1
    while (remaining > 0) {
      const size = Math.min(32 * 1024, remaining)
      yield new Uint8Array(size).fill(0x78)
      remaining -= size
    }
  }
  await assert.rejects(
    (async () => {
      for await (const _line of linesOf(overlongChunks())) {
        // The line must fail before a newline can make it observable.
      }
    })(),
    (error: unknown) => error instanceof RpcParseError && error.code === 'LINE_TOO_LARGE',
  )
})

test('request IDs, operation IDs, fields, and command text use exact UTF-8 byte bounds', () => {
  const requestId = '😀'.repeat(Math.ceil(MAX_RPC_REQUEST_ID_BYTES / 4) + 1)
  const requestError = expectError(
    line({ version: 1, requestId, command: 'initialize', params: { workspace: '/w' } }),
  )
  assert.equal(requestError.code, 'INVALID_PARAMS')
  assert.match(requestError.message, /requestId/u)

  const operationId = 'x'.repeat(MAX_RPC_OPERATION_ID_BYTES + 1)
  const operationError = expectError(
    line({
      version: 1,
      requestId: 'r',
      operationId,
      command: 'send',
      params: { text: 'x' },
    }),
  )
  assert.equal(operationError.code, 'INVALID_OPERATION_ID')

  const fieldError = expectError(
    line({
      version: 1,
      requestId: 'r',
      command: 'initialize',
      params: { workspace: 'x'.repeat(MAX_RPC_FIELD_BYTES + 1) },
    }),
  )
  assert.equal(fieldError.code, 'INVALID_PARAMS')

  const commandTextError = expectError(
    line({
      version: 1,
      requestId: 'r',
      operationId: 'op-send-bounds',
      command: 'send',
      params: { text: 'x'.repeat(MAX_RPC_COMMAND_TEXT_BYTES + 1) },
    }),
  )
  assert.equal(commandTextError.code, 'INVALID_PARAMS')

  const nestedFieldError = expectError(
    line({
      version: 1,
      requestId: 'r',
      operationId: 'op-response-bounds',
      command: 'respond_interaction',
      params: {
        runId: 'run-1',
        interactionId: 'interaction-1',
        response: { answer: 'x'.repeat(MAX_RPC_FIELD_BYTES + 1) },
      },
    }),
  )
  assert.equal(nestedFieldError.code, 'INVALID_PARAMS')
})

test('runRpc rejects overlong IDs and command text before dispatching a run', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  const output: string[] = []
  async function* input(): AsyncGenerator<string> {
    yield `${JSON.stringify({
      version: 1,
      requestId: 'req-init-bounds',
      command: 'initialize',
      params: { workspace: '/workspace' },
    })}\n`
    yield `${JSON.stringify({
      version: 1,
      requestId: 'r'.repeat(MAX_RPC_REQUEST_ID_BYTES + 1),
      operationId: 'op-overlong-request-id',
      command: 'send',
      params: { text: 'request ID too long' },
    })}\n`
    yield `${JSON.stringify({
      version: 1,
      requestId: 'req-overlong-operation-id',
      operationId: 'o'.repeat(MAX_RPC_OPERATION_ID_BYTES + 1),
      command: 'send',
      params: { text: 'operation ID too long' },
    })}\n`
    yield `${JSON.stringify({
      version: 1,
      requestId: 'req-overlong-text',
      operationId: 'op-overlong-text',
      command: 'send',
      params: { text: 'x'.repeat(MAX_RPC_COMMAND_TEXT_BYTES + 1) },
    })}\n`
    yield `${JSON.stringify({
      version: 1,
      requestId: 'req-shutdown-bounds',
      operationId: 'op-shutdown-bounds',
      command: 'shutdown',
    })}\n`
  }

  const code = await runRpc(createApplicationUiController(app), input(), {
    write: (chunk) => {
      output.push(chunk)
      return true
    },
  })
  const responses = output.map((chunk) => JSON.parse(chunk) as BraidResponse)
  const error = responses.find(
    (response) => response.type === 'error' && response.requestId === 'req-overlong-text',
  )

  assert.equal(code, 0)
  const overlongOperationId = responses.find(
    (response) => response.type === 'error' && response.requestId === 'req-overlong-operation-id',
  )
  assert.equal(overlongOperationId?.type, 'error')
  if (overlongOperationId?.type !== 'error') assert.fail('missing overlong-operation-id error')
  assert.equal(overlongOperationId.code, 'INVALID_OPERATION_ID')
  assert.equal(error?.type, 'error')
  if (error?.type !== 'error') assert.fail('missing overlong-text error')
  assert.equal(error.code, 'INVALID_PARAMS')
  assert.equal(
    app.events().some((entry) => entry.event.kind === 'run.requested'),
    false,
  )
})
