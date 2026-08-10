import { setTimeout as delay } from 'node:timers/promises'
import type { AgentProfile } from '@tangle-network/agent-interface'
import type {
  AgentExecutionBackend,
  RuntimeSession,
  RuntimeStreamEvent,
} from '@tangle-network/agent-runtime'
import type { AgentTurnBackend } from '@tangle-network/agent-runtime/kernel'
import type { ExecuteTurnInput } from '../ports/execution.js'
import { isProductDemoProfile } from './product-demo-fixture.js'

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
  if (isProductDemoProfile(profile)) {
    return 'Route confirmed. Your AgentProfile stays intact while agent-runtime sends this turn through Pi over Local CLI Bridge. Braid keeps the conversation, forks, approvals, and trace analysis in one place.'
  }
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
      if (isProductDemoProfile(input.profile)) {
        const wait = async (milliseconds: number) => {
          if (options.chunkDelayMs) {
            await delay(milliseconds, undefined, { signal: context.signal })
          }
        }
        await wait(options.chunkDelayMs ?? 0)
        yield {
          type: 'reasoning_delta',
          text: 'Following the selected profile, connection, and execution receipt.',
        }
        await wait(320)
        yield {
          type: 'tool_call',
          toolName: 'profile.inspect',
          toolCallId: 'profile-inspect-1',
          args: { profile: 'Release engineer' },
        }
        await wait(460)
        yield {
          type: 'tool_result',
          toolName: 'profile.inspect',
          toolCallId: 'profile-inspect-1',
          result: {
            runner: 'pi',
            model: 'openai-codex/gpt-5.6-luna',
            reasoningEffort: 'high',
          },
        }
        await wait(280)
        yield {
          type: 'tool_call',
          toolName: 'runtime.route',
          toolCallId: 'runtime-route-1',
          args: { workspace: 'agent-sdk' },
        }
        await wait(520)
        yield {
          type: 'tool_result',
          toolName: 'runtime.route',
          toolCallId: 'runtime-route-1',
          result: { connection: 'Local CLI Bridge', provider: 'openai-codex' },
        }
        await wait(240)
        yield {
          type: 'llm_call',
          model: 'openai-codex/gpt-5.6-luna',
          tokensIn: 1_284,
          tokensOut: 96,
          costUsd: 0.0037,
          latencyMs: 842,
          finishReason: 'stop',
        }
      }
      for (const chunk of chunks) {
        if (options.chunkDelayMs) {
          await delay(options.chunkDelayMs, undefined, { signal: context.signal })
        }
        yield { type: 'text_delta', text: chunk }
      }
    },
  }
  return { kind: 'chat', backend }
}
