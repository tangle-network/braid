import { join, resolve } from 'node:path'

export function readVerificationOptions(
  environment = process.env,
  workingDirectory = process.cwd(),
) {
  const repository = resolve(
    environment.BRAID_RELEASE_CHECKOUT ?? new URL('../../', import.meta.url).pathname,
  )
  const artifactRoot = join(repository, 'artifacts', 'verification')
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
