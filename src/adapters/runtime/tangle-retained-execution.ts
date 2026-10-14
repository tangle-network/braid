import type {
  AgentExactRunControlRef,
  AgentWorkspaceBranchingProvider,
  ConfidentialAttestationVerifier,
} from '@tangle-network/agent-interface'
import type {
  ContextTransferExecutionPort,
  ExecuteTurnInput,
  RetainedExecutionRecoveryContext,
} from '../../ports/execution.js'
import type { PreparedTangleRetainedConnection } from './production-tangle-sandbox-backend.js'
import { RetainedExecutionPort } from './retained-execution.js'
import { createProviderRetainedPlan } from './provider-retained-run.js'

export interface TangleRetainedExecutionOptions {
  readonly context?: ContextTransferExecutionPort
  readonly resolve: (input: ExecuteTurnInput) => Promise<PreparedTangleRetainedConnection>
  readonly recover: (
    input: {
      readonly runId: string
      readonly providerSessionId?: string
      readonly controlRef?: AgentExactRunControlRef
      readonly signal?: AbortSignal
    } & RetainedExecutionRecoveryContext,
  ) => Promise<PreparedTangleRetainedConnection>
  readonly workspaceBranchingProvider?: AgentWorkspaceBranchingProvider
  readonly confidentialAttestationVerifier?: ConfidentialAttestationVerifier
}

/** The cloud owns the retained sandbox; Braid owns readers and exact recovery state. */
export class TangleRetainedExecutionPort extends RetainedExecutionPort {
  readonly context?: ContextTransferExecutionPort
  readonly workspaceBranchingProvider?: AgentWorkspaceBranchingProvider
  readonly confidentialAttestationVerifier?: ConfidentialAttestationVerifier

  constructor(options: TangleRetainedExecutionOptions) {
    super({
      resolve: async (input) =>
        createProviderRetainedPlan(await options.resolve(input), input.runId),
      continue: async (input, controlRef) =>
        createProviderRetainedPlan(await options.resolve(input), input.runId, controlRef),
      recover: async ({ runId, providerSessionId, controlRef, signal, ...recovery }) =>
        createProviderRetainedPlan(
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
    if (options.context !== undefined) this.context = options.context
    if (options.workspaceBranchingProvider !== undefined)
      this.workspaceBranchingProvider = options.workspaceBranchingProvider
    if (options.confidentialAttestationVerifier !== undefined)
      this.confidentialAttestationVerifier = options.confidentialAttestationVerifier
  }
}
