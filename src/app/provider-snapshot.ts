import { redactSensitiveText } from '../domain/secret-sanitizer.js'
import type { TurnUsage } from '../domain/entities.js'
import type { ProviderRunSnapshot } from '../ports/execution.js'
import {
  finiteNonNegativeNumber,
  safePublicIdentifier,
  safeProviderDiagnostic,
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
  const reasoning = finiteNonNegativeNumber(usage.reasoning, undefined)
  const costUsd = finiteNonNegativeNumber(usage.costUsd, undefined)
  const model = safePublicIdentifier(usage.model)
  return {
    input: finiteNonNegativeNumber(usage.input),
    output: finiteNonNegativeNumber(usage.output),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(model === undefined ? {} : { model }),
  }
}

export function safeSnapshotIdentity(value: unknown): string | undefined {
  return safePublicIdentifier(value)
}
