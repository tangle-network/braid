import { createHash } from 'node:crypto'
import { SHA256_PATTERN } from '../release-check-catalog.mjs'
import { assert, assertExactKeys, canonicalJson } from '../release-evidence.mjs'
import { readContainedFile, readRegularFileNoFollow } from '../release-files.mjs'
import {
  assertPackageFileManifestMatches,
  packageFileBytesFromTarball,
  packageFileManifestFromTarball,
} from './package-archive.mjs'
import { artifactPath, uniqueBy } from './verification-support.mjs'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function sha512Integrity(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

export async function validateReleaseArtifacts({
  evidence,
  repository,
  packageProof,
  packageJson,
}) {
  const artifacts = uniqueBy(evidence.artifacts, 'id', 'artifact')
  for (const artifact of artifacts.values()) {
    assertExactKeys(artifact, ['id', 'path', 'sha256', 'mediaType'], [], `Artifact ${artifact.id}`)
    assert(SHA256_PATTERN.test(artifact.sha256), `Artifact ${artifact.id} has invalid SHA-256`)
    assert(
      typeof artifact.mediaType === 'string' && artifact.mediaType.length > 0,
      `Artifact ${artifact.id} has no media type`,
    )
    const bytes = await readContainedFile(repository, artifact.path)
    assert(sha256(bytes) === artifact.sha256, `Artifact ${artifact.id} digest changed`)
  }

  const tarballArtifact = artifacts.get(evidence.sourceState.tarballArtifactId)
  assert(tarballArtifact, 'Source state names an unknown tarball artifact')
  assert(tarballArtifact.sha256 === packageProof.sha256, 'Tarball artifact digest differs')
  const tarballBytes = await readRegularFileNoFollow(artifactPath(repository, tarballArtifact.path))
  assert(
    sha512Integrity(tarballBytes) === evidence.packageIntegrity,
    'Tarball artifact integrity differs',
  )
  assert(packageProof.packageFileManifest, 'Package proof has no immutable package file manifest')
  const actualPackageFileManifest = packageFileManifestFromTarball(tarballBytes)
  const packageFileManifest = assertPackageFileManifestMatches(
    packageProof.packageFileManifest,
    actualPackageFileManifest,
  )
  assert(
    packageFileManifest.digest === packageProof.packageFileManifest.digest,
    'Package proof package file manifest digest differs',
  )
  const packedPackageJson = JSON.parse(
    packageFileBytesFromTarball(tarballBytes, 'package/package.json').toString('utf8'),
  )
  assert(
    canonicalJson(packedPackageJson) === canonicalJson(packageJson),
    'Packed package.json differs from HEAD',
  )
  return {
    artifacts,
    tarballArtifact,
    tarballBytes,
    packageFileManifest,
    packageFileManifestDigest: packageFileManifest.digest,
  }
}
