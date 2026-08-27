import {
  assert,
  assertExactKeys,
  safeIdentifier,
  safeText,
  strictIsoTimestamp,
} from '../release-evidence.mjs'

export const ENVIRONMENT_DETAIL_KEYS = Object.freeze([
  'schemaVersion',
  'cwd',
  'argv',
  'environment',
  'boundary',
  'machine',
  'os',
  'node',
  'region',
  'workspace',
  'packageVersions',
  'resourceIds',
  'billableResourceIds',
])

function uniqueStrings(values, label) {
  assert(Array.isArray(values), `${label} is not an array`)
  const unique = new Set()
  for (const value of values) {
    safeIdentifier(value, `${label} identifier`)
    assert(!unique.has(value), `${label} repeats ${value}`)
    unique.add(value)
  }
  return unique
}

function timestampValue(value, label) {
  if (typeof value === 'number') {
    assert(Number.isFinite(value), `${label} is not a finite timestamp`)
    return value
  }
  return strictIsoTimestamp(value, label)
}

function recordsById(records, key, label) {
  const values = records instanceof Map ? records : new Map()
  if (records instanceof Map) return values
  assert(Array.isArray(records), `${label} is not an array`)
  for (const record of records) {
    const id = record?.[key]
    assert(typeof id === 'string' && id.length > 0, `${label} has no ${key}`)
    assert(!values.has(id), `Duplicate ${label} ${id}`)
    values.set(id, record)
  }
  return values
}

export function validateEnvironmentProvenance(environment, { packageJson, dependencies = [] }) {
  safeIdentifier(environment.id, 'Environment id')
  assertExactKeys(environment, ['id', 'kind', 'details'], [], `Environment ${environment.id}`)
  safeIdentifier(environment.kind, `Environment ${environment.id} kind`)
  assertExactKeys(
    environment.details,
    ENVIRONMENT_DETAIL_KEYS,
    [],
    `Environment ${environment.id} details`,
  )
  assert(environment.details.schemaVersion === 1, `Environment ${environment.id} schema differs`)
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
  assert(packageJson?.name && packageJson?.version, 'Package identity is incomplete')
  assert(
    environment.details.packageVersions[packageJson.name] === packageJson.version,
    `Environment ${environment.id} package version differs`,
  )
  for (const dependency of dependencies) {
    assert(
      environment.details.packageVersions[dependency.name] === dependency.version,
      `Environment ${environment.id} dependency ${dependency.name} version differs`,
    )
  }

  const resources = uniqueStrings(
    environment.details.resourceIds,
    `Environment ${environment.id} resources`,
  )
  const billable = uniqueStrings(
    environment.details.billableResourceIds,
    `Environment ${environment.id} billable resources`,
  )
  for (const resource of billable)
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

export function validateCheckResources(check, environment, liveResources) {
  assert(Array.isArray(check.resources), `Check ${check.id} resources are not an array`)
  const resources = uniqueStrings(check.resources, `Check ${check.id} resources`)
  for (const resource of resources) {
    assert(liveResources.has(resource), `Check ${check.id} names unknown resource ${resource}`)
    assert(
      environment.details.resourceIds.includes(resource),
      `Check ${check.id} resource is outside its environment`,
    )
  }
  if (check.category === 'live' && check.result === 'passed')
    assert(resources.size > 0, `Live check ${check.id} has no resources`)
  if (check.category !== 'live')
    assert(resources.size === 0, `Non-live check ${check.id} names a resource`)
}

export function validateCleanup(resource, cleanup, releaseWindow) {
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
  const startedAt = timestampValue(releaseWindow.startedAt, 'Release start')
  const finishedAt = timestampValue(releaseWindow.finishedAt, 'Release finish')
  assert(
    completedAt >= startedAt && completedAt <= finishedAt,
    `Cleanup ${resource.id} is outside the release`,
  )
}

export function validateReleaseContext({
  environments,
  liveResources,
  cleanup,
  checks = new Map(),
  packageJson,
  dependencies = [],
  releaseWindow,
}) {
  const environmentMap = recordsById(environments, 'id', 'environment')
  const resourceMap = recordsById(liveResources, 'id', 'live resource')
  const cleanupMap = recordsById(cleanup, 'resourceId', 'cleanup record')
  assert(releaseWindow, 'Release window is required for context validation')

  for (const environment of environmentMap.values())
    validateEnvironmentProvenance(environment, { packageJson, dependencies })
  for (const resource of resourceMap.values()) validateResource(resource, environmentMap)

  for (const environment of environmentMap.values()) {
    const declared = new Set(environment.details.resourceIds)
    for (const resourceId of declared) {
      const resource = resourceMap.get(resourceId)
      assert(resource, `Environment ${environment.id} names unknown resource ${resourceId}`)
      assert(resource.environment === environment.id, `Resource ${resourceId} crosses environments`)
      if (resource.billable)
        assert(
          environment.details.billableResourceIds.includes(resourceId),
          `Billable resource ${resourceId} is not declared`,
        )
    }
    for (const resourceId of environment.details.billableResourceIds) {
      const resource = resourceMap.get(resourceId)
      assert(
        resource?.billable === true,
        `Environment ${environment.id} has a non-billable resource in its billable list`,
      )
    }
  }
  for (const resource of resourceMap.values()) {
    const environment = environmentMap.get(resource.environment)
    assert(
      environment.details.resourceIds.includes(resource.id),
      `Live resource ${resource.id} is omitted from its environment inventory`,
    )
    validateCleanup(resource, cleanupMap, releaseWindow)
  }
  for (const resourceId of cleanupMap.keys())
    assert(resourceMap.has(resourceId), `Cleanup names unknown live resource ${resourceId}`)

  for (const check of checks.values()) {
    const environment = environmentMap.get(check.environment)
    assert(environment, `Check ${check.id} names unknown environment ${check.environment}`)
    validateCheckResources(check, environment, resourceMap)
  }
  return { environments: environmentMap, liveResources: resourceMap, cleanup: cleanupMap }
}
