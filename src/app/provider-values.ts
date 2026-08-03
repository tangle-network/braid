import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import type { TurnUsage } from '../domain/events.js'
import { containsUnsafeControlCharacter } from '../domain/text.js'

/**
 * Provider payloads are untrusted input to durable state.
 *
 * A runtime may report a diagnostic, a model name, or a token count that
 * carries credential material, control sequences, or a value the journal
 * invariants reject. Everything a provider hands Braid passes through this
 * module before it reaches an event, so a bad provider can degrade a field to
 * a bounded placeholder but can never poison the journal.
 */

const SENSITIVE_DIAGNOSTIC =
  /(?:secret|password|passphrase|token|bearer|authorization|credential|private(?:[_-]?key)?|api[-_]?key|session(?:[_-]?key)?|access[_-]?key|client[_-]?secret|signature|signed[_-]?url|nonce)/iu
const SAFE_DIAGNOSTIC = /^[A-Za-z0-9][A-Za-z0-9 .,_'()[\]-]{0,159}$/u
const SAFE_PUBLIC_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u

export function finiteNonNegativeNumber(value: unknown): number
export function finiteNonNegativeNumber(value: unknown, fallback: undefined): number | undefined
export function finiteNonNegativeNumber(value: unknown, fallback = 0): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

export function safePublicIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return SAFE_PUBLIC_IDENTIFIER.test(text) && !SENSITIVE_DIAGNOSTIC.test(text) ? text : undefined
}

export function safeDiagnostic(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  if (
    text.length === 0 ||
    !SAFE_DIAGNOSTIC.test(text) ||
    containsUnsafeControlCharacter(text) ||
    SENSITIVE_DIAGNOSTIC.test(text)
  ) {
    return fallback
  }
  return text
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
