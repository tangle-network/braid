import {
  ContextTransferRequestSchema,
  ContextTransferResultSchema,
  contextTransferResultMatchesRequest,
  type AgentEnvironmentCapabilities,
  type AgentEnvironmentProvider,
  type ContextTransferRequest,
  type ContextTransferResult,
} from '@tangle-network/agent-interface'
import type { ContextTransferExecutionPort } from '../../ports/execution.js'

export interface ProviderContextTransferResolution {
  readonly provider: AgentEnvironmentProvider
  readonly capabilities: AgentEnvironmentCapabilities
}

export interface ProviderContextTransferOptions {
  readonly resolve: (
    request: ContextTransferRequest,
    target?: { readonly connectionId: string },
  ) => Promise<ProviderContextTransferResolution | undefined>
}

/** Route canonical history through the exact destination provider's admission contract. */
export function createProviderContextTransferPort(
  options: ProviderContextTransferOptions,
): ContextTransferExecutionPort {
  return Object.freeze({
    lookup: async (request: ContextTransferRequest, target?: { readonly connectionId: string }) => {
      const validated = ContextTransferRequestSchema.parse(request)
      const resolved = await options.resolve(validated, target)
      if (!supportsContextTransfer(resolved, validated)) return undefined
      const result = await resolved?.provider.contextTransfer?.lookup(validated)
      return result === undefined ? undefined : checkedResult(validated, result)
    },
    transfer: async (request: ContextTransferRequest, target?: { readonly connectionId: string }) => {
      const validated = ContextTransferRequestSchema.parse(request)
      const resolved = await options.resolve(validated, target)
      if (!supportsContextTransfer(resolved, validated)) return unavailableContextTransfer(validated)
      const result = await resolved?.provider.contextTransfer?.transfer(validated)
      return result === undefined ? unavailableContextTransfer(validated) : checkedResult(validated, result)
    },
  })
}

function checkedResult(request: ContextTransferRequest, result: ContextTransferResult): ContextTransferResult {
  const validated = ContextTransferResultSchema.parse(result)
  if (!contextTransferResultMatchesRequest(request, validated))
    throw new Error('The provider context transfer result does not match the exact request')
  return validated
}

function supportsContextTransfer(
  resolved: ProviderContextTransferResolution | undefined,
  request: ContextTransferRequest,
): boolean {
  if (resolved === undefined) return false
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
    message: 'The selected destination provider does not support retry-safe portable context transfer',
    retryable: false,
  })
}
