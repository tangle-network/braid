import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { compareCanonicalKeys } from '../release-evidence.mjs'
import { containedOutputPath, writeExclusiveAtomic } from '../release-files.mjs'

export function renderVerificationReport(manifest) {
  const passedChecks = manifest.checks.filter((check) => check.result === 'passed').length
  const failedChecks = manifest.checks.filter((check) => check.result === 'failed').length
  const unavailableChecks = manifest.checks.filter((check) => check.result === 'unavailable').length
  const uncapturedChecks = manifest.checks.filter((check) => check.result === 'uncaptured').length
  const classifiedChecks = passedChecks + failedChecks + unavailableChecks + uncapturedChecks
  const otherChecks = manifest.checks.length - classifiedChecks
  const checkSummary = [
    `${passedChecks}/${manifest.checks.length} passed`,
    ...(failedChecks > 0 ? [`${failedChecks} failed`] : []),
    ...(unavailableChecks > 0 ? [`${unavailableChecks} unavailable`] : []),
    ...(uncapturedChecks > 0 ? [`${uncapturedChecks} uncaptured`] : []),
    ...(otherChecks > 0 ? [`${otherChecks} unrecognized`] : []),
  ].join('; ')
  const checksById = new Map(manifest.checks.map((check) => [check.id, check]))
  const artifactIds = new Set(manifest.artifacts.map((artifact) => artifact.id))
  const requirementEntries = Object.values(manifest.requirements)
  const passedRequirements = requirementEntries.filter(
    (binding) =>
      Array.isArray(binding?.checks) &&
      binding.checks.length > 0 &&
      binding.checks.every((id) => checksById.get(id)?.result === 'passed') &&
      Array.isArray(binding?.artifacts) &&
      binding.artifacts.length > 0 &&
      binding.artifacts.every((id) => artifactIds.has(id)),
  ).length
  const lines = [
    `# Braid ${manifest.braidVersion} release evidence`,
    '',
    `Commit: \`${manifest.gitCommit}\``,
    '',
    `Package integrity: \`${manifest.packageIntegrity}\``,
    '',
    `Checks: ${checkSummary}.`,
    '',
    `Requirements: ${passedRequirements}/${requirementEntries.length} backed by passed checks and present artifacts.`,
    '',
    `Artifacts: ${manifest.artifacts.length}.`,
    '',
    '## Checks',
    '',
    '| ID | Result | Category | Command | Environment | Duration |',
    '| --- | --- | --- | --- | --- | ---: |',
    ...manifest.checks.map(
      (check) =>
        `| \`${check.id}\` | ${check.result} | ${check.category} | \`${check.command}\` | ${check.environment} | ${check.durationMs} ms |`,
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
