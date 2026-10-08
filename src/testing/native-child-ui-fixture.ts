import type { ChildTaskEvent } from '@tangle-network/agent-interface'
import { DEFAULT_RUN_CAPABILITIES, type ExecutionPort } from '../ports/execution.js'

const STARTED = Date.parse('2026-10-08T12:00:00.000Z')

/** Offline events enter the same execution and projection path as provider events. */
export function createNativeChildUiFixture(): ExecutionPort {
  const reviewer: ChildTaskEvent = {
    type: 'child-task',
    childId: 'native-review',
    sourceEventId: 'review-started',
    title: 'Review patch',
    runner: 'codex',
    model: 'fixture/native-model',
    status: 'running',
    time: { started: STARTED, updated: STARTED },
  }
  const checker: ChildTaskEvent = {
    ...reviewer,
    childId: 'native-check',
    parentChildId: reviewer.childId,
    sourceEventId: 'check-started',
    title: 'Check tests',
    time: { started: STARTED + 100, updated: STARTED + 100 },
  }
  return {
    capabilities: () => DEFAULT_RUN_CAPABILITIES,
    async *streamTurn(input) {
      yield reviewer
      yield checker
      yield {
        ...checker,
        sourceEventId: 'check-completed',
        status: 'completed',
        time: { started: STARTED + 100, updated: STARTED + 900, ended: STARTED + 900 },
        terminalReason: 'Fixture assertions passed',
      }
      yield {
        ...reviewer,
        sourceEventId: 'review-completed',
        status: 'completed',
        time: { started: STARTED, updated: STARTED + 1_200, ended: STARTED + 1_200 },
        terminalReason: 'Fixture review complete',
        usage: { inputTokens: 24, outputTokens: 8 },
      }
      yield reviewer
      yield {
        type: 'final',
        status: 'completed',
        reason: 'completed',
        text: 'Offline fixture: two native children reported. Open /activity to inspect them.',
        metadata: { tokenUsage: { input: 10, output: 6 } },
        task: { id: input.runId, intent: input.text },
        timestamp: '2026-10-08T12:00:02.000Z',
      }
    },
  }
}
