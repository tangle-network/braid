import { createPublicKey, verify } from 'node:crypto'

import { assert, assertExactKeys, canonicalJson, strictIsoTimestamp } from '../release-evidence.mjs'

const HEX_40 = /^[a-f0-9]{40}$/u
const HEX_64 = /^[a-f0-9]{64}$/u

function unsignedAttestation(attestation) {
  const { signature: _signature, ...unsigned } = attestation
  return unsigned
}

export function validateIndependentReview(attestation, { packageProof, publicKey }) {
  assertExactKeys(
    attestation,
    [
      'schema',
      'reviewer',
      'candidate',
      'verdict',
      'reviewedAt',
      'threatFixturesReproduced',
      'architectureOwnershipConfirmed',
      'findings',
      'signature',
    ],
    [],
    'Independent review attestation',
  )
  assert(attestation.schema === 'braid.independent-review.v1', 'Independent review schema differs')
  assertExactKeys(attestation.reviewer, ['id', 'system'], [], 'Independent reviewer')
  assert(
    typeof attestation.reviewer.id === 'string' && attestation.reviewer.id.length > 0,
    'Independent reviewer id is missing',
  )
  assert(
    typeof attestation.reviewer.system === 'string' && attestation.reviewer.system.length > 0,
    'Independent review system is missing',
  )
  assertExactKeys(
    attestation.candidate,
    ['gitCommit', 'tarballSha256', 'packageFileManifestDigest'],
    [],
    'Independent review candidate',
  )
  assert(HEX_40.test(attestation.candidate.gitCommit), 'Independent review commit is invalid')
  assert(
    HEX_64.test(attestation.candidate.tarballSha256),
    'Independent review archive digest is invalid',
  )
  assert(
    HEX_64.test(attestation.candidate.packageFileManifestDigest),
    'Independent review package manifest digest is invalid',
  )
  assert(
    attestation.candidate.gitCommit === packageProof.gitCommit,
    'Independent review commit differs',
  )
  assert(
    attestation.candidate.tarballSha256 === packageProof.sha256,
    'Independent review archive differs',
  )
  assert(
    attestation.candidate.packageFileManifestDigest === packageProof.packageFileManifest?.digest,
    'Independent review package manifest differs',
  )
  assert(attestation.verdict === 'approved', 'Independent review did not approve the candidate')
  strictIsoTimestamp(attestation.reviewedAt, 'Independent review time')
  assert(
    attestation.threatFixturesReproduced === true,
    'Independent review did not reproduce threats',
  )
  assert(
    attestation.architectureOwnershipConfirmed === true,
    'Independent review did not confirm application and execution ownership',
  )
  assert(Array.isArray(attestation.findings), 'Independent review findings are not an array')
  for (const [index, finding] of attestation.findings.entries()) {
    assertExactKeys(finding, ['severity', 'summary', 'disposition'], [], `Review finding ${index}`)
    assert(
      ['low', 'informational'].includes(finding.severity),
      `Review finding ${index} is release-blocking`,
    )
    assert(
      typeof finding.summary === 'string' && finding.summary.length > 0,
      `Review finding ${index} has no summary`,
    )
    assert(
      typeof finding.disposition === 'string' && finding.disposition.length > 0,
      `Review finding ${index} has no disposition`,
    )
  }
  assertExactKeys(attestation.signature, ['algorithm', 'value'], [], 'Independent review signature')
  assert(
    attestation.signature.algorithm === 'ed25519',
    'Independent review signature algorithm differs',
  )
  const key = publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey)
  assert(key.asymmetricKeyType === 'ed25519', 'Independent review key must be Ed25519')
  const valid = verify(
    null,
    Buffer.from(canonicalJson(unsignedAttestation(attestation))),
    key,
    Buffer.from(attestation.signature.value, 'base64'),
  )
  assert(valid, 'Independent review signature is invalid')
  return unsignedAttestation(attestation)
}
