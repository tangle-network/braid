import { canonicalJson } from '../release-evidence.mjs'
import { materializeRequirementBindings, requirementsObject } from './bindings.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export function packageVersionsForIdentity(identity) {
  return Object.fromEntries([
    [identity.packageName ?? '@tangle-network/braid', identity.braidVersion],
    ...identity.dependencies.map(({ name, version }) => [name, version]),
  ])
}

export function preserveRecord(map, key, value, label) {
  const existing = map.get(key)
  if (existing) {
    assert(canonicalJson(existing) === canonicalJson(value), `${label} ${key} differs`)
    return
  }
  map.set(key, value)
}

export function stateEnvelope({
  identity,
  startedAt,
  finishedAt,
  checks,
  environments,
  artifacts,
  checkArtifacts,
  requirementBindings,
  liveResources,
  cleanup,
}) {
  const artifactsByCheck = new Map(
    [...checks.values()].map((check) => [
      check.id,
      [check.stdout.artifactId, check.stderr.artifactId, ...(checkArtifacts.get(check.id) ?? [])],
    ]),
  )
  const requirements = materializeRequirementBindings(requirementBindings, {
    artifactsByCheck,
    additionalArtifacts: ['package-tarball', 'package-proof'],
  })
  return {
    schemaVersion: 1,
    braidVersion: identity.braidVersion,
    gitCommit: identity.gitCommit,
    packageIntegrity: identity.packageIntegrity,
    startedAt,
    finishedAt,
    sourceState: {
      clean: identity.clean,
      commit: identity.gitCommit,
      treeSha256: identity.treeSha256,
      tarballSha256: identity.tarballSha256,
      tarballArtifactId: 'package-tarball',
    },
    dependencies: identity.dependencies,
    environments: [...environments.values()].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    ),
    checks: [...checks.values()].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    ),
    requirements: requirementsObject(requirements),
    artifacts: [...artifacts.values()].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    ),
    liveResources: [...liveResources.values()].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    ),
    cleanup: [...cleanup.values()].sort((left, right) =>
      left.resourceId < right.resourceId ? -1 : left.resourceId > right.resourceId ? 1 : 0,
    ),
    signatures: [],
  }
}
