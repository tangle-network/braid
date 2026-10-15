import type { TurnUsage } from '../domain/entities.js'
import { redactSensitiveText } from '../domain/secret-sanitizer.js'
import type { ProviderRunSnapshot } from '../ports/execution.js'
import {
  finiteNonNegativeNumber,
  optionalFiniteNonNegativeNumber,
  providerCause,
  runtimeFailureDiagnostic,
  safePublicIdentifier,
} from './provider-values.js'

export function safeSnapshotText(value: unknown): string {
  return typeof value === 'string' ? redactSensitiveText(value) : ''
}

export function safeSnapshotDetail(value: unknown, fallback: string): string {
  return providerCause(value) ?? fallback
}

/**
 * A settled snapshot keeps a stable error code and says why in its reason: the provider's detail,
 * or the error's own text when the provider gave no detail.
 */
export function snapshotFailure(
  snapshot: Pick<ProviderRunSnapshot, 'error' | 'detail'>,
  errorFallback: string,
  reasonFallback: string,
): { readonly error?: string; readonly reason?: string } {
  const error =
    snapshot.error === undefined
      ? undefined
      : runtimeFailureDiagnostic(snapshot.error, errorFallback)
  const reason =
    snapshot.detail !== undefined
      ? safeSnapshotDetail(snapshot.detail, reasonFallback)
      : error === undefined
        ? undefined
        : providerCause(snapshot.error)
  return {
    ...(error === undefined ? {} : { error }),
    ...(reason === undefined || reason === error ? {} : { reason }),
  }
}

export function safeSnapshotUsage(
  usage: ProviderRunSnapshot['usage'] | undefined,
  fallback: TurnUsage,
): TurnUsage {
  if (usage === undefined) return fallback
  const reasoning = optionalFiniteNonNegativeNumber(usage.reasoning)
  const calls =
    typeof usage.calls === 'number' && Number.isSafeInteger(usage.calls) && usage.calls >= 0
      ? usage.calls
      : undefined
  const costUsd = optionalFiniteNonNegativeNumber(usage.costUsd)
  const estimatedCostUsd = optionalFiniteNonNegativeNumber(usage.estimatedCostUsd)
  const latencyMs = optionalFiniteNonNegativeNumber(usage.latencyMs)
  const promptCache = Object.fromEntries(
    Object.entries(usage.promptCache ?? {}).filter(
      ([, value]) => Number.isFinite(value) && value >= 0,
    ),
  )
  const model = safePublicIdentifier(usage.model)
  return {
    input: finiteNonNegativeNumber(usage.input),
    output: finiteNonNegativeNumber(usage.output),
    ...(calls === undefined ? {} : { calls }),
    ...(usage.tokensKnown === false ? { tokensKnown: false } : {}),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(usage.usdKnown === false ? { usdKnown: false } : {}),
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
    ...(Object.keys(promptCache).length === 0 ? {} : { promptCache: Object.freeze(promptCache) }),
    ...(latencyMs === undefined ? {} : { latencyMs }),
    ...(model === undefined ? {} : { model }),
  }
}

export function safeSnapshotIdentity(value: unknown): string | undefined {
  return safePublicIdentifier(value)
}
