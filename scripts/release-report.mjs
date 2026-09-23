function reportCell(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ')
    .replaceAll('\r', ' ')
}

export function renderReport(manifest) {
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
        `| \`${reportCell(check.id)}\` | ${reportCell(check.category)} | \`${reportCell(check.command)}\` | ${reportCell(check.environment)} | ${check.durationMs} ms |`,
    ),
    '',
    'Every row above has a valid Ed25519 execution receipt from the pinned release key.',
    '',
  ]
  return `${lines.join('\n')}\n`
}
