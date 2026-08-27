import { REQUIRED_CHECK_REQUIREMENTS, REQUIRED_CHECKS } from '../release-check-catalog.mjs'

const REQUIREMENT_ID = /^[A-Z]{2,4}-[0-9]{2}$/u

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function asEntries(input) {
  if (Array.isArray(input)) return input.map((entry) => [entry?.id, entry])
  assert(input && typeof input === 'object', 'Requirement bindings must be an array or object')
  return Object.entries(input).map(([id, value]) => [id, { id, ...value }])
}

export function normalizeRequirementBindings(input, requirementIds, checkIds) {
  const knownRequirements = new Set(requirementIds)
  const knownChecks = new Set(checkIds ?? REQUIRED_CHECKS.keys())
  const entries = asEntries(input)
  const bindings = new Map()
  for (const [id, value] of entries) {
    assert(
      typeof id === 'string' && REQUIREMENT_ID.test(id),
      `Invalid requirement identifier: ${id}`,
    )
    assert(knownRequirements.has(id), `Unknown requirement identifier: ${id}`)
    assert(!bindings.has(id), `Duplicate requirement identifier: ${id}`)
    assert(value && typeof value === 'object' && !Array.isArray(value), `Invalid binding for ${id}`)
    assert(Array.isArray(value.checks) && value.checks.length > 0, `${id} has no check bindings`)
    assert(
      Array.isArray(value.artifacts) && value.artifacts.length > 0,
      `${id} has no artifact bindings`,
    )
    const checks = [...value.checks]
    const artifacts = [...value.artifacts]
    assert(new Set(checks).size === checks.length, `${id} repeats a check binding`)
    assert(new Set(artifacts).size === artifacts.length, `${id} repeats an artifact binding`)
    for (const check of checks) assert(knownChecks.has(check), `${id} names unknown check ${check}`)
    for (const artifact of artifacts)
      assert(
        typeof artifact === 'string' && artifact.length > 0,
        `${id} has an invalid artifact binding`,
      )
    bindings.set(id, { checks, artifacts })
  }
  for (const id of knownRequirements) assert(bindings.has(id), `Requirement ${id} has no binding`)
  for (const [checkId, requirement] of REQUIRED_CHECK_REQUIREMENTS) {
    if (!knownChecks.has(checkId) || !knownRequirements.has(requirement)) continue
    assert(
      bindings.get(requirement)?.checks.includes(checkId),
      `Fixed check ${checkId} is not assigned to ${requirement}`,
    )
  }
  return bindings
}

export function normalizeRequirementCheckBindings(input, requirementIds, checkIds) {
  const knownRequirements = new Set(requirementIds)
  const knownChecks = new Set(checkIds ?? REQUIRED_CHECKS.keys())
  const entries = asEntries(input)
  const bindings = new Map()
  for (const [id, value] of entries) {
    assert(
      typeof id === 'string' && REQUIREMENT_ID.test(id),
      `Invalid requirement identifier: ${id}`,
    )
    assert(knownRequirements.has(id), `Unknown requirement identifier: ${id}`)
    assert(!bindings.has(id), `Duplicate requirement identifier: ${id}`)
    assert(value && typeof value === 'object' && !Array.isArray(value), `Invalid binding for ${id}`)
    assert(Array.isArray(value.checks) && value.checks.length > 0, `${id} has no check bindings`)
    const checks = [...value.checks]
    assert(new Set(checks).size === checks.length, `${id} repeats a check binding`)
    for (const check of checks) assert(knownChecks.has(check), `${id} names unknown check ${check}`)
    bindings.set(id, { checks })
  }
  for (const id of knownRequirements) assert(bindings.has(id), `Requirement ${id} has no binding`)
  return bindings
}

export function materializeRequirementBindings(
  checkBindings,
  { artifactsByCheck = new Map(), additionalArtifacts = [] } = {},
) {
  assert(checkBindings instanceof Map, 'Requirement check bindings must be a map')
  const extra = [...new Set(additionalArtifacts)]
  return new Map(
    [...checkBindings.entries()].map(([id, binding]) => {
      const artifacts = [
        ...extra,
        ...binding.checks.flatMap((check) => artifactsByCheck.get(check) ?? []),
      ]
      assert(artifacts.length > 0, `${id} has no materialized artifact bindings`)
      assert(
        new Set(artifacts).size === artifacts.length,
        `${id} repeats a materialized artifact binding`,
      )
      return [id, { checks: [...binding.checks], artifacts }]
    }),
  )
}

export function requirementsObject(bindings) {
  return Object.fromEntries(
    [...bindings.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  )
}

export function requirementIdsForCheck(bindings, checkId) {
  return [...bindings.entries()]
    .filter(([, binding]) => binding.checks.includes(checkId))
    .map(([id]) => id)
    .sort()
}
