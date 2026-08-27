import type { AgentExactRunControlRef } from '@tangle-network/agent-interface'
import type { ExecuteTurnInput, RetainedExecutionRecoveryContext } from '../../ports/execution.js'
import type { PreparedTangleRetainedConnection } from './production-tangle-sandbox-backend.js'
import { RetainedExecutionPort } from './retained-execution.js'
import { createTangleRetainedPlan } from './tangle-retained-run.js'

export interface TangleRetainedExecutionOptions {
  readonly resolve: (input: ExecuteTurnInput) => Promise<PreparedTangleRetainedConnection>
  readonly recover: (
    input: {
      readonly runId: string
      readonly providerSessionId?: string
      readonly controlRef?: AgentExactRunControlRef
      readonly signal?: AbortSignal
    } & RetainedExecutionRecoveryContext,
  ) => Promise<PreparedTangleRetainedConnection>
}

/** The cloud owns the retained sandbox; Braid owns readers and exact recovery state. */
export class TangleRetainedExecutionPort extends RetainedExecutionPort {
  constructor(options: TangleRetainedExecutionOptions) {
    super({
      resolve: async (input) => createTangleRetainedPlan(await options.resolve(input), input.runId),
      continue: async (input, controlRef) =>
        createTangleRetainedPlan(await options.resolve(input), input.runId, controlRef),
      recover: async ({ runId, providerSessionId, controlRef, signal, ...recovery }) =>
        createTangleRetainedPlan(
          await options.recover({
            runId,
            ...(providerSessionId === undefined ? {} : { providerSessionId }),
            ...(controlRef === undefined ? {} : { controlRef }),
            ...(signal === undefined ? {} : { signal }),
            ...recovery,
          }),
          runId,
          controlRef,
          recovery,
        ),
    })
  }
}
