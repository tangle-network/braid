import type { RequestedInteractions, RunCapabilities } from './run-contracts.js'

/** Select the interaction posture for one admitted turn from provider capabilities. */
export function requestedInteractionsForRun(
  mode: string | undefined,
  capabilities: Pick<RunCapabilities, 'environment'>,
): RequestedInteractions {
  const advertised = capabilities.environment?.interactions
  if (advertised?.responseIdempotency !== true) return Object.freeze({})

  const requested: RequestedInteractions = {
    ...(advertised.kinds.includes('permission') ? { permission: true } : {}),
    ...(advertised.kinds.includes('question') ? { question: true } : {}),
    ...(mode === 'plan' && advertised.kinds.includes('plan') ? { plan: true } : {}),
  }
  return Object.freeze(requested)
}
