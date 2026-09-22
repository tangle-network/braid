import { canonicalDigest } from './canonical.js'
import type { Digest } from './ids.js'
import type { BraidInteraction } from './runtime-projection.js'
import type { BraidRun } from './state.js'

export function isOpenInteraction(interaction: BraidInteraction): boolean {
  return interaction.status === 'pending' || interaction.status === 'responding'
}

/** Return every interaction that can still require work, including evicted display records. */
export function pendingInteractionsForRun(run: BraidRun): readonly BraidInteraction[] {
  return run.pendingInteractions ?? run.interactions.filter(isOpenInteraction)
}

/** Return visible history plus hidden complete pending records, without duplicates. */
export function interactionsForRun(run: BraidRun): readonly BraidInteraction[] {
  const seen = new Set<string>()
  const interactions: BraidInteraction[] = []
  for (const interaction of [...run.interactions, ...pendingInteractionsForRun(run)]) {
    const identity = interactionIdentityDigest(interaction.request.id)
    if (seen.has(identity)) continue
    seen.add(identity)
    interactions.push(interaction)
  }
  return interactions
}

export function interactionForRun(
  run: BraidRun,
  interactionId: string,
): BraidInteraction | undefined {
  return (
    pendingInteractionsForRun(run).find((item) => item.request.id === interactionId) ??
    run.interactions.find((item) => item.request.id === interactionId)
  )
}

/**
 * Old snapshots can name an evicted pending interaction without retaining its request.
 * Preserve those identities so destructive actions continue to fail closed.
 */
export function unresolvedLegacyInteractionIds(run: BraidRun): readonly string[] {
  if (run.pendingInteractionIds === undefined) return []
  const known = new Set(pendingInteractionsForRun(run).map((item) => item.request.id))
  return run.pendingInteractionIds.filter((interactionId) => !known.has(interactionId))
}

export function allPendingInteractionIds(run: BraidRun): readonly string[] {
  return [
    ...pendingInteractionsForRun(run).map((item) => item.request.id),
    ...unresolvedLegacyInteractionIds(run),
  ]
}

export function interactionIdentityDigest(interactionId: string): Digest {
  return canonicalDigest(interactionId)
}

/**
 * Return the complete identity ledger, or undefined when truncation hides unknown history.
 */
export function interactionIdentityDigestsForRun(run: BraidRun): readonly Digest[] | undefined {
  if (run.interactionIdentityDigests !== undefined) return run.interactionIdentityDigests
  if (run.interactionsTruncated) return undefined
  return [
    ...new Set(
      [
        ...interactionsForRun(run).map((interaction) => interaction.request.id),
        ...(run.pendingInteractionIds ?? []),
      ].map(interactionIdentityDigest),
    ),
  ]
}
