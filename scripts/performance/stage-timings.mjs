export function summarizeStage(samples) {
  if (samples.length === 0) {
    return {
      n: 0,
      total: 0,
      mean: null,
      minimum: null,
      median: null,
      p90: null,
      p95: null,
      p99: null,
      maximum: null,
    }
  }
  const ordered = [...samples].sort((left, right) => left - right)
  const total = ordered.reduce((sum, value) => sum + value, 0)
  const at = (fraction) =>
    ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)]
  return {
    n: ordered.length,
    total,
    mean: total / ordered.length,
    minimum: ordered[0],
    median: at(0.5),
    p90: at(0.9),
    p95: at(0.95),
    p99: at(0.99),
    maximum: ordered.at(-1),
  }
}
