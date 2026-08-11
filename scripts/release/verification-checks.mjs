import { createHash } from 'node:crypto'

import {
  CHECK_CATEGORIES,
  REQUIRED_CHECKS,
  releaseCheckEntry,
  SHA256_PATTERN,
} from '../release-check-catalog.mjs'
import {
  assert,
  assertExactKeys,
  canonicalJson,
  strictIsoTimestamp,
  validateMeasurements,
  validatePerformanceMatrix,
  validatePerformanceMeasurements,
} from '../release-evidence.mjs'
import { readContainedFile } from '../release-files.mjs'
import { evaluateLiveBridgeProof } from './live-bridge-proof.mjs'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function validateReleaseChecks({
  checks,
  artifacts,
  mappings,
  environments,
  allowedCheckIds,
  allowedCommands,
  packageProof,
  evidence,
  sourceTree,
  releaseWindow,
  dependencyDigest,
  packageFileManifestDigest,
  artifactRoot,
}) {
  const performanceMeasurements = []
  for (const [id, expected] of REQUIRED_CHECKS) {
    const check = checks.get(id)
    assert(check, `Required check ${id} is missing`)
    assert(
      check.category === expected.category,
      `Required check ${id} has category ${check.category}`,
    )
    assert(check.command === expected.command, `Required check ${id} has command ${check.command}`)
  }

  for (const check of checks.values()) {
    assertExactKeys(
      check,
      [
        'id',
        'category',
        'required',
        'command',
        'cwd',
        'environment',
        'startedAt',
        'completedAt',
        'durationMs',
        'attempt',
        'exitCode',
        'result',
        'buildSha256',
        'measurements',
        'stdout',
        'stderr',
        'failureDetails',
        'argv',
        'environmentSnapshot',
        'boundary',
        'binding',
        'logs',
      ],
      [],
      `Check ${check.id}`,
    )
    assert(allowedCheckIds.has(check.id), `Check ${check.id} is outside the closed check catalog`)
    const expectedCheck = releaseCheckEntry(check.id)
    assert(expectedCheck, `Check ${check.id} has no registered route`)
    assert(check.command === expectedCheck.command, `Check ${check.id} command differs from route`)
    assert(
      check.category === expectedCheck.category,
      `Check ${check.id} category differs from route`,
    )
    assert(CHECK_CATEGORIES.has(check.category), `Check ${check.id} has invalid category`)
    assert(allowedCommands.has(check.command), `Check ${check.id} uses an unregistered command`)
    assert(
      allowedCommands.get(check.command) === check.category,
      `Check ${check.id} command category differs`,
    )
    assert(check.result === 'passed', `Check ${check.id} did not pass`)
    assert(check.result !== 'unavailable', `Required check ${check.id} is unavailable`)
    assert(check.required === true, `Check ${check.id} is not marked required`)
    if (/^LIVE-0[1-5]$/u.test(check.id)) {
      let liveEvidence
      try {
        const liveEvidenceBytes = await readContainedFile(artifactRoot, 'live/bridge/evidence.json')
        const liveArtifactPrefix = `check-${check.id}-attempt-${check.attempt}-evidence-`
        const liveArtifact = [...artifacts.values()].find(
          (artifact) =>
            artifact.id.startsWith(liveArtifactPrefix) &&
            artifact.sha256 === sha256(liveEvidenceBytes),
        )
        assert(liveArtifact, `Check ${check.id} has no retained packed CLI Bridge evidence`)
        liveEvidence = JSON.parse(
          (await readContainedFile(artifactRoot, liveArtifact.path)).toString('utf8'),
        )
      } catch (error) {
        throw new Error(`Check ${check.id} packed CLI Bridge evidence is invalid`, { cause: error })
      }
      const liveProof = evaluateLiveBridgeProof(liveEvidence, check.id)
      assert(
        liveProof?.result === 'passed',
        liveProof?.reason ?? `Check ${check.id} has no exact live proof`,
      )
      assert(
        canonicalJson(check.measurements) === canonicalJson(liveProof.measurements),
        `Check ${check.id} measurement differs from its packed CLI Bridge proof`,
      )
    }
    assert(check.buildSha256 === packageProof.sha256, `Check ${check.id} used another build`)
    assert(typeof check.cwd === 'string' && check.cwd.length > 0, `Check ${check.id} has no cwd`)
    assert(Array.isArray(check.argv) && check.argv.length > 0, `Check ${check.id} has no argv`)
    assert(check.argv[0] === 'pnpm', `Check ${check.id} does not use pnpm argv`)
    assert(
      check.argv.every(
        (value) =>
          typeof value === 'string' &&
          !value.includes('\0') &&
          !value.includes('\n') &&
          !value.includes('\r'),
      ),
      `Check ${check.id} has unsafe argv`,
    )
    assertExactKeys(
      check.environmentSnapshot,
      ['variables', 'omittedCount'],
      [],
      `Check ${check.id} environment snapshot`,
    )
    assert(
      Array.isArray(check.environmentSnapshot.variables),
      `Check ${check.id} environment variables are not an array`,
    )
    const environmentNames = new Set()
    for (const variable of check.environmentSnapshot.variables) {
      assertExactKeys(
        variable,
        ['name', 'value', 'byteLength'],
        [],
        `Check ${check.id} environment variable`,
      )
      assert(
        typeof variable.name === 'string' && variable.name.length > 0,
        `Check ${check.id} environment variable has no name`,
      )
      assert(
        !environmentNames.has(variable.name),
        `Check ${check.id} repeats environment ${variable.name}`,
      )
      environmentNames.add(variable.name)
      assert(
        typeof variable.value === 'string',
        `Check ${check.id} environment variable ${variable.name} is not sanitized`,
      )
      assert(
        Number.isSafeInteger(variable.byteLength) && variable.byteLength >= 0,
        `Check ${check.id} environment variable ${variable.name} has invalid length`,
      )
      assert(
        !Object.hasOwn(variable, 'sha256'),
        `Check ${check.id} publishes an environment value digest`,
      )
      assert(
        !Object.hasOwn(variable, 'digest'),
        `Check ${check.id} publishes an environment value digest`,
      )
    }
    assertExactKeys(
      check.boundary,
      [
        'schemaVersion',
        'shell',
        'cwd',
        'processTreeStrategy',
        'cleanupConfirmed',
        'tarballSha256',
        'gitCommit',
        'dependencyDigest',
        'requirementIds',
      ],
      [],
      `Check ${check.id} boundary`,
    )
    assert(check.boundary.shell === false, `Check ${check.id} used a shell`)
    assert(check.boundary.cwd === check.cwd, `Check ${check.id} boundary cwd differs`)
    assert(
      check.boundary.tarballSha256 === packageProof.sha256,
      `Check ${check.id} boundary tarball differs`,
    )
    assert(
      check.boundary.gitCommit === evidence.gitCommit,
      `Check ${check.id} boundary commit differs`,
    )
    assert(
      check.boundary.dependencyDigest === dependencyDigest,
      `Check ${check.id} boundary dependency digest differs`,
    )
    assert(
      typeof check.boundary.processTreeStrategy === 'string',
      `Check ${check.id} has no process-tree strategy`,
    )
    assert(
      typeof check.boundary.cleanupConfirmed === 'boolean',
      `Check ${check.id} has no cleanup result`,
    )
    assertExactKeys(
      check.binding,
      [
        'schemaVersion',
        'tarballSha256',
        'gitCommit',
        'gitTree',
        'dependencyDigest',
        'packageFileManifestDigest',
        'dependencies',
        'requirementIds',
      ],
      [],
      `Check ${check.id} binding`,
    )
    assert(
      check.binding.tarballSha256 === packageProof.sha256,
      `Check ${check.id} binding tarball differs`,
    )
    assert(
      check.binding.gitCommit === evidence.gitCommit,
      `Check ${check.id} binding commit differs`,
    )
    assertExactKeys(check.binding.gitTree, ['algorithm', 'value'], [], `Check ${check.id} Git tree`)
    assert(
      check.binding.gitTree.algorithm === 'git-tree-object-sha1',
      `Check ${check.id} Git tree algorithm differs`,
    )
    assert(check.binding.gitTree.value === sourceTree, `Check ${check.id} binding tree differs`)
    assert(
      check.binding.dependencyDigest === dependencyDigest,
      `Check ${check.id} binding dependency digest differs`,
    )
    assert(
      check.binding.packageFileManifestDigest === packageFileManifestDigest,
      `Check ${check.id} binding package manifest digest differs`,
    )
    assert(
      canonicalJson(check.binding.dependencies) === canonicalJson(evidence.dependencies),
      `Check ${check.id} binding dependencies differ`,
    )
    const expectedRequirementIds = [...mappings.entries()]
      .filter(([, mapping]) => Array.isArray(mapping.checks) && mapping.checks.includes(check.id))
      .map(([requirement]) => requirement)
      .sort()
    assert(
      canonicalJson(check.binding.requirementIds) === canonicalJson(expectedRequirementIds),
      `Check ${check.id} binding requirements differ`,
    )
    assert(
      canonicalJson(check.boundary.requirementIds) === canonicalJson(expectedRequirementIds),
      `Check ${check.id} boundary requirements differ`,
    )
    assertExactKeys(check.logs, ['stdout', 'stderr'], [], `Check ${check.id} logs`)
    for (const field of ['stdout', 'stderr']) {
      assertExactKeys(
        check.logs[field],
        [
          'rawByteLength',
          'redactedSha256',
          'redactedByteLength',
          'redactedTruncated',
          'redactionFailClosed',
        ],
        [],
        `Check ${check.id} ${field} log`,
      )
      assert(
        SHA256_PATTERN.test(check.logs[field].redactedSha256),
        `Check ${check.id} ${field} redacted digest is invalid`,
      )
      assert(
        Number.isSafeInteger(check.logs[field].rawByteLength) &&
          check.logs[field].rawByteLength >= 0,
        `Check ${check.id} ${field} raw length is invalid`,
      )
      assert(
        Number.isSafeInteger(check.logs[field].redactedByteLength) &&
          check.logs[field].redactedByteLength >= 0,
        `Check ${check.id} ${field} redacted length is invalid`,
      )
      assert(
        typeof check.logs[field].redactedTruncated === 'boolean',
        `Check ${check.id} ${field} truncation is invalid`,
      )
      assert(
        check.logs[field].redactionFailClosed === false,
        `Check ${check.id} ${field} redaction failed closed`,
      )
    }
    assert(
      environments.has(check.environment),
      `Check ${check.id} names unknown environment ${check.environment}`,
    )
    const startedAt = strictIsoTimestamp(check.startedAt, `Check ${check.id} start`)
    const completedAt = strictIsoTimestamp(check.completedAt, `Check ${check.id} completion`)
    assert(startedAt >= releaseWindow.startedAt, `Check ${check.id} started before the release`)
    assert(completedAt <= releaseWindow.finishedAt, `Check ${check.id} ended after the release`)
    assert(completedAt >= startedAt, `Check ${check.id} completed before it started`)
    assert(
      check.durationMs === completedAt - startedAt,
      `Check ${check.id} duration differs from its timestamps`,
    )
    assert(check.exitCode === 0, `Check ${check.id} has a nonzero exit code`)
    assert(Number.isInteger(check.attempt) && check.attempt > 0, `Check ${check.id} has no attempt`)
    if (check.category === 'performance') {
      if (check.id === 'performance')
        validatePerformanceMatrix(check.measurements, `Check ${check.id}`)
      else {
        validatePerformanceMeasurements(check.measurements, `Check ${check.id}`)
        assert(
          check.measurements.length === 1 && check.measurements[0].name === check.id,
          `Check ${check.id} must contain only its matching performance measurement`,
        )
        performanceMeasurements.push(...check.measurements)
      }
    } else validateMeasurements(check.measurements, `Check ${check.id}`)
    assert(
      check.measurements.every(
        (measurement) => measurement.kind !== 'unavailable' && measurement.kind !== 'uncaptured',
      ),
      `Required check ${check.id} contains unavailable measurements`,
    )
    assert(check.failureDetails === null, `Passed check ${check.id} has failure details`)
    for (const field of ['stdout', 'stderr']) {
      const output = check[field]
      assertExactKeys(output, ['artifactId', 'sha256'], [], `Check ${check.id} ${field}`)
      assert(SHA256_PATTERN.test(output.sha256), `Check ${check.id} has invalid ${field} SHA-256`)
      const artifact = artifacts.get(output.artifactId)
      assert(artifact, `Check ${check.id} names unknown ${field} artifact ${output.artifactId}`)
      assert(artifact.sha256 === output.sha256, `Check ${check.id} ${field} digest differs`)
      assert(
        artifact.sha256 === check.logs[field].redactedSha256,
        `Check ${check.id} ${field} log digest differs`,
      )
    }
  }
  return performanceMeasurements
}
