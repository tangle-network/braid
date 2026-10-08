import { canonicalDigest } from '../domain/canonical.js'

export const DEFAULT_CANCEL_REASON = 'Cancelled by user'

export function cancelRequestDigest(
  runId: string,
  reason: string,
  providerSessionId?: string,
): string {
  return canonicalDigest({
    control: 'cancel',
    runId,
    providerSessionId: providerSessionId ?? null,
    reason,
    text: null,
    cursor: null,
  })
}

export function shutdownRequestDigest(): string {
  return canonicalDigest({ command: 'shutdown' })
}
