import { lstat, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  assert,
  compareCanonicalKeys,
  signManifest,
  verifyManifestSignature,
} from '../release-evidence.mjs'
import {
  containedOutputPath,
  readRegularFileNoFollow,
  writeExclusiveAtomic,
} from '../release-files.mjs'

export function renderVerificationReport(manifest) {
  const lines = [
    `# Braid ${manifest.braidVersion} release evidence`,
    '',
    `Commit: \`${manifest.gitCommit}\``,
    '',
    `Package integrity: \`${manifest.packageIntegrity}\``,
    '',
    `Checks: ${manifest.checks.length}/${manifest.checks.length} passed.`,
    '',
    `Requirements: ${Object.keys(manifest.requirements).length}/${Object.keys(manifest.requirements).length} linked.`,
    '',
    `Artifacts: ${manifest.artifacts.length}.`,
    '',
    '## Checks',
    '',
    '| ID | Category | Command | Environment | Duration |',
    '| --- | --- | --- | --- | ---: |',
    ...manifest.checks.map(
      (check) =>
        `| \`${check.id}\` | ${check.category} | \`${check.command}\` | ${check.environment} | ${check.durationMs} ms |`,
    ),
    '',
    'Every row above has a valid Ed25519 execution receipt from the pinned release key.',
    '',
  ]
  return `${lines.join('\n')}\n`
}

export async function writeVerificationOutputs({
  options,
  evidence,
  specificationDigests,
  publicKey,
}) {
  assert(
    options.signingKeyPath,
    'BRAID_RELEASE_SIGNING_KEY_PATH is required to sign the release manifest',
  )
  const signingKeyInfo = await lstat(options.signingKeyPath)
  assert(signingKeyInfo.isFile(), 'Release signing key is not a file')
  assert(!signingKeyInfo.isSymbolicLink(), 'Release signing key may not be a symlink')
  assert(
    (signingKeyInfo.mode & 0o077) === 0,
    'Release signing key permissions are broader than 0600',
  )
  assert(
    !resolve(options.signingKeyPath).startsWith(`${options.repository}/`),
    'Release signing key must be outside checkout',
  )
  const signingKey = (await readRegularFileNoFollow(options.signingKeyPath)).toString('utf8')
  const unsignedManifest = {
    ...evidence,
    sourceState: {
      ...evidence.sourceState,
      specificationDigests: specificationDigests.sort((left, right) =>
        compareCanonicalKeys(left.path, right.path),
      ),
    },
  }
  const manifest = signManifest(unsignedManifest, signingKey)
  verifyManifestSignature(manifest, publicKey)
  const outputRoot = await containedOutputPath(
    options.repository,
    join('artifacts', 'verification', evidence.braidVersion),
  )
  const outputPath = join(outputRoot, 'manifest.json')
  const reportPath = join(outputRoot, 'report.md')
  await mkdir(outputRoot, { recursive: true })
  await writeExclusiveAtomic(outputPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await writeExclusiveAtomic(reportPath, renderVerificationReport(manifest))
  return { manifest, outputPath, reportPath }
}
