import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { join, relative, resolve } from 'node:path'

import { REQUIRED_CHECKS } from '../release-check-catalog.mjs'
import {
  canonicalJson,
  signCheck,
  signManifest,
  verifyManifestSignature,
} from '../release-evidence.mjs'
import { readRegularFileNoFollow } from '../release-files.mjs'
import { createArtifactStore } from './artifact-store.mjs'
import { cleanTemporaryFiles, readJson, writeJsonAtomic } from './atomic-storage.mjs'
import {
  materializeRequirementBindings,
  normalizeRequirementCheckBindings,
  requirementsObject,
} from './bindings.mjs'
import { readBuildIdentity, readRequirementIds } from './build-identity.mjs'
import { boundaryForCheck, buildCheckRecord, environmentRecord } from './collection-contract.mjs'
import {
  CHECKPOINT_SCHEMA,
  COLLECTION_MANIFEST_SCHEMA,
  checkpointBuild,
  checkpointPlan,
  requirementIdsForPlan,
  validateCheckpoint,
} from './collector-validation.mjs'
import {
  collectRedactionSecrets,
  executeCatalogCheck,
  sanitizeArgv,
  sanitizeEnvironment,
} from './command-runner.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function timestamp(milliseconds) {
  return new Date(Math.trunc(milliseconds)).toISOString()
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function keyPair(signingKey, publicKey) {
  const privateObject = signingKey?.type === 'private' ? signingKey : createPrivateKey(signingKey)
  assert(privateObject.asymmetricKeyType === 'ed25519', 'Release signing key must be Ed25519')
  const publicObject = publicKey
    ? publicKey?.type === 'public'
      ? publicKey
      : createPublicKey(publicKey)
    : createPublicKey(privateObject)
  assert(publicObject.asymmetricKeyType === 'ed25519', 'Release public key must be Ed25519')
  assert(
    canonicalJson(publicObject.export({ format: 'jwk' })) ===
      canonicalJson(createPublicKey(privateObject).export({ format: 'jwk' })),
    'Release public key does not match signing key',
  )
  return { privateObject, publicObject }
}

async function optionalJson(path) {
  try {
    return await readJson(path, readRegularFileNoFollow)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

function selectedChecks(checkIds) {
  const ids = checkIds ? [...checkIds] : [...REQUIRED_CHECKS.keys()]
  assert(ids.length > 0, 'At least one release check is required')
  assert(new Set(ids).size === ids.length, 'Release check identifiers are duplicated')
  for (const id of ids) assert(REQUIRED_CHECKS.has(id), `Unknown release check: ${id}`)
  return ids
}

function artifactId(checkId, attempt, stream) {
  return `check-${checkId.replaceAll('/', '_')}-attempt-${attempt}-${stream}`
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
  requirementBindings,
}) {
  const artifactsByCheck = new Map(
    [...checks.values()].map((check) => [
      check.id,
      [check.stdout.artifactId, check.stderr.artifactId],
    ]),
  )
  const requirements = materializeRequirementBindings(requirementBindings, {
    artifactsByCheck,
    additionalArtifacts: ['package-tarball'],
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

async function preserveSignedManifest(path, manifest, publicKey) {
  const existing = await optionalJson(path)
  if (existing) {
    verifyManifestSignature(existing, publicKey)
    assert(
      canonicalJson(existing) === canonicalJson(manifest),
      'Existing collection manifest differs',
    )
    return existing
  }
  await writeJsonAtomic(path, manifest)
  return manifest
}

export async function collectReleaseEvidence({
  repository,
  tarballPath,
  packageProofPath,
  packageProof,
  requirementBindings,
  signingKey,
  publicKey,
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
    typeof tarballPath === 'string' && tarballPath.length > 0,
    'Packed tarball path is required',
  )
  assert(requirementBindings, 'Requirement check bindings are required')
  const keys = keyPair(signingKey, publicKey)
  const identity = await readBuildIdentity({
    repository: root,
    tarballPath,
    packageProofPath,
    packageProof,
  })
  const documentedRequirementIds = await readRequirementIds(root)
  assert(
    canonicalJson(documentedRequirementIds) === canonicalJson(identity.requirementIds),
    'Build identity requirement list differs from docs',
  )
  const selected = selectedChecks(checkIds)
  const checkBindings = normalizeRequirementCheckBindings(
    requirementBindings,
    identity.requirementIds,
    selected,
  )
  for (const id of selected)
    assert(
      requirementIdsForPlan({ requirements: Object.fromEntries(checkBindings) }, id).length > 0,
      `Release check ${id} has no requirement binding`,
    )
  const plan = checkpointPlan({
    checkIds: selected,
    requirementBindings: checkBindings,
    publicKey: keys.publicObject,
  })
  const outputRoot = join(root, 'artifacts', 'verification', 'release')
  const paths = {
    partial: partialPath ?? join(outputRoot, 'checks.partial.json'),
    checks: checksPath ?? join(outputRoot, 'checks.json'),
    manifest: manifestPath ?? join(outputRoot, 'collection-manifest.json'),
  }
  await cleanTemporaryFiles(outputRoot)
  const store = createArtifactStore({ repository: root })
  const tarballArtifact = await store.register({
    id: 'package-tarball',
    path: identity.tarballPath,
    mediaType: 'application/gzip',
  })
  const artifacts = artifactMap([tarballArtifact])
  const checks = new Map()
  const environments = new Map()
  const partial = await optionalJson(paths.partial)
  const finalInput = await optionalJson(paths.checks)
  let startedAt = timestamp(now())
  if (partial) {
    await validateCheckpoint(partial, {
      repository: root,
      identity,
      plan,
      publicKey: keys.publicObject,
    })
    startedAt = partial.envelope.startedAt
    for (const artifact of partial.envelope.artifacts) artifacts.set(artifact.id, artifact)
    for (const check of partial.envelope.checks) checks.set(check.id, check)
    for (const environmentRecordValue of partial.envelope.environments)
      environments.set(environmentRecordValue.id, environmentRecordValue)
  }
  if (finalInput) {
    const finalCheckpoint = checkpoint({ identity, plan, envelope: finalInput })
    await validateCheckpoint(finalCheckpoint, {
      repository: root,
      identity,
      plan,
      publicKey: keys.publicObject,
    })
    if (partial && canonicalJson(partial.envelope) !== canonicalJson(finalInput))
      throw new Error('Partial and final release evidence differ')
    startedAt = finalInput.startedAt
    for (const artifact of finalInput.artifacts) artifacts.set(artifact.id, artifact)
    for (const check of finalInput.checks) checks.set(check.id, check)
    for (const environmentRecordValue of finalInput.environments)
      environments.set(environmentRecordValue.id, environmentRecordValue)
  }
  for (const checkId of selected) {
    if (checks.has(checkId)) continue
    const entry = REQUIRED_CHECKS.get(checkId)
    const requirementIds = requirementIdsForPlan(plan, checkId)
    const result = await runCheck({
      checkId,
      cwd: root,
      environment,
      timeoutMs,
      maxLogBytes,
      redactionSecrets,
    })
    assert(result.checkId === checkId, `Runner returned another check: ${result.checkId}`)
    assert(
      result.command === entry.command && result.category === entry.category,
      `Runner drifted from catalog for ${checkId}`,
    )
    const secrets = collectRedactionSecrets(environment, redactionSecrets)
    const sanitizedArgv = result.sanitizedArgv ?? sanitizeArgv(result.argv, secrets)
    const sanitizedEnvironment = result.sanitizedEnvironment ?? sanitizeEnvironment(environment)
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
    const attempt = 1
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
    })
    const outputBytes = record.__outputBytes
    const stdoutArtifact = await store.put({
      id: artifactId(checkId, attempt, 'stdout'),
      bytes: outputBytes.stdout,
      mediaType: 'text/plain; charset=utf-8',
    })
    const stderrArtifact = await store.put({
      id: artifactId(checkId, attempt, 'stderr'),
      bytes: outputBytes.stderr,
      mediaType: 'text/plain; charset=utf-8',
    })
    artifacts.set(stdoutArtifact.id, stdoutArtifact)
    artifacts.set(stderrArtifact.id, stderrArtifact)
    record.stdout = { artifactId: stdoutArtifact.id, sha256: stdoutArtifact.sha256 }
    record.stderr = { artifactId: stderrArtifact.id, sha256: stderrArtifact.sha256 }
    delete record.__outputBytes
    checks.set(checkId, signCheck(record, keys.privateObject))
    const envelope = stateEnvelope({
      identity,
      startedAt,
      finishedAt: timestamp(now()),
      checks,
      environments,
      artifacts,
      requirementBindings: checkBindings,
    })
    const value = checkpoint({ identity, plan, envelope })
    await validateCheckpoint(value, {
      repository: root,
      identity,
      plan,
      publicKey: keys.publicObject,
    })
    await writeCheckpoint(paths.partial, value, writeOptions)
  }
  const envelope = stateEnvelope({
    identity,
    startedAt,
    finishedAt: timestamp(now()),
    checks,
    environments,
    artifacts,
    requirementBindings: checkBindings,
  })
  const complete = selected.every((id) => checks.has(id))
  const passed = complete && selected.every((id) => checks.get(id).result === 'passed')
  const final = await optionalJson(paths.checks)
  if (final)
    assert(
      canonicalJson(final) === canonicalJson(envelope),
      'Existing final release evidence differs',
    )
  else await writeJsonAtomic(paths.checks, envelope, writeOptions)
  const checksBytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`)
  const collectionManifest = signManifest(
    {
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
      requirementIds: identity.requirementIds,
      checkIds: selected,
      checkCount: checks.size,
      result: passed ? 'passed' : complete ? 'failed' : 'incomplete',
      startedAt,
      finishedAt: envelope.finishedAt,
      checksPath: relative(root, paths.checks),
      checksSha256: await sha256(checksBytes),
    },
    keys.privateObject,
  )
  await preserveSignedManifest(paths.manifest, collectionManifest, keys.publicObject)
  return {
    identity,
    result: passed ? 'passed' : complete ? 'failed' : 'incomplete',
    envelope,
    manifest: collectionManifest,
    paths,
  }
}
