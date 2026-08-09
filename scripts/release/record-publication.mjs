import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import {
  createPublicationProof,
  publicationProofPath,
  readPackageProof,
} from './publication-proof.mjs'

const artifactRootValue = process.env.BRAID_RELEASE_ARTIFACT_ROOT
if (!artifactRootValue) throw new Error('BRAID_RELEASE_ARTIFACT_ROOT is required')
const artifactRoot = resolve(artifactRootValue)
const proof = await createPublicationProof({
  artifactRoot,
  packageProof: await readPackageProof(artifactRoot),
})
const outputPath = publicationProofPath(artifactRoot)
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(proof, null, 2)}\n`, {
  encoding: 'utf8',
  flag: 'wx',
  mode: 0o600,
})
process.stdout.write(
  `Recorded ${proof.candidate.length} candidate and ${proof.registry.length} registry package smokes.\n`,
)
