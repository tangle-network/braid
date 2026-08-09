import { isAbsolute, join, relative, resolve, sep } from 'node:path'

function inside(root, target) {
  const path = relative(root, target)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

export function readVerificationOptions(
  environment = process.env,
  workingDirectory = process.cwd(),
) {
  const repository = resolve(
    environment.BRAID_RELEASE_CHECKOUT ?? new URL('../../', import.meta.url).pathname,
  )
  if (!environment.BRAID_RELEASE_ARTIFACT_ROOT)
    throw new Error('BRAID_RELEASE_ARTIFACT_ROOT is required')
  const artifactRoot = resolve(environment.BRAID_RELEASE_ARTIFACT_ROOT)
  if (artifactRoot === repository || inside(repository, artifactRoot))
    throw new Error('BRAID_RELEASE_ARTIFACT_ROOT must be outside the release checkout')
  const releaseInputRoot = join(artifactRoot, 'release')
  return {
    repository,
    workingDirectory: resolve(workingDirectory),
    docsRoot: join(repository, 'docs'),
    artifactRoot,
    checksPath: join(releaseInputRoot, 'checks.json'),
    packageProofPath: join(artifactRoot, 'w6', 'package-proof.json'),
    visualProofPath: join(artifactRoot, 'w6', 'capture-manifest.json'),
    publicKeyPath: join(repository, 'release', 'execution-public-key.pem'),
    publicKeyFingerprintPath: join(repository, 'release', 'execution-public-key.fingerprint'),
    isolatedCheckout: environment.BRAID_RELEASE_ISOLATED_CHECKOUT,
    signingKeyPath: environment.BRAID_RELEASE_SIGNING_KEY_PATH,
  }
}
