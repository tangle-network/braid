import { join } from 'node:path'

import { SHA512_INTEGRITY_PATTERN } from '../release-check-catalog.mjs'
import {
  assert,
  assertExactKeys,
  canonicalJson,
  validateReleaseInputEnvelope,
} from '../release-evidence.mjs'
import { readRegularFileNoFollow } from '../release-files.mjs'
import { validateVisualProof } from '../release-visual-proof.mjs'
import { readDependencyRecords } from './build-identity.mjs'
import { uniqueBy } from './verification-support.mjs'

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error })
  }
}

export function assertIsolatedCheckout({ options, git }) {
  assert(
    options.isolatedCheckout === '1',
    'Release verification requires BRAID_RELEASE_ISOLATED_CHECKOUT=1',
  )
  assert(
    options.workingDirectory === options.repository,
    'Release verification must run from its isolated checkout',
  )
  assert(git('rev-parse', '--is-inside-work-tree') === 'true', 'Release path is not a Git checkout')
  assert(
    git('status', '--porcelain=v1', '--untracked-files=all') === '',
    'Release checkout contains tracked or untracked source changes',
  )
}

export async function loadReleaseSource({ options, git }) {
  const packageProof = parseJson(
    await readRegularFileNoFollow(options.packageProofPath),
    'Package proof',
  )
  const visualProof = parseJson(
    await readRegularFileNoFollow(options.visualProofPath),
    'Visual proof',
  )
  await validateVisualProof({
    packageProof,
    visualProof,
    repository: options.repository,
    artifactRoot: options.artifactRoot,
  })
  const evidenceBytes = await readRegularFileNoFollow(options.checksPath).catch(() => {
    throw new Error(
      `Release evidence is incomplete: ${options.checksPath.replace(`${options.repository}/`, '')} is missing`,
    )
  })
  const evidence = parseJson(evidenceBytes, 'Release evidence')
  const releaseWindow = validateReleaseInputEnvelope(evidence)
  assert(evidence.braidVersion === packageProof.version, 'Release evidence version differs')
  const evidenceCommit = git('rev-parse', 'HEAD')
  assert(evidence.gitCommit === evidenceCommit, 'Release evidence commit differs')
  const sourceTree = git('rev-parse', 'HEAD^{tree}')
  assert(packageProof.gitCommit === evidence.gitCommit, 'Package proof source commit differs')
  assert(packageProof.treeSha256 === sourceTree, 'Package proof source tree differs')
  assert(evidence.sourceState.commit === evidence.gitCommit, 'Release source commit differs')
  assert(evidence.sourceState.treeSha256 === sourceTree, 'Release source tree differs')
  assert(evidence.sourceState.clean === true, 'Source state is not clean')
  assert(evidence.sourceState.commit === evidence.gitCommit, 'Source state commit differs')
  assert(
    evidence.sourceState.tarballSha256 === packageProof.sha256,
    'Source tarball digest differs',
  )

  const packageJson = parseJson(
    await readRegularFileNoFollow(join(options.repository, 'package.json')),
    'package.json',
  )
  assert(packageJson.version === evidence.braidVersion, 'package.json version differs')
  const dependencies = uniqueBy(evidence.dependencies, 'name', 'dependency')
  for (const dependency of dependencies.values()) {
    assertExactKeys(
      dependency,
      ['name', 'version', 'integrity'],
      [],
      `Dependency ${dependency.name}`,
    )
    assert(
      typeof dependency.version === 'string' && dependency.version.length > 0,
      `Dependency ${dependency.name} has no version`,
    )
    assert(
      SHA512_INTEGRITY_PATTERN.test(dependency.integrity),
      `Dependency ${dependency.name} has invalid integrity`,
    )
  }
  const expectedDependencies = await readDependencyRecords({
    repository: options.repository,
    packageJson,
  })
  assert(
    canonicalJson(expectedDependencies) === canonicalJson(evidence.dependencies),
    'Release dependency inventory differs from package.json and pnpm-lock.yaml',
  )
  for (const [name, version] of Object.entries(packageJson.dependencies ?? {})) {
    const dependency = dependencies.get(name)
    assert(dependency, `Runtime dependency ${name} is absent from release evidence`)
    assert(dependency.version === version, `Runtime dependency ${name} version differs`)
  }

  return {
    packageProof,
    visualProof,
    evidence,
    releaseWindow,
    sourceTree,
    packageJson,
    dependencies,
  }
}
