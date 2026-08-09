import { createPublicKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { validateIndependentReview } from './independent-review.mjs'

const artifactRootValue = process.env.BRAID_RELEASE_ARTIFACT_ROOT
if (!artifactRootValue) throw new Error('BRAID_RELEASE_ARTIFACT_ROOT is required')
const repository = resolve(new URL('../../', import.meta.url).pathname)
const artifactRoot = resolve(artifactRootValue)
const [attestation, packageProof, reviewKey, releaseKey] = await Promise.all([
  readFile(join(artifactRoot, 'review', 'attestation.json'), 'utf8').then(JSON.parse),
  readFile(join(artifactRoot, 'w6', 'package-proof.json'), 'utf8').then(JSON.parse),
  readFile(join(repository, 'release', 'review-execution-public-key.pem'), 'utf8').then(
    createPublicKey,
  ),
  readFile(join(repository, 'release', 'execution-public-key.pem'), 'utf8').then(createPublicKey),
])
if (
  reviewKey
    .export({ type: 'spki', format: 'der' })
    .equals(releaseKey.export({ type: 'spki', format: 'der' }))
)
  throw new Error('Independent review key must differ from the release execution key')
validateIndependentReview(attestation, { packageProof, publicKey: reviewKey })
process.stdout.write(
  `Independent review approved ${packageProof.gitCommit} / ${packageProof.sha256}.\n`,
)
process.stdout.write('BRAID_RELEASE_RESULT_JSON={"status":"passed"}\n')
