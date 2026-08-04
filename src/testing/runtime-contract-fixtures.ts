import type { BraidRuntimeEvent, RuntimeEventEnvelope } from '../domain/runtime-events.js'

const RECEIVED_AT = '2026-08-01T00:00:00.000Z'

function event(value: unknown): BraidRuntimeEvent {
  return value as BraidRuntimeEvent
}

/**
 * Canonical shared-schema events used by the controller contract tests.
 * These are normalized events, not runner output, so the fixture does not
 * encode a provider parser or a second execution path.
 */
export function runtimeContractEvents(): readonly BraidRuntimeEvent[] {
  return [
    event({
      type: 'message.part.updated',
      part: {
        id: 'part-text',
        sessionID: 'session-contract',
        messageID: 'message-assistant',
        type: 'text',
        text: 'hello',
      },
      delta: 'hello',
    }),
    event({ type: 'reasoning_delta', text: 'checking', timestamp: RECEIVED_AT }),
    event({
      type: 'tool_call',
      toolName: 'read_file',
      toolCallId: 'call-1',
      args: { path: 'README.md' },
      timestamp: RECEIVED_AT,
    }),
    event({
      type: 'tool_result',
      toolName: 'read_file',
      toolCallId: 'call-1',
      result: { bytes: 12 },
      timestamp: RECEIVED_AT,
    }),
    event({
      type: 'artifact',
      artifactId: 'artifact-1',
      name: 'report.txt',
      mimeType: 'text/plain',
      uri: 'artifact://report-1',
      timestamp: RECEIVED_AT,
    }),
    event({
      type: 'proposal_created',
      proposalId: 'proposal-1',
      title: 'Apply report',
      status: 'pending',
      timestamp: RECEIVED_AT,
    }),
    event({ type: 'warning', code: 'slow-tool', message: 'The tool took longer than expected' }),
    event({
      type: 'llm_call',
      model: 'fixture/model',
      tokensIn: 3,
      tokensOut: 4,
      costUsd: 0.01,
      timestamp: RECEIVED_AT,
    }),
    event({
      type: 'interaction',
      request: {
        id: 'interaction-1',
        kind: 'question',
        title: 'Continue?',
        answerSpec: {
          fields: [{ type: 'boolean', name: 'continue', label: 'Continue', required: true }],
        },
      },
    }),
    event({
      type: 'final',
      status: 'completed',
      reason: 'complete',
      text: 'hello',
      metadata: { tokenUsage: { input: 3, output: 4 }, costUsd: 0.01, model: 'fixture/model' },
      task: { id: 'task-contract', intent: 'contract fixture' },
      timestamp: RECEIVED_AT,
    }),
  ]
}

export function runtimeContractEnvelopes(runId: string): readonly RuntimeEventEnvelope[] {
  return runtimeContractEvents().map((runtimeEvent, index) => ({
    runId,
    eventId: `${runId}:contract:${index + 1}`,
    sequence: index + 1,
    cursor: `cursor-${index + 1}`,
    occurredAt: RECEIVED_AT,
    receivedAt: RECEIVED_AT,
    event: runtimeEvent,
  }))
}
