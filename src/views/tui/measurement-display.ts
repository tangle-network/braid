const UNREPORTED_COST_OR_LATENCY = /^(?:cost|latency) unknown(?: \(\+\d+ unknown\))?$/u

/** Keeps missing cost and latency out of compact TUI lines without changing source data. */
export function omitUnreportedCostAndLatency(lines: readonly string[]): readonly string[] {
  return lines.flatMap((line) => {
    const visibleParts = line
      .split(' · ')
      .filter((part) => !UNREPORTED_COST_OR_LATENCY.test(part.trim()))
    return visibleParts.length === 0 ? [] : [visibleParts.join(' · ')]
  })
}
