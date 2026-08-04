import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import type { TurnUsage } from '../domain/events.js'
import {
  finiteNonNegativeNumber,
  safeProviderDiagnostic,
  safePublicIdentifier,
} from '../domain/provider-values.js'

export {
  finiteNonNegativeNumber,
  safeDiagnostic,
  safeProviderDiagnostic,
  safePublicIdentifier,
} from '../domain/provider-values.js'

/**
 * Provider payloads are untrusted input to durable state.
 *
 * A runtime may report a diagnostic, a model name, or a token count that
 * carries credential material, control sequences, or a value the journal
 * invariants reject. Everything a provider hands Braid passes through this
 * module before it reaches an event, so a bad provider can degrade a field to
 * a bounded placeholder but can never poison the journal.
 */

export function safeRuntimeDiagnostic(value: unknown, fallback: string): string {
  return safeProviderDiagnostic(value, fallback)
}

export function usageFromFinal(event: Extract<RuntimeStreamEvent, { type: 'final' }>): TurnUsage {
  const metadata = event.metadata ?? {}
  const tokenUsage =
    metadata.tokenUsage && typeof metadata.tokenUsage === 'object'
      ? (metadata.tokenUsage as Record<string, unknown>)
      : {}
  const costUsd = finiteNonNegativeNumber(metadata.costUsd, undefined)
  const model = safePublicIdentifier(metadata.model)
  return {
    input: finiteNonNegativeNumber(tokenUsage.input),
    output: finiteNonNegativeNumber(tokenUsage.output),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(model === undefined ? {} : { model }),
  }
}
