import {
  ADMISSIBLE_CATEGORIES,
  exactRequirementCheckCategories,
  REQUIRED_CHECK_REQUIREMENTS,
} from '../release-check-catalog.mjs'
import { assert, assertExactKeys } from '../release-evidence.mjs'
import { validateReleaseContext } from './verification-context.mjs'

export function validateRequirementMappings({
  requirements,
  mappings,
  checks,
  artifacts,
  tarballArtifactId,
}) {
  for (const requirement of requirements) {
    const mapping = mappings.get(requirement)
    assert(mapping, `Requirement ${requirement} has no evidence mapping`)
    assertExactKeys(mapping, ['checks', 'artifacts'], [], `Requirement ${requirement}`)
    assert(
      Array.isArray(mapping.checks) && mapping.checks.length > 0,
      `${requirement} has no checks`,
    )
    assert(
      Array.isArray(mapping.artifacts) && mapping.artifacts.length > 0,
      `${requirement} has no artifacts`,
    )
    assert(new Set(mapping.checks).size === mapping.checks.length, `${requirement} repeats a check`)
    assert(
      new Set(mapping.artifacts).size === mapping.artifacts.length,
      `${requirement} repeats an artifact`,
    )
    for (const check of mapping.checks)
      assert(checks.has(check), `${requirement} names unknown check ${check}`)
    for (const artifact of mapping.artifacts)
      assert(artifacts.has(artifact), `${requirement} names unknown artifact ${artifact}`)
    const prefix = requirement.slice(0, requirement.indexOf('-'))
    const admissibleCategories = ADMISSIBLE_CATEGORIES.get(prefix)
    assert(admissibleCategories, `Requirement ${requirement} has no category policy`)
    assert(
      mapping.checks.some((id) => admissibleCategories.has(checks.get(id).category)),
      `${requirement} is linked only to inadmissible check categories`,
    )
    const exactCategories = exactRequirementCheckCategories(requirement)
    if (exactCategories) {
      const exactCheck = checks.get(requirement)
      assert(exactCheck, `Requirement ${requirement} requires its own check record`)
      assert(
        exactCategories.has(exactCheck.category),
        `Check ${requirement} has inadmissible category`,
      )
      assert(
        mapping.checks.includes(requirement),
        `${requirement} does not cite its own check record`,
      )
    }
  }
  for (const requirement of mappings.keys())
    assert(requirements.has(requirement), `Evidence maps unknown requirement ${requirement}`)

  for (const [checkId, requirement] of REQUIRED_CHECK_REQUIREMENTS) {
    const mapping = mappings.get(requirement)
    const check = checks.get(checkId)
    assert(check, `Fixed check ${checkId} is missing`)
    assert(
      mapping?.checks.includes(checkId),
      `Fixed check ${checkId} is not assigned to ${requirement}`,
    )
    const prefix = requirement.slice(0, requirement.indexOf('-'))
    assert(
      ADMISSIBLE_CATEGORIES.get(prefix)?.has(check.category),
      `Fixed check ${checkId} has an inadmissible owner ${requirement}`,
    )
  }

  const referencedChecks = new Set(
    [...mappings.values()].flatMap((mapping) =>
      Array.isArray(mapping.checks) ? mapping.checks : [],
    ),
  )
  for (const id of checks.keys())
    assert(referencedChecks.has(id), `Check ${id} is not linked to a requirement`)
  const referencedArtifacts = new Set([
    tarballArtifactId,
    ...[...checks.values()].flatMap((check) => [check.stdout.artifactId, check.stderr.artifactId]),
    ...[...mappings.values()].flatMap((mapping) =>
      Array.isArray(mapping.artifacts) ? mapping.artifacts : [],
    ),
  ])
  for (const id of artifacts.keys())
    assert(referencedArtifacts.has(id), `Artifact ${id} is unreferenced`)
}

export function validateLiveResources({
  evidence,
  environments,
  checks = new Map(),
  packageJson,
  dependencies = [],
  releaseWindow,
}) {
  return validateReleaseContext({
    environments,
    liveResources: evidence.liveResources,
    cleanup: evidence.cleanup,
    checks,
    packageJson,
    dependencies,
    releaseWindow,
  })
}
