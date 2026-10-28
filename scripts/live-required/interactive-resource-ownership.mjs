/** Exact ownership of the Sandbox resource one Braid interactive run creates. */

export function interactiveResourceName(runId) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9._:-]{1,95}$/u.test(runId)) {
    throw new Error('Interactive run-derived cleanup requires a bounded Braid run identity')
  }
  return `braid-interactive-${runId}`
}

export function isOwnedInteractiveResource(box, expectedName) {
  return (
    typeof box?.id === 'string' &&
    box.name === expectedName &&
    box.metadata?.owner === 'braid' &&
    box.metadata?.lifecycle === 'retained' &&
    box.metadata?.surface === 'interactive-agent'
  )
}

export function sameNameInteractiveResources(resources, expectedName, predicate) {
  const matches = resources.filter((resource) => resource?.name === expectedName)
  if (matches.length > 1) {
    throw new Error(
      `Interactive run-derived cleanup found ${String(matches.length)} same-name Sandbox resources; cleanup refused`,
    )
  }
  if (matches.length === 1 && !predicate(matches[0])) {
    throw new Error(
      `Interactive run-derived resource ${String(matches[0]?.id ?? 'without-id')} failed exact ownership validation`,
    )
  }
  return matches
}
