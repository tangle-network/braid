import type { AgentExactRunControlRef } from '@tangle-network/agent-interface'
import type { ExecuteTurnInput, RetainedExecutionRecoveryContext } from '../../ports/execution.js'
import { createCliBridgeRetainedPlan } from './cli-bridge-retained-run.js'
import type { PreparedCliBridgeConnection } from './production-cli-bridge-backend.js'
import { RetainedExecutionPort } from './retained-execution.js'

export interface CliBridgeRetainedExecutionOptions {
  readonly resolve: (input: ExecuteTurnInput) => Promise<PreparedCliBridgeConnection>
  readonly recover: (
    input: {
      readonly runId: string
      readonly providerSessionId?: string
      readonly controlRef?: AgentExactRunControlRef
      readonly signal?: AbortSignal
    } & RetainedExecutionRecoveryContext,
  ) => Promise<PreparedCliBridgeConnection>
}

/** Braid's durable CLI-Bridge path. CLI-Bridge owns the job; the shared port owns readers. */
export class CliBridgeRetainedExecutionPort extends RetainedExecutionPort {
  constructor(options: CliBridgeRetainedExecutionOptions) {
    super({
      resolve: async (input) =>
        createCliBridgeRetainedPlan(await options.resolve(input), input.runId),
      recover: async ({ runId, providerSessionId, controlRef, signal, ...recovery }) =>
        createCliBridgeRetainedPlan(
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
