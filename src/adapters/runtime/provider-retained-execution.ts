import type {
  ExecuteTurnInput,
  ExecutionPort,
  RetainedExecutionRecoveryContext,
} from '../../ports/execution.js'
import type { AgentExactRunControlRef } from '@tangle-network/agent-interface'
import { RetainedExecutionPort } from './retained-execution.js'
import {
  createProviderRetainedPlan,
  type PreparedRetainedProviderConnection,
} from './provider-retained-run.js'

export class ProviderRetainedExecutionPort extends RetainedExecutionPort {
  readonly workspaceBranchingProvider?: ExecutionPort['workspaceBranchingProvider']
  readonly confidentialAttestationVerifier?: ExecutionPort['confidentialAttestationVerifier']
  constructor(options: {
    readonly workspaceBranchingProvider?: ExecutionPort['workspaceBranchingProvider']
    readonly confidentialAttestationVerifier?: ExecutionPort['confidentialAttestationVerifier']
    readonly resolve: (input: ExecuteTurnInput) => Promise<PreparedRetainedProviderConnection>
    readonly recover: (
      input: {
        readonly runId: string
        readonly providerSessionId?: string
        readonly controlRef?: AgentExactRunControlRef
        readonly signal?: AbortSignal
      } & RetainedExecutionRecoveryContext,
    ) => Promise<PreparedRetainedProviderConnection>
  }) {
    super({
      resolve: async (input) =>
        createProviderRetainedPlan(await options.resolve(input), input.runId),
      continue: async (input, controlRef) =>
        createProviderRetainedPlan(await options.resolve(input), input.runId, controlRef),
      recover: async (input) =>
        createProviderRetainedPlan(
          await options.recover(input),
          input.runId,
          input.controlRef,
          input,
        ),
    })
    if (options.workspaceBranchingProvider !== undefined)
      this.workspaceBranchingProvider = options.workspaceBranchingProvider
    if (options.confidentialAttestationVerifier !== undefined)
      this.confidentialAttestationVerifier = options.confidentialAttestationVerifier
  }
}
