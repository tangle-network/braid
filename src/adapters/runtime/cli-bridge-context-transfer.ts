import {
  ContextTransferResultSchema,
  type AgentEnvironmentCapabilities,
  type ContextTransferRequest,
  type ContextTransferResult,
} from '@tangle-network/agent-interface'
import type { CliBridgeProvider } from '@tangle-network/agent-provider-cli-bridge'
import type { ContextTransferExecutionPort } from '../../ports/execution.js'

export interface CliBridgeContextTransferResolution {
  readonly provider: CliBridgeProvider
  readonly capabilities: AgentEnvironmentCapabilities
}

export interface CliBridgeContextTransferOptions {
  readonly resolve: (request: ContextTransferRequest) => Promise<CliBridgeContextTransferResolution>
}

/** Route portable context through the destination provider that owns admission. */
export function createCliBridgeContextTransferPort(
  options: CliBridgeContextTransferOptions,
): ContextTransferExecutionPort {
  return Object.freeze({
    lookup: async (request: ContextTransferRequest) => {
      const resolved = await options.resolve(request)
      if (!supportsContextTransfer(resolved, request)) return undefined
      return resolved.provider.contextTransfer?.lookup(request)
    },
    transfer: async (request: ContextTransferRequest) => {
      const resolved = await options.resolve(request)
      if (!supportsContextTransfer(resolved, request)) {
        return unavailableContextTransfer(request)
      }
      return (
        (await resolved.provider.contextTransfer?.transfer(request)) ??
        unavailableContextTransfer(request)
      )
    },
  })
}

function supportsContextTransfer(
  resolved: CliBridgeContextTransferResolution,
  request: ContextTransferRequest,
): boolean {
  const capability = resolved.capabilities.contextTransfer
  return (
    request.plan.destination.provider === resolved.provider.name &&
    capability?.freshSession === true &&
    capability.requestIdempotency === true &&
    capability.lookup === true &&
    resolved.provider.contextTransfer?.transfer !== undefined &&
    resolved.provider.contextTransfer.lookup !== undefined
  )
}

function unavailableContextTransfer(request: ContextTransferRequest): ContextTransferResult {
  return ContextTransferResultSchema.parse({
    status: 'unknown',
    operationId: request.operationId,
    requestDigest: request.requestDigest,
    message: 'The selected CLI Bridge route does not support portable context transfer',
    retryable: false,
  })
}
