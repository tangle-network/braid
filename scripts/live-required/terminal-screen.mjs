// Readers for what Braid's terminal shows; the live proofs decide from these, not from timing.
export const TRANSCRIPT_FOOTER = 'type / for commands ·'

// Each activity-browser tab titles its first line `activity`, `runs`, `analyses` or `workers`,
// then `›` or `·`; the browser remembers its tab, so a proof can reopen it on any of them.
const BROWSER_TAB = /^\s*(activity|runs|analyses|workers) [›·]/mu

/** Whether the activity browser is open on any tab, where keys go to the browser. */
export function activityBrowserOpen(screen) {
  return typeof screen === 'string' && (screen.includes('· tab filter') || BROWSER_TAB.test(screen))
}

/** The selected browser tab, when its header is visible. */
export function browserTab(screen) {
  return typeof screen === 'string' ? BROWSER_TAB.exec(screen)?.[1] : undefined
}

export function transcriptSurfaceReady(screen) {
  return (
    typeof screen === 'string' && !activityBrowserOpen(screen) && screen.includes(TRANSCRIPT_FOOTER)
  )
}

export function renderedWorkStripCount(screen) {
  return screen
    .split('\n')
    .filter((line) =>
      /^(?:focus|work) .+ · (?:queued|starting|running|waiting|detached|reconnecting|cancelling)(?: ·|\s|$)/u.test(
        line.trimStart(),
      ),
    ).length
}
