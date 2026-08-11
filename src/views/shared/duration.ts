export function elapsedSince(startedAt: string, now = Date.now()): number | undefined {
  const started = Date.parse(startedAt)
  const elapsed = now - started
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined
}

export function effectiveElapsedMs(
  status: string,
  startedAt: string | undefined,
  recorded: number | undefined,
  now = Date.now(),
): number | undefined {
  if (
    (status === 'running' || status === 'starting' || status === 'reconnecting') &&
    startedAt !== undefined
  ) {
    return elapsedSince(startedAt, now)
  }
  return recorded
}

export function formatDuration(milliseconds: number): string {
  const value = Math.max(0, milliseconds)
  if (value < 1_000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`
  if (value < 3_600_000) {
    const minutes = Math.floor(value / 60_000)
    const seconds = Math.floor((value % 60_000) / 1_000)
    return `${minutes}m ${seconds}s`
  }
  if (value < 86_400_000) {
    const hours = Math.floor(value / 3_600_000)
    const minutes = Math.floor((value % 3_600_000) / 60_000)
    return `${hours}h ${minutes}m`
  }
  const days = Math.floor(value / 86_400_000)
  const hours = Math.floor((value % 86_400_000) / 3_600_000)
  return `${days}d ${hours}h`
}
