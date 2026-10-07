import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createConversationId,
  createOperationId,
  createRunId,
  isConversationId,
  isRunId,
  parseConversationId,
  parseRunId,
} from '../src/domain/ids.js'

test('identifier validators reject values from another domain', () => {
  const run = createRunId('run-1')
  const conversation = createConversationId('conv-1')

  assert.equal(isRunId(run), true)
  assert.equal(isConversationId(conversation), true)
  assert.equal(isRunId(conversation), false)
  assert.equal(isConversationId(run), false)
  assert.throws(() => parseRunId('branch-1'), /Invalid run identifier/u)
  assert.throws(() => parseConversationId('run-1'), /Invalid conversation identifier/u)
})

test('identifier validators reject values that secret redaction would change', () => {
  assert.throws(
    () => createOperationId(`op-plain-sk-${'a'.repeat(24)}`),
    /Invalid operation identifier/u,
  )
})
