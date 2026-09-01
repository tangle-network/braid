import { assert, assertExactKeys, canonicalJson } from '../release-evidence.mjs'

export const LIVE_EVIDENCE_BINDING_SCHEMA = 'braid.live-evidence-binding.v1'
export const RUNTIME_PACKAGE_NAME = '@tangle-network/agent-runtime'

const BINDING_KEYS = Object.freeze([
  'schema',
  'braidVersion',
  'gitCommit',
  'tarballSha256',
  'packageIntegrity',
  'dependencyDigest',
  'runtimeVersion',
  'runtimeIntegrity',
])

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value, label) {
  assert(typeof value === 'string' && value.length > 0, `${label} must be non-empty text`)
}

function runtimeDependency(identity) {
  const runtime = identity?.dependencies?.find(({ name }) => name === RUNTIME_PACKAGE_NAME)
  assert(runtime, `Candidate identity has no ${RUNTIME_PACKAGE_NAME} dependency`)
  text(runtime.version, `${RUNTIME_PACKAGE_NAME} version`)
  text(runtime.integrity, `${RUNTIME_PACKAGE_NAME} integrity`)
  return runtime
}

/** Build the release identity that every checked live artifact must carry. */
export function liveEvidenceBinding(identity) {
  const runtime = runtimeDependency(identity)
  return {
    schema: LIVE_EVIDENCE_BINDING_SCHEMA,
    braidVersion: identity.braidVersion,
    gitCommit: identity.gitCommit,
    tarballSha256: identity.tarballSha256,
    packageIntegrity: identity.packageIntegrity,
    dependencyDigest: identity.dependencyDigest,
    runtimeVersion: runtime.version,
    runtimeIntegrity: runtime.integrity,
  }
}

export function parseLiveEvidenceBinding(value, label = 'Live evidence binding') {
  assertExactKeys(value, BINDING_KEYS, [], label)
  assert(value.schema === LIVE_EVIDENCE_BINDING_SCHEMA, `${label} schema differs`)
  text(value.braidVersion, `${label} braidVersion`)
  assert(/^[a-f0-9]{40}$/u.test(value.gitCommit), `${label} gitCommit is not a full SHA`)
  assert(/^[a-f0-9]{64}$/u.test(value.tarballSha256), `${label} tarballSha256 is invalid`)
  assert(
    /^sha512-(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value.packageIntegrity,
    ),
    `${label} packageIntegrity is invalid`,
  )
  assert(/^[a-f0-9]{64}$/u.test(value.dependencyDigest), `${label} dependencyDigest is invalid`)
  text(value.runtimeVersion, `${label} runtimeVersion`)
  assert(
    /^sha512-(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value.runtimeIntegrity,
    ),
    `${label} runtimeIntegrity is invalid`,
  )
  return value
}

export function liveEvidenceBindingFromEnvironment(environment = process.env) {
  const serialized = environment?.BRAID_RELEASE_LIVE_EVIDENCE_BINDING
  if (serialized === undefined) return undefined
  assert(typeof serialized === 'string' && serialized.length > 0, 'Release live binding is empty')
  let value
  try {
    value = JSON.parse(serialized)
  } catch (error) {
    throw new Error('Release live binding is not valid JSON', { cause: error })
  }
  return parseLiveEvidenceBinding(value, 'Release live binding')
}

export function assertLiveEvidenceBinding(value, identity, label = 'Live evidence') {
  assert(object(value), `${label} has no release binding`)
  const actual = parseLiveEvidenceBinding(value, `${label} release binding`)
  const expected = liveEvidenceBinding(identity)
  assert(
    canonicalJson(actual) === canonicalJson(expected),
    `${label} release binding differs from the candidate identity`,
  )
  return actual
}

export function serializedLiveEvidenceBinding(identity) {
  return canonicalJson(liveEvidenceBinding(identity))
}
