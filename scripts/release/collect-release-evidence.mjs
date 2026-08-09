import { createPrivateKey, createPublicKey } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { collectReleaseEvidence } from './collector.mjs'

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const repository = resolve(
  option('--repository') ??
    process.env.BRAID_RELEASE_CHECKOUT ??
    new URL('../', import.meta.url).pathname,
)
const tarballPath = option('--tarball')
const packageProofPath = option('--package-proof') ?? 'artifacts/verification/w6/package-proof.json'
const requirementBindingsPath = option('--requirements')
const privateKeyPath = option('--signing-key') ?? process.env.BRAID_RELEASE_SIGNING_KEY_PATH
const publicKeyPath =
  option('--public-key') ?? resolve(repository, 'release/execution-public-key.pem')
if (!tarballPath || !requirementBindingsPath || !privateKeyPath) {
  throw new Error('--tarball, --requirements, and --signing-key are required')
}
const privateInfo = await lstat(privateKeyPath)
if (!privateInfo.isFile() || privateInfo.isSymbolicLink() || (privateInfo.mode & 0o077) !== 0)
  throw new Error('Release signing key must be a non-symlink owner-only file')
const signingKey = createPrivateKey(await readFile(privateKeyPath, 'utf8'))
const publicKey = createPublicKey(await readFile(publicKeyPath, 'utf8'))
const requirementBindings = JSON.parse(
  await readFile(resolve(repository, requirementBindingsPath), 'utf8'),
)
const result = await collectReleaseEvidence({
  repository,
  tarballPath: resolve(repository, tarballPath),
  packageProofPath,
  requirementBindings,
  signingKey,
  publicKey,
})
process.stdout.write(
  `Collected ${result.envelope.checks.length} release checks with result ${result.result}.\n`,
)
