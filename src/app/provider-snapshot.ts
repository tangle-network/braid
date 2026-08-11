import type { TurnUsage } from '../domain/entities.js'
import { redactSensitiveText } from '../domain/secret-sanitizer.js'
import type { ProviderRunSnapshot } from '../ports/execution.js'
import {
  finiteNonNegativeNumber,
  optionalFiniteNonNegativeNumber,
  safeProviderDiagnostic,
  safePublicIdentifier,
} from './provider-values.js'

export function safeSnapshotText(value: unknown): string {
  return typeof value === 'string' ? redactSensitiveText(value) : ''
}

export function safeSnapshotDetail(value: unknown, fallback: string): string {
  return safeProviderDiagnostic(value, fallback)
}

export function safeSnapshotUsage(
  usage: ProviderRunSnapshot['usage'] | undefined,
  fallback: TurnUsage,
): TurnUsage {
  if (usage === undefined) return fallback
  const reasoning = optionalFiniteNonNegativeNumber(usage.reasoning)
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
