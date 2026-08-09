import { releaseCheckEntry } from '../release-check-catalog.mjs'
import { canonicalJson } from '../release-evidence.mjs'
import { restoredCheckArtifacts } from './check-artifacts.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export function previousAttemptsFrom(envelopes) {
  const attempts = new Map()
  for (const envelope of envelopes) {
    for (const check of envelope.checks)
      attempts.set(check.id, Math.max(attempts.get(check.id) ?? 0, check.attempt))
  }
  return attempts
}

export function retryCommandsForEnvelope(envelope, selectedCheckIds) {
  const checks = new Map(envelope.checks.map((check) => [check.id, check]))
  const commands = new Set()
  for (const id of selectedCheckIds) {
    const command = releaseCheckEntry(id)?.command
    assert(command, `Unknown release check: ${id}`)
    const check = checks.get(id)
    if (check?.result !== 'passed') commands.add(command)
  }
  return commands
}

export function restorePassedChecks({
  envelope,
  commandsToRetry,
  checks,
  checkArtifacts,
  artifacts,
  environments,
}) {
  const sourceArtifacts = new Map(envelope.artifacts.map((artifact) => [artifact.id, artifact]))
  const sourceEnvironments = new Map(
    envelope.environments.map((environment) => [environment.id, environment]),
  )
  for (const check of envelope.checks) {
    if (check.result !== 'passed' || commandsToRetry.has(check.command)) continue
    const existing = checks.get(check.id)
    if (existing) {
      assert(
        canonicalJson(existing) === canonicalJson(check),
        `Restored passed check ${check.id} differs`,
      )
      continue
    }
    const generated = restoredCheckArtifacts(check, envelope.artifacts)
    const artifactIds = [check.stdout.artifactId, check.stderr.artifactId, ...generated]
    for (const id of artifactIds) {
      const artifact = sourceArtifacts.get(id)
      assert(artifact, `Restored passed check ${check.id} is missing artifact ${id}`)
      artifacts.set(id, artifact)
    }
    const environment = sourceEnvironments.get(check.environment)
    assert(environment, `Restored passed check ${check.id} is missing its environment`)
    environments.set(environment.id, environment)
    checks.set(check.id, check)
    checkArtifacts.set(check.id, generated)
  }
}
