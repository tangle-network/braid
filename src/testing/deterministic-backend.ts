import { setTimeout as delay } from 'node:timers/promises'
import type { AgentProfile } from '@tangle-network/agent-interface'
import type { AgentTurnBackend } from '@tangle-network/agent-runtime/kernel'
import type { ExecuteTurnInput } from '../ports/execution.js'
import { isProductDemoProfile } from './product-demo-fixture.js'

function responseFor(profile: Readonly<AgentProfile>, text: string): string {
  if (isProductDemoProfile(profile)) {
    return 'Route confirmed. Your AgentProfile stays intact while agent-runtime sends this turn through Pi over Local CLI Bridge. Braid keeps the conversation, forks, approvals, and trace analysis in one place.'
  }
  const runner = profile.harness ?? 'runtime default'
  return `Fixture response through ${runner}: ${text}`
}

/**
 * Test-only buffered model route composed through Runtime's attested Router executor.
 * The product profile remains the UI fixture; this isolated execution profile prevents
 * development tests from claiming that a real coding runner was materialized.
 */
export async function deterministicBackend(
  input: ExecuteTurnInput,
  options: { readonly chunkDelayMs?: number } = {},
): Promise<AgentTurnBackend> {
  const model = input.profile.model?.default ?? 'fixture/deterministic'
  const profile: AgentProfile = {
    name: 'Braid deterministic execution fixture',
    harness: 'cli-base',
    model: {
      default: model,
      provider: input.profile.model?.provider ?? 'fixture',
      ...(input.profile.model?.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: input.profile.model.reasoningEffort }),
    },
  }
  const response = responseFor(input.profile, input.text)
  const { createExecutor } = await import('@tangle-network/agent-runtime/kernel')
  return Object.freeze({
    kind: 'executor' as const,
    factory: createExecutor({
      backend: 'router',
      routerBaseUrl: 'https://fixture.invalid/v1',
      routerKey: 'fixture',
      complete: async (_body, request) => {
        if (process.env.BRAID_FIXTURE_FAILURE === '1') {
          throw new Error('Deterministic fixture failure')
        }
        if (options.chunkDelayMs) {
          const chunks = Math.max(1, Math.ceil([...response].length / 12))
          await delay(options.chunkDelayMs * chunks, undefined, { signal: request?.signal })
        }
        return {
          model,
          choices: [{ message: { content: response }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: isProductDemoProfile(input.profile) ? 1_284 : 8,
            completion_tokens: isProductDemoProfile(input.profile) ? 96 : 12,
          },
        }
      },
    }),
    profile,
    agentRunName: 'braid-deterministic-fixture',
  })
}
