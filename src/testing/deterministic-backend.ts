import { setTimeout as delay } from 'node:timers/promises'
import type { AgentProfile } from '@tangle-network/agent-interface'
import type { AgentTurnBackend } from '@tangle-network/agent-runtime/kernel'
import type { ExecuteTurnInput } from '../ports/execution.js'
import { isProductDemoProfile } from './product-demo-fixture.js'

function responseFor(profile: Readonly<AgentProfile>, text: string): string {
  if (isProductDemoProfile(profile)) {
    return 'Pi will run the task through Local CLI Bridge with gpt-5.6-luna. The Release engineer AgentProfile supplies its instructions and permissions. Braid keeps the transcript, approvals, branches, and trace analysis.'
  }
  const runner = profile.harness ?? 'runtime default'
  return `Fixture response through ${runner}: ${text}`
}

export interface DeterministicBackendOptions {
  /** Simulated per-chunk latency for demos and visual captures. */
  readonly chunkDelayMs?: number
  /**
   * Holds each turn open until this settles or the turn is cancelled. Tests that need a run to
   * stay active use this instead of a delay, so the run cannot finish early on a slow machine.
   */
  readonly release?: PromiseLike<void>
}

/** Resolves when `release` settles; rejects like `timers/promises` if `signal` aborts first. */
function untilReleased(release: PromiseLike<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return Promise.resolve(release)
  return new Promise<void>((resolve, reject) => {
    const abort = () =>
      reject(
        new DOMException('The operation was aborted', { name: 'AbortError', cause: signal.reason }),
      )
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(release).then(
      () => {
        signal.removeEventListener('abort', abort)
        resolve()
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

/**
 * Test-only buffered model route composed through Runtime's attested Router executor.
 * The product profile remains the UI fixture; this isolated execution profile prevents
 * development tests from claiming that a real coding runner was materialized.
 */
export async function deterministicBackend(
  input: ExecuteTurnInput,
  options: DeterministicBackendOptions = {},
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
        if (options.release !== undefined) await untilReleased(options.release, request?.signal)
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
