import { setTimeout as delay } from 'node:timers/promises'
import type { AgentProfile } from '@tangle-network/agent-interface'
import type {
  AgentExecutionBackend,
  RuntimeSession,
  RuntimeStreamEvent,
} from '@tangle-network/agent-runtime'
import type { AgentTurnBackend } from '@tangle-network/agent-runtime/kernel'
import type { ExecuteTurnInput } from '../ports/execution.js'

function sessionFor(input: ExecuteTurnInput, kind: string): RuntimeSession {
  return {
    id: `session-${input.runId}`,
    backend: kind,
    status: 'active',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  }
}

function responseFor(profile: Readonly<AgentProfile>, text: string): string {
  const runner = profile.harness ?? 'runtime default'
  return `Fixture response through ${runner}: ${text}`
}

function chunksOf(text: string): string[] {
  const characters = [...text]
  const chunks: string[] = []
  for (let index = 0; index < characters.length; index += 12) {
    chunks.push(characters.slice(index, index + 12).join(''))
  }
  return chunks
}

export function deterministicBackend(
  input: ExecuteTurnInput,
  options: { readonly chunkDelayMs?: number } = {},
): AgentTurnBackend {
  const kind = 'braid-deterministic-fixture'
  const response = responseFor(input.profile, input.text)
  const chunks = chunksOf(response)
  const backend: AgentExecutionBackend = {
    kind,
    start: () => sessionFor(input, kind),
    async *stream(_backendInput, context): AsyncIterable<RuntimeStreamEvent> {
      if (process.env.BRAID_FIXTURE_FAILURE === '1') {
        throw new Error('Deterministic fixture failure')
      }
      for (const chunk of chunks) {
        if (options.chunkDelayMs) {
          await delay(options.chunkDelayMs, undefined, { signal: context.signal })
        }
        yield { type: 'text_delta', text: chunk }
      }
      yield {
        type: 'llm_call',
        model: 'fixture/deterministic',
        tokensIn: Math.max(1, input.text.split(/\s+/u).length),
        tokensOut: chunks.length,
        costUsd: 0,
        latencyMs: options.chunkDelayMs ? options.chunkDelayMs * chunks.length : 0,
        finishReason: 'stop',
      }
    },
  }
  return { kind: 'chat', backend }
}

export function unconfiguredBackend(input: ExecuteTurnInput): AgentTurnBackend {
  const kind = 'braid-unconfigured'
  const backend: AgentExecutionBackend = {
    kind,
    start: () => sessionFor(input, kind),
    stream: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw new Error('No Braid connection is configured')
        },
      }),
    }),
  }
  return { kind: 'chat', backend }
}
