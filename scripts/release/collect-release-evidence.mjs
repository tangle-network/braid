import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { collectReleaseEvidence } from './collector.mjs'

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const repository = resolve(
  option('--repository') ??
    process.env.BRAID_RELEASE_CHECKOUT ??
    new URL('../../', import.meta.url).pathname,
)
const artifactRootValue = option('--artifact-root') ?? process.env.BRAID_RELEASE_ARTIFACT_ROOT
const tarballPath = option('--tarball')
const packageProofPath = option('--package-proof') ?? 'w6/package-proof.json'
const requirementBindingsPath = option('--requirements') ?? 'release/requirement-bindings.json'
if (!artifactRootValue || !tarballPath)
  throw new Error('--artifact-root and --tarball are required')
const artifactRoot = resolve(artifactRootValue)
const requirementBindings = JSON.parse(
  await readFile(resolve(repository, requirementBindingsPath), 'utf8'),
)
const result = await collectReleaseEvidence({
  repository,
  artifactRoot,
  tarballPath: resolve(artifactRoot, tarballPath),
  packageProofPath,
  requirementBindings,
})
process.stdout.write(
  `Collected ${result.envelope.checks.length} release checks with result ${result.result}.\n`,
)
if (result.result !== 'passed') process.exitCode = 1
