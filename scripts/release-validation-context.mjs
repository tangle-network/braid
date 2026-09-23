import {
  assert,
  assertExactKeys,
  safeIdentifier,
  safeText,
  strictIsoTimestamp,
} from './release-evidence.mjs'

const ENVIRONMENT_DETAIL_KEYS = [
  'machine',
  'os',
  'node',
  'region',
  'workspace',
  'packageVersions',
  'resourceIds',
  'billableResourceIds',
]

export function validateEnvironment(environment, packageJson) {
  safeIdentifier(environment.id, 'Environment id')
  assertExactKeys(environment, ['id', 'kind', 'details'], [], `Environment ${environment.id}`)
  safeIdentifier(environment.kind, `Environment ${environment.id} kind`)
  assertExactKeys(
    environment.details,
    ENVIRONMENT_DETAIL_KEYS,
    [],
    `Environment ${environment.id} details`,
  )
  for (const field of ['machine', 'os', 'node', 'region', 'workspace'])
    safeText(environment.details[field], `Environment ${environment.id} ${field}`)
  assert(
    environment.details.packageVersions &&
      typeof environment.details.packageVersions === 'object' &&
      !Array.isArray(environment.details.packageVersions),
    `Environment ${environment.id} has no package versions`,
  )
  for (const [name, version] of Object.entries(environment.details.packageVersions)) {
    safeText(name, `Environment ${environment.id} package name`)
    safeText(version, `Environment ${environment.id} package version`)
  }
  assert(
    environment.details.packageVersions[packageJson.name] === packageJson.version,
    `Environment ${environment.id} package version differs`,
  )
  for (const field of ['resourceIds', 'billableResourceIds']) {
    const values = environment.details[field]
    assert(Array.isArray(values), `Environment ${environment.id} ${field} is not an array`)
    const unique = new Set()
    for (const value of values) {
      safeIdentifier(value, `Environment ${environment.id} resource`)
      assert(!unique.has(value), `Environment ${environment.id} repeats ${value}`)
      unique.add(value)
    }
  }
  const resources = new Set(environment.details.resourceIds)
  for (const resource of environment.details.billableResourceIds)
    assert(
      resources.has(resource),
      `Environment ${environment.id} billable resource is not declared`,
    )
}

export function validateResource(resource, environments) {
  safeIdentifier(resource.id, 'Live resource id')
  assertExactKeys(
    resource,
    ['id', 'type', 'environment', 'billable'],
    [],
    `Live resource ${resource.id}`,
  )
  safeIdentifier(resource.type, `Live resource ${resource.id} type`)
  assert(
    environments.has(resource.environment),
    `Live resource ${resource.id} names an unknown environment`,
  )
  assert(
    typeof resource.billable === 'boolean',
    `Live resource ${resource.id} has invalid billable state`,
  )
}

export function validateCleanup(resource, cleanup, releaseStartedAt, releaseFinishedAt) {
  const record = cleanup.get(resource.id)
  assert(record, `Live resource ${resource.id} has no cleanup record`)
  assertExactKeys(
    record,
    ['resourceId', 'status', 'completedAt'],
    ['reason'],
    `Cleanup ${resource.id}`,
  )
  assert(record.status === 'confirmed', `Live resource ${resource.id} cleanup is unresolved`)
  const completedAt = strictIsoTimestamp(record.completedAt, `Cleanup ${resource.id} completion`)
  assert(
    completedAt >= releaseStartedAt && completedAt <= releaseFinishedAt,
    `Cleanup ${resource.id} is outside the release`,
  )
}

export function validateCheckResources(check, environment, liveResources) {
  assert(Array.isArray(check.resources), `Check ${check.id} resources are not an array`)
  const resources = new Set()
  for (const resource of check.resources) {
    safeIdentifier(resource, `Check ${check.id} resource`)
    assert(!resources.has(resource), `Check ${check.id} repeats resource ${resource}`)
    resources.add(resource)
    assert(liveResources.has(resource), `Check ${check.id} names unknown resource ${resource}`)
    assert(
      environment.details.resourceIds.includes(resource),
      `Check ${check.id} resource is outside its environment`,
    )
  }
  if (check.category === 'live')
    assert(resources.size > 0, `Live check ${check.id} has no resources`)
  else assert(resources.size === 0, `Non-live check ${check.id} names a resource`)
}
