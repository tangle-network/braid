import { createHash } from 'node:crypto'
import { join, relative, resolve } from 'node:path'

import { releaseCheckEntry, requiredEvidenceCheckIds } from '../release-check-catalog.mjs'
import { canonicalJson } from '../release-evidence.mjs'
import { readRegularFileNoFollow } from '../release-files.mjs'
import { createArtifactStore } from './artifact-store.mjs'
import { cleanTemporaryFiles, readJson, writeJsonAtomic } from './atomic-storage.mjs'
import {
  materializeRequirementBindings,
  normalizeRequirementCheckBindings,
  requirementsObject,
  selectRequirementCheckBindings,
} from './bindings.mjs'
import { readBuildIdentity, readRequirementIds } from './build-identity.mjs'
import { registerCheckArtifacts } from './check-artifacts.mjs'
import { releaseChildEnvironment } from './child-environment.mjs'
import { boundaryForCheck, buildCheckRecord, environmentRecord } from './collection-contract.mjs'
import {
  previousAttemptsFrom,
  restorePassedChecks,
  retryCommandsForEnvelope,
} from './collector-resume.mjs'
import {
  CHECKPOINT_SCHEMA,
  COLLECTION_MANIFEST_SCHEMA,
  checkpointBuild,
  checkpointPlan,
  requirementIdsForPlan,
  validateCheckpoint,
} from './collector-validation.mjs'
import {
  collectCredentialSecrets,
  collectRedactionSecrets,
  executeCatalogCheck,
  sanitizeArgv,
  sanitizeEnvironment,
} from './command-runner.mjs'
import { readLiveBridgeProof } from './live-bridge-proof.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function timestamp(milliseconds) {
  return new Date(Math.trunc(milliseconds)).toISOString()
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function optionalJson(path) {
  try {
    return await readJson(path, readRegularFileNoFollow)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

function selectedChecks(checkIds, requirementIds) {
  const ids = checkIds ? [...checkIds] : requiredEvidenceCheckIds(requirementIds)
  assert(ids.length > 0, 'At least one release check is required')
  assert(new Set(ids).size === ids.length, 'Release check identifiers are duplicated')
  for (const id of ids) assert(releaseCheckEntry(id), `Unknown release check: ${id}`)
  return ids
}

function artifactId(checkId, attempt, stream, bytes) {
  return `check-${checkId.replaceAll('/', '_')}-attempt-${attempt}-${sha256(bytes)}-${stream}`
}

function artifactMap(artifacts) {
  return new Map(artifacts.map((artifact) => [artifact.id, artifact]))
}

function stateEnvelope({
  identity,
  startedAt,
  finishedAt,
  checks,
  environments,
  artifacts,
  checkArtifacts,
  requirementBindings,
}) {
  const artifactsByCheck = new Map(
    [...checks.values()].map((check) => [
      check.id,
      [check.stdout.artifactId, check.stderr.artifactId, ...(checkArtifacts.get(check.id) ?? [])],
    ]),
  )
  const requirements = materializeRequirementBindings(requirementBindings, {
    artifactsByCheck,
    additionalArtifacts: ['package-tarball', 'package-proof'],
  })
  return {
    schemaVersion: 1,
    braidVersion: identity.braidVersion,
    gitCommit: identity.gitCommit,
    packageIntegrity: identity.packageIntegrity,
    startedAt,
    finishedAt,
    sourceState: {
      clean: identity.clean,
      commit: identity.gitCommit,
      treeSha256: identity.treeSha256,
      tarballSha256: identity.tarballSha256,
      tarballArtifactId: 'package-tarball',
    },
    dependencies: identity.dependencies,
    environments: [...environments.values()].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    ),
    checks: [...checks.values()].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    ),
    requirements: requirementsObject(requirements),
    artifacts: [...artifacts.values()].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    ),
    liveResources: [],
    cleanup: [],
    signatures: [],
  }
}

function checkpoint({ identity, plan, envelope }) {
  return { schema: CHECKPOINT_SCHEMA, build: checkpointBuild(identity), plan, envelope }
}

async function writeCheckpoint(path, value, options = {}) {
  await writeJsonAtomic(path, value, options)
}

async function preserveCollectionManifest(path, manifest) {
  const existing = await optionalJson(path)
  if (existing) {
    if (existing.result === 'passed') {
      assert(
        canonicalJson(existing) === canonicalJson(manifest),
        'Existing passed collection manifest differs',
      )
      return existing
    }
  }
  await writeJsonAtomic(path, manifest)
  return manifest
}

export async function collectReleaseEvidence({
  repository,
  artifactRoot,
  tarballPath,
  packageProofPath,
  packageProof,
  requirementBindings,
  checkIds,
  environment = process.env,
  redactionSecrets = [],
  timeoutMs,
  maxLogBytes,
  partialPath,
  checksPath,
  manifestPath,
  now = () => Date.now(),
  runCheck = executeCatalogCheck,
  writeOptions,
} = {}) {
  const root = resolve(repository)
  assert(
    typeof artifactRoot === 'string' && artifactRoot.length > 0,
    'Release artifact root is required',
  )
  const evidenceRoot = resolve(artifactRoot)
  assert(
    typeof tarballPath === 'string' && tarballPath.length > 0,
    'Packed tarball path is required',
  )
  assert(requirementBindings, 'Requirement check bindings are required')
  const identity = await readBuildIdentity({
    repository: root,
    artifactRoot: evidenceRoot,
    tarballPath,
    packageProofPath,
    packageProof,
  })
  const documentedRequirementIds = await readRequirementIds(root)
  assert(
    canonicalJson(documentedRequirementIds) === canonicalJson(identity.requirementIds),
    'Build identity requirement list differs from docs',
  )
  const selected = selectedChecks(checkIds, identity.requirementIds)
  const knownCheckIds = [
    ...new Set([...requiredEvidenceCheckIds(identity.requirementIds), ...selected]),
  ]
  const allCheckBindings = normalizeRequirementCheckBindings(
    requirementBindings,
    identity.requirementIds,
    knownCheckIds,
  )
  const checkBindings = selectRequirementCheckBindings(allCheckBindings, selected)
  for (const id of selected)
    assert(
      requirementIdsForPlan({ requirements: Object.fromEntries(checkBindings) }, id).length > 0,
      `Release check ${id} has no requirement binding`,
    )
  const plan = checkpointPlan({
    checkIds: selected,
    requirementBindings: checkBindings,
  })
  const outputRoot = join(evidenceRoot, 'release')
  const paths = {
    partial: partialPath ?? join(outputRoot, 'checks.partial.json'),
    checks: checksPath ?? join(outputRoot, 'checks.json'),
    manifest: manifestPath ?? join(outputRoot, 'collection-manifest.json'),
  }
  await cleanTemporaryFiles(outputRoot)
  const store = createArtifactStore({ artifactRoot: evidenceRoot })
  const tarballArtifact = await store.register({
    id: 'package-tarball',
    path: identity.tarballPath,
    mediaType: 'application/gzip',
  })
  const packageProofArtifact = packageProofPath
    ? await store.register({
        id: 'package-proof',
        path: relative(evidenceRoot, resolve(evidenceRoot, packageProofPath)),
        mediaType: 'application/json',
      })
    : await store.put({
        id: 'package-proof',
        bytes: Buffer.from(`${JSON.stringify(packageProof, null, 2)}\n`),
        mediaType: 'application/json',
        extension: '.json',
      })
  const artifacts = artifactMap([tarballArtifact, packageProofArtifact])
  const checks = new Map()
  const checkArtifacts = new Map()
  const environments = new Map()
  const partial = await optionalJson(paths.partial)
  const finalInput = await optionalJson(paths.checks)
  let startedAt = timestamp(now())
  let checkpointFinishedAt
  if (partial) {
    await validateCheckpoint(partial, {
      artifactRoot: evidenceRoot,
      identity,
      plan,
    })
  }
  if (finalInput) {
    const finalCheckpoint = checkpoint({ identity, plan, envelope: finalInput })
    await validateCheckpoint(finalCheckpoint, {
      artifactRoot: evidenceRoot,
      identity,
      plan,
    })
    if (partial)
      assert(
        partial.envelope.startedAt === finalInput.startedAt,
        'Partial and final release evidence start times differ',
      )
  }
  const savedEnvelopes = [partial?.envelope, finalInput].filter(
    (envelope) => envelope !== undefined,
  )
  const previousAttempts = previousAttemptsFrom(savedEnvelopes)
  const resumeEnvelope = partial?.envelope ?? finalInput
  if (resumeEnvelope) {
    startedAt = resumeEnvelope.startedAt
    checkpointFinishedAt = resumeEnvelope.finishedAt
    restorePassedChecks({
      envelope: resumeEnvelope,
      commandsToRetry: retryCommandsForEnvelope(resumeEnvelope, selected),
      checks,
      checkArtifacts,
      artifacts,
      environments,
    })
  }
  let executedCheck = false
  const executions = new Map()
  const checkEnvironment = {
    ...environment,
    BRAID_RELEASE_ARTIFACT_ROOT: evidenceRoot,
    BRAID_RELEASE_TARBALL: resolve(evidenceRoot, identity.tarballPath),
    BRAID_EVAL_OUTPUT_DIR: join(evidenceRoot, 'eval'),
    BRAID_LIVE_ANALYSIS_EVIDENCE: join(evidenceRoot, 'live', 'analysis', 'evidence.json'),
    BRAID_LIVE_BRIDGE_EVIDENCE: join(evidenceRoot, 'live', 'bridge', 'evidence.json'),
    BRAID_LIVE_SUPERVISOR_EVIDENCE: join(evidenceRoot, 'live', 'supervisor', 'evidence.json'),
    BRAID_LIVE_TANGLE_EVIDENCE: join(evidenceRoot, 'live', 'tangle', 'evidence.json'),
    BRAID_PERFORMANCE_OUTPUT_DIR: join(evidenceRoot, 'performance'),
  }
  for (const checkId of selected) {
    if (checks.has(checkId)) continue
    const entry = releaseCheckEntry(checkId)
    const requirementIds = requirementIdsForPlan(plan, checkId)
    const commandEnvironment = releaseChildEnvironment(checkEnvironment, entry.command)
    let result = executions.get(entry.command)
    if (!result) {
      executedCheck = true
      result = await runCheck({
        checkId,
        cwd: root,
        environment: commandEnvironment,
        timeoutMs,
        maxLogBytes,
        redactionSecrets,
      })
      assert(result.checkId === checkId, `Runner returned another check: ${result.checkId}`)
      executions.set(entry.command, result)
    } else result = { ...result, checkId, category: entry.category, command: entry.command }
    assert(
      result.command === entry.command && result.category === entry.category,
      `Runner drifted from catalog for ${checkId}`,
    )
    const secrets = collectRedactionSecrets(commandEnvironment, redactionSecrets)
    const sanitizedArgv = result.sanitizedArgv ?? sanitizeArgv(result.argv, secrets)
    const sanitizedEnvironment =
      result.sanitizedEnvironment ?? sanitizeEnvironment(commandEnvironment)
    const boundary = boundaryForCheck({
      cwd: root,
      processResult: result,
      identity,
      requirementIds,
    })
    const environmentValue = environmentRecord({
      cwd: root,
      argv: sanitizedArgv,
      environment: sanitizedEnvironment,
      boundary,
    })
    environments.set(environmentValue.id, environmentValue)
    const attempt = (previousAttempts.get(checkId) ?? 0) + 1
    previousAttempts.set(checkId, attempt)
    const structuredEvidenceOverride = await readLiveBridgeProof({
      artifactRoot: evidenceRoot,
      checkId,
      processResult: result,
    })
    const record = buildCheckRecord({
      checkId,
      category: result.category,
      command: result.command,
      cwd: root,
      attempt,
      identity,
      requirementIds,
      processResult: result,
      sanitizedArgv,
      sanitizedEnvironment,
      environmentId: environmentValue.id,
      structuredRedactionSecrets: collectCredentialSecrets(commandEnvironment, redactionSecrets),
      structuredEvidenceOverride,
    })
    const outputBytes = record.__outputBytes
    const stdoutArtifact = await store.put({
      id: artifactId(checkId, attempt, 'stdout', outputBytes.stdout),
      bytes: outputBytes.stdout,
      mediaType: 'text/plain; charset=utf-8',
    })
    const stderrArtifact = await store.put({
      id: artifactId(checkId, attempt, 'stderr', outputBytes.stderr),
      bytes: outputBytes.stderr,
      mediaType: 'text/plain; charset=utf-8',
    })
    artifacts.set(stdoutArtifact.id, stdoutArtifact)
    artifacts.set(stderrArtifact.id, stderrArtifact)
    record.stdout = { artifactId: stdoutArtifact.id, sha256: stdoutArtifact.sha256 }
    record.stderr = { artifactId: stderrArtifact.id, sha256: stderrArtifact.sha256 }
    delete record.__outputBytes
    checks.set(checkId, record)
    const generatedArtifacts = await registerCheckArtifacts({
      checkId,
      attempt,
      artifactRoot: evidenceRoot,
      store,
    })
    for (const artifact of generatedArtifacts) artifacts.set(artifact.id, artifact)
    checkArtifacts.set(
      checkId,
      generatedArtifacts.map(({ id }) => id),
    )
    const envelope = stateEnvelope({
      identity,
      startedAt,
      finishedAt: timestamp(now()),
      checks,
      environments,
      artifacts,
      checkArtifacts,
      requirementBindings: checkBindings,
    })
    const value = checkpoint({ identity, plan, envelope })
    await validateCheckpoint(value, {
      artifactRoot: evidenceRoot,
      identity,
      plan,
    })
    await writeCheckpoint(paths.partial, value, writeOptions)
    checkpointFinishedAt = envelope.finishedAt
  }
  const envelope = stateEnvelope({
    identity,
    startedAt,
    finishedAt:
      !executedCheck && resumeEnvelope?.finishedAt
        ? resumeEnvelope.finishedAt
        : (checkpointFinishedAt ?? timestamp(now())),
    checks,
    environments,
    artifacts,
    checkArtifacts,
    requirementBindings: checkBindings,
  })
  const complete = selected.every((id) => checks.has(id))
  const passed = complete && selected.every((id) => checks.get(id).result === 'passed')
  const final = await optionalJson(paths.checks)
  if (final?.checks.every((check) => check.result === 'passed'))
    assert(
      canonicalJson(final) === canonicalJson(envelope),
      'Existing passed final release evidence differs',
    )
  else await writeJsonAtomic(paths.checks, envelope, writeOptions)
  const checksBytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`)
  const collectionManifest = {
    schema: COLLECTION_MANIFEST_SCHEMA,
    schemaVersion: 1,
    braidVersion: identity.braidVersion,
    gitCommit: identity.gitCommit,
    gitTree: identity.gitTree,
    treeSha256: identity.treeSha256,
    tarballSha256: identity.tarballSha256,
    packageIntegrity: identity.packageIntegrity,
    packageFileManifestDigest: identity.packageFileManifestDigest,
    dependencyDigest: identity.dependencyDigest,
    requirementIds: Object.keys(plan.requirements).sort(),
    checkIds: selected,
    checkCount: checks.size,
    result: passed ? 'passed' : complete ? 'failed' : 'incomplete',
    startedAt,
    finishedAt: envelope.finishedAt,
    checksPath: relative(evidenceRoot, paths.checks),
    checksSha256: await sha256(checksBytes),
    signatures: [],
  }
  await preserveCollectionManifest(paths.manifest, collectionManifest)
  return {
    identity,
    result: passed ? 'passed' : complete ? 'failed' : 'incomplete',
    envelope,
    manifest: collectionManifest,
    paths,
  }
}
