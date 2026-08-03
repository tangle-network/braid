import assert from 'node:assert/strict'
import test from 'node:test'
import { HEADLESS_COMMAND_NAMES } from '../src/views/shared/headless-commands.js'
import { linesOf, parseRequest, RpcParseError } from '../src/views/headless/rpc-parser.js'

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
