import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { compareCanonicalKeys } from '../release-evidence.mjs'
import { containedOutputPath, writeExclusiveAtomic } from '../release-files.mjs'

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
    'The release archive contains these records and is endorsed only after validation.',
    '',
  ]
  return `${lines.join('\n')}\n`
}

export async function writeVerificationOutputs({ options, evidence, specificationDigests }) {
  const manifest = {
    ...evidence,
    sourceState: {
      ...evidence.sourceState,
      specificationDigests: specificationDigests.sort((left, right) =>
        compareCanonicalKeys(left.path, right.path),
      ),
    },
  }
  const outputRoot = await containedOutputPath(options.artifactRoot, evidence.braidVersion)
  const outputPath = join(outputRoot, 'manifest.json')
  const reportPath = join(outputRoot, 'report.md')
  await mkdir(outputRoot, { recursive: true })
  await writeExclusiveAtomic(outputPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await writeExclusiveAtomic(reportPath, renderVerificationReport(manifest))
  return { manifest, outputPath, reportPath }
}
