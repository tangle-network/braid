import assert from 'node:assert/strict'
import test from 'node:test'
import type { BraidRequest, QueueRequest } from '../src/views/headless/protocol.js'
import { parseRequest } from '../src/views/headless/rpc-parser.js'

const validQueue: QueueRequest = {
  version: 1,
  requestId: 'queue-valid',
  operationId: 'op-queue-valid',
  command: 'queue',
  params: {
    conversationId: 'conversation-1',
    branchId: 'branch-1',
    text: 'continue',
  },
}

// The public union must not fall back to an unchecked generic request for queue.
// @ts-expect-error queue text is required to be a string
const invalidQueueText: BraidRequest = {
  version: 1,
  requestId: 'queue-invalid-text',
  operationId: 'op-queue-invalid-text',
  command: 'queue',
  params: {
    text: 42,
  },
}

// Mutating generic commands require caller-created operation identity.
// @ts-expect-error rename_conversation is mutating and requires operationId
const invalidMutationWithoutOperation: BraidRequest = {
  version: 1,
  requestId: 'rename-missing-operation',
  command: 'rename_conversation',
  params: { conversationId: 'conversation-1', title: 'renamed' },
}

const validReadOnly: BraidRequest = {
  version: 1,
  requestId: 'profiles-read',
  command: 'list_profiles',
  params: {},
}

void invalidQueueText
void invalidMutationWithoutOperation
void validReadOnly

test('queue public type matches the parser conversation/branch target contract', () => {
  assert.deepEqual(parseRequest(JSON.stringify(validQueue)), validQueue)
})
