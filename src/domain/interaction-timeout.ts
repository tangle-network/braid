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
