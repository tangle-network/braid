// Readers for what Braid's terminal shows; the live proofs decide from these, not from timing.
export const TRANSCRIPT_FOOTER = 'type / for commands ·'

/** The activity list (its `tab filter` footer) or its runs tab, where keys go to the browser. */
export function activityBrowserOpen(screen) {
  if (typeof screen !== 'string') return false
  return screen.includes('· tab filter') || screen.split('\n').some((l) => /^\s*runs ›/u.test(l))
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
