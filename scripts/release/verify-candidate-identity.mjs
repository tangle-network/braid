import { resolve } from 'node:path'

import { readCandidateIdentity } from './build-identity.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const repository = resolve(
  process.env.BRAID_RELEASE_CHECKOUT ?? new URL('../../', import.meta.url).pathname,
)
const artifactRootValue = process.env.BRAID_RELEASE_ARTIFACT_ROOT
const expectedCommit = process.env.BRAID_RELEASE_EXPECT_COMMIT
const expectedVersion = process.env.BRAID_RELEASE_EXPECT_VERSION
assert(artifactRootValue, 'BRAID_RELEASE_ARTIFACT_ROOT is required')
assert(
  /^[a-f0-9]{40}$/u.test(expectedCommit ?? ''),
  'BRAID_RELEASE_EXPECT_COMMIT must be a full SHA',
)
assert(expectedVersion, 'BRAID_RELEASE_EXPECT_VERSION is required')

const { identity, packageProof } = await readCandidateIdentity({
  repository,
  artifactRoot: artifactRootValue,
  expectedCommit,
  expectedVersion,
})

process.stdout.write(
  `${JSON.stringify(
    {
      schema: 'braid.candidate-identity.v1',
      version: identity.braidVersion,
      gitCommit: identity.gitCommit,
      treeSha256: identity.treeSha256,
      sourceDigest: packageProof.sourceDigest,
      tarballSha256: identity.tarballSha256,
      packageIntegrity: identity.packageIntegrity,
      packageFileManifestDigest: identity.packageFileManifestDigest,
      tarballPath: identity.tarballPath,
    },
    null,
    2,
  )}\n`,
)
