import assert from 'node:assert/strict'
import test from 'node:test'

import { STARTER_PROFILE } from '../src/app/composition.js'
import { conversationIdForEvent } from '../src/app/storage-journal-support.js'
import { createConversationId, createRunId } from '../src/domain/ids.js'
import { type BraidState, initialState } from '../src/domain/state.js'

test('storage routes late run events to the run conversation', () => {
  const currentConversationId = createConversationId('conversation-selected')
  const runConversationId = createConversationId('conversation-background')
  const runId = createRunId('run-background')
  const state = {
    ...initialState(STARTER_PROFILE, { conversationId: currentConversationId }),
    runs: [{ id: runId, conversationId: runConversationId }] as unknown as BraidState['runs'],
  }
  const event = {
    kind: 'run.status.changed' as const,
    runId,
    status: 'streaming' as const,
  }

  assert.equal(conversationIdForEvent(state, event), runConversationId)
})
