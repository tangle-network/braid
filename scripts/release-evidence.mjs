import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
} from 'node:crypto'
import { assertSafeJsonObject, assertSafeJsonValue, canonicalJson } from './release-json.mjs'

export { canonicalJson } from './release-json.mjs'

const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

export function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export function assertExactKeys(value, required, optional, label) {
  assertSafeJsonObject(value, label)
  const keys = new Set(Object.keys(value))
  for (const key of required) assert(keys.delete(key), `${label} has no ${key}`)
  for (const key of optional) keys.delete(key)
  assert(keys.size === 0, `${label} has an unknown field`)
}

export function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function publicKeyId(key) {
  const publicKey = key?.type === 'public' ? key : createPublicKey(key)
  const der = publicKey.export({ format: 'der', type: 'spki' })
  return `sha256:${createHash('sha256').update(der).digest('hex')}`
}

export function checkSigningPayload(check) {
  const { receipt: _receipt, ...unsignedCheck } = check
  return {
    schema: 'braid.release-check.v1',
    check: unsignedCheck,
  }
}

export function manifestSigningPayload(manifest) {
  return {
    schema: 'braid.release-manifest.v1',
    manifest: { ...manifest, signatures: [] },
  }
}

export function signPayload(payload, privateKey) {
  const key = privateKey?.type === 'private' ? privateKey : createPrivateKey(privateKey)
  const publicKey = createPublicKey(key)
  const bytes = Buffer.from(canonicalJson(payload))
  return {
    algorithm: 'ed25519',
    keyId: publicKeyId(publicKey),
    payloadSha256: sha256Text(bytes),
    signature: signBytes(null, bytes, key).toString('base64'),
  }
}

export function verifyPayload(payload, receipt, publicKey, label) {
  assertExactKeys(
    receipt,
    ['algorithm', 'keyId', 'payloadSha256', 'signature'],
    [],
    `${label} receipt`,
  )
  assert(receipt.algorithm === 'ed25519', `${label} receipt does not use Ed25519`)
  assert(receipt.keyId === publicKeyId(publicKey), `${label} receipt uses an untrusted key`)
  assert(SHA256_PATTERN.test(receipt.payloadSha256), `${label} receipt has an invalid payload hash`)
  assert(
    typeof receipt.signature === 'string' &&
      BASE64_PATTERN.test(receipt.signature) &&
      Buffer.from(receipt.signature, 'base64').toString('base64') === receipt.signature,
    `${label} receipt has an invalid signature encoding`,
  )
  const bytes = Buffer.from(canonicalJson(payload))
  assert(sha256Text(bytes) === receipt.payloadSha256, `${label} receipt payload changed`)
  assert(
    verifyBytes(null, bytes, publicKey, Buffer.from(receipt.signature, 'base64')),
    `${label} receipt signature is invalid`,
  )
}

export function signCheck(check, privateKey) {
  return {
    ...check,
    receipt: signPayload(checkSigningPayload(check), privateKey),
  }
}

export function verifyCheckReceipt(check, publicKey) {
  verifyPayload(checkSigningPayload(check), check.receipt, publicKey, `Check ${check.id}`)
}

export function signManifest(manifest, privateKey) {
  return {
    ...manifest,
    signatures: [signPayload(manifestSigningPayload(manifest), privateKey)],
  }
}

export function verifyManifestSignature(manifest, publicKey) {
  assert(
    Array.isArray(manifest.signatures) && manifest.signatures.length === 1,
    'Manifest must have one signature',
  )
  verifyPayload(manifestSigningPayload(manifest), manifest.signatures[0], publicKey, 'Manifest')
}

export function strictIsoTimestamp(value, label) {
  assert(
    typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    `${label} is not a canonical UTC timestamp`,
  )
  return Date.parse(value)
}

export function validateReleaseInputEnvelope(evidence) {
  assertSafeJsonValue(evidence, 'Release evidence')
  assertExactKeys(
    evidence,
    [
      'schemaVersion',
      'braidVersion',
      'gitCommit',
      'packageIntegrity',
      'startedAt',
      'finishedAt',
      'sourceState',
      'dependencies',
      'environments',
      'checks',
      'requirements',
      'artifacts',
      'liveResources',
      'cleanup',
      'signatures',
    ],
    [],
    'Release evidence',
  )
  assert(evidence.schemaVersion === 1, 'Unsupported release evidence schema')
  assert(
    typeof evidence.braidVersion === 'string' &&
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(evidence.braidVersion),
    'Release evidence has no safe semantic version',
  )
  assert(/^[a-f0-9]{40}$/u.test(evidence.gitCommit), 'Release evidence has no full Git commit')
  assert(
    /^sha512-(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      evidence.packageIntegrity,
    ),
    'Package integrity is not SHA-512 SRI',
  )
  const startedAt = strictIsoTimestamp(evidence.startedAt, 'Release start')
  const finishedAt = strictIsoTimestamp(evidence.finishedAt, 'Release finish')
  assert(finishedAt >= startedAt, 'Release finished before it started')
  assert(
    Array.isArray(evidence.signatures) && evidence.signatures.length === 0,
    'Input evidence must be unsigned',
  )
  assertExactKeys(
    evidence.sourceState,
    ['clean', 'commit', 'treeSha256', 'tarballSha256', 'tarballArtifactId'],
    [],
    'Source state',
  )
  assert(typeof evidence.sourceState.clean === 'boolean', 'Source clean state is not boolean')
  assert(/^[a-f0-9]{40}$/u.test(evidence.sourceState.commit), 'Source commit is not a full SHA')
  assert(/^[a-f0-9]{40}$/u.test(evidence.sourceState.treeSha256), 'Source tree is not a full SHA')
  assert(SHA256_PATTERN.test(evidence.sourceState.tarballSha256), 'Source tarball has no SHA-256')
  assert(Array.isArray(evidence.dependencies), 'Release dependencies are not an array')
  assert(Array.isArray(evidence.environments), 'Release environments are not an array')
  assert(Array.isArray(evidence.checks), 'Release checks are not an array')
  assert(
    evidence.requirements &&
      typeof evidence.requirements === 'object' &&
      !Array.isArray(evidence.requirements),
    'Requirement mappings are not an object',
  )
  assert(Array.isArray(evidence.artifacts), 'Release artifacts are not an array')
  assert(Array.isArray(evidence.liveResources), 'Release live resources are not an array')
  assert(Array.isArray(evidence.cleanup), 'Release cleanup is not an array')
  return { startedAt, finishedAt }
}

export function finiteNumber(value, label) {
  assert(typeof value === 'number' && Number.isFinite(value), `${label} is not a finite number`)
}

export function safeIdentifier(value, label) {
  assert(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 200 &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value),
    `${label} is not a safe identifier`,
  )
}

export function safeText(value, label, maxLength = 200) {
  const hasControlCharacter =
    typeof value === 'string' &&
    [...value].some((character) => {
      const code = character.codePointAt(0)
      return code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f))
    })
  assert(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= maxLength &&
      !hasControlCharacter,
    `${label} is not safe text`,
  )
}

export function validateMeasurements(measurements, label, requireDistribution = false) {
  assert(Array.isArray(measurements) && measurements.length > 0, `${label} has no measurements`)
  const names = new Set()
  let distributions = 0
  for (const measurement of measurements) {
    assert(
      measurement && typeof measurement === 'object' && !Array.isArray(measurement),
      `${label} has an invalid measurement`,
    )
    assert(
      typeof measurement.name === 'string' && measurement.name.length > 0,
      `${label} measurement has no name`,
    )
    assert(!names.has(measurement.name), `${label} repeats measurement ${measurement.name}`)
    names.add(measurement.name)
    if (measurement.kind === 'scalar') {
      assertExactKeys(
        measurement,
        ['kind', 'name', 'unit', 'value'],
        [],
        `${label} measurement ${measurement.name}`,
      )
      assert(
        typeof measurement.unit === 'string' && measurement.unit.length > 0,
        `${label} measurement ${measurement.name} has no unit`,
      )
      finiteNumber(measurement.value, `${label} measurement ${measurement.name}`)
      continue
    }
    if (measurement.kind === 'distribution') {
      assertExactKeys(
        measurement,
        ['kind', 'name', 'unit', 'n', 'minimum', 'median', 'p90', 'p95', 'p99', 'maximum'],
        [],
        `${label} measurement ${measurement.name}`,
      )
      assert(
        typeof measurement.unit === 'string' && measurement.unit.length > 0,
        `${label} measurement ${measurement.name} has no unit`,
      )
      assert(
        Number.isInteger(measurement.n) && measurement.n > 0,
        `${label} measurement ${measurement.name} has no sample count`,
      )
      for (const field of ['minimum', 'median', 'p90', 'p95', 'p99', 'maximum']) {
        finiteNumber(measurement[field], `${label} measurement ${measurement.name}.${field}`)
      }
      assert(
        measurement.minimum <= measurement.median &&
          measurement.median <= measurement.p90 &&
          measurement.p90 <= measurement.p95 &&
          measurement.p95 <= measurement.p99 &&
          measurement.p99 <= measurement.maximum,
        `${label} measurement ${measurement.name} distribution is not ordered`,
      )
      distributions += 1
      continue
    }
    if (measurement.kind === 'unavailable' || measurement.kind === 'uncaptured') {
      assertExactKeys(
        measurement,
        ['kind', 'name', 'reason'],
        [],
        `${label} measurement ${measurement.name}`,
      )
      assert(
        typeof measurement.reason === 'string' && measurement.reason.length > 0,
        `${label} measurement ${measurement.name} has no reason`,
      )
      continue
    }
    throw new Error(`${label} measurement ${measurement.name} has invalid kind`)
  }
  if (requireDistribution) {
    assert(distributions > 0, `${label} has no measured distribution`)
  }
}
