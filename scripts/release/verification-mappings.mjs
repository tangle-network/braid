import {
  ADMISSIBLE_CATEGORIES,
  exactRequirementCheckCategories,
} from '../release-check-catalog.mjs'
import { assert, assertExactKeys, strictIsoTimestamp } from '../release-evidence.mjs'

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

export function validateLiveResources({ evidence, environments }) {
  const liveResources = new Map()
  for (const resource of evidence.liveResources) {
    assert(typeof resource?.id === 'string' && resource.id.length > 0, 'Live resource has no id')
    assert(!liveResources.has(resource.id), `Duplicate live resource ${resource.id}`)
    liveResources.set(resource.id, resource)
    assertExactKeys(
      resource,
      ['id', 'type', 'environment', 'billable'],
      [],
      `Live resource ${resource.id}`,
    )
    assert(
      environments.has(resource.environment),
      `Live resource ${resource.id} names an unknown environment`,
    )
    assert(
      typeof resource.type === 'string' && resource.type.length > 0,
      `Live resource ${resource.id} has no type`,
    )
    assert(
      typeof resource.billable === 'boolean',
      `Live resource ${resource.id} has invalid billable state`,
    )
  }
  const cleanup = new Map()
  for (const record of evidence.cleanup) {
    assert(
      typeof record?.resourceId === 'string' && record.resourceId.length > 0,
      'Cleanup record has no resource id',
    )
    assert(!cleanup.has(record.resourceId), `Duplicate cleanup record ${record.resourceId}`)
    cleanup.set(record.resourceId, record)
    assertExactKeys(
      record,
      ['resourceId', 'status', 'completedAt'],
      ['reason'],
      `Cleanup ${record.resourceId}`,
    )
    assert(
      record.status === 'confirmed',
      `Live resource ${record.resourceId} cleanup is unresolved`,
    )
    strictIsoTimestamp(record.completedAt, `Cleanup ${record.resourceId} completion`)
  }
  for (const resource of liveResources.values()) {
    assert(cleanup.has(resource.id), `Live resource ${resource.id} has no cleanup record`)
  }
  for (const resourceId of cleanup.keys())
    assert(liveResources.has(resourceId), `Cleanup names unknown live resource ${resourceId}`)
}
