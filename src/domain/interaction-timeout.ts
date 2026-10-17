import type { BraidInteraction } from './runtime-projection.js'

/**
 * When an interaction's response window starts: the provider's own time, else when Braid received
 * it. Tangle Sandbox events carry no provider time, so falling through to the run start expired
 * every request raised later than its window into the run.
 */
export function interactionRequestedAt(
  interaction: Pick<BraidInteraction, 'source' | 'receivedAt'>,
): string | undefined {
  return interaction.source.occurredAt ?? interaction.receivedAt
}

export function interactionRemainingMs(
  timeoutMs: number | undefined,
  requestedAt: string | undefined,
  runStartedAt: string | undefined,
  now: string | number = Date.now(),
): number | undefined {
  if (timeoutMs === undefined) return undefined
  const started = Date.parse(requestedAt ?? runStartedAt ?? '')
  const current = typeof now === 'number' ? now : Date.parse(now)
  if (!Number.isFinite(started) || !Number.isFinite(current)) return undefined
  const elapsed = Math.max(0, current - started)
  return Math.max(0, timeoutMs - elapsed)
}
