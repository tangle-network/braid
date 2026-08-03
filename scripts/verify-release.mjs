import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import {
  containedArtifactPath,
  containedOutputPath,
  readRegularFileNoFollow,
  writeExclusiveAtomic,
} from './release-files.mjs'
import {
  assert,
  assertExactKeys,
  publicKeyId,
  signManifest,
  strictIsoTimestamp,
  validateMeasurements,
  validatePerformanceMatrix,
  validatePerformanceMeasurements,
  validateReleaseInputEnvelope,
  verifyCheckReceipt,
  verifyManifestSignature,
} from './release-evidence.mjs'

const repository = resolve(
  process.env.BRAID_RELEASE_CHECKOUT ?? new URL('../', import.meta.url).pathname,
)
const docsRoot = join(repository, 'docs')
const artifactRoot = join(repository, 'artifacts', 'verification')
const releaseInputRoot = join(artifactRoot, 'release')
const checksPath = join(releaseInputRoot, 'checks.json')
const packageProofPath = join(artifactRoot, 'w6', 'package-proof.json')
const visualProofPath = join(artifactRoot, 'w6', 'capture-manifest.json')
const publicKeyPath = join(repository, 'release', 'execution-public-key.pem')
const publicKeyFingerprintPath = join(repository, 'release', 'execution-public-key.fingerprint')
const REQUIREMENT_PATTERN = /\b[A-Z]{2,4}-[0-9]{2}\b/gu
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const SHA512_INTEGRITY_PATTERN =
  /^sha512-(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const CHECK_CATEGORIES = new Set([
  'unit',
  'contract',
  'subprocess',
  'terminal',
  'live',
  'performance',
  'security',
  'eval',
  'release',
])
const REQUIRED_CHECKS = new Map([
  ['repository', { category: 'release', command: 'pnpm check' }],
  ['unit', { category: 'unit', command: 'pnpm test:unit' }],
  ['contract', { category: 'contract', command: 'pnpm test:contract' }],
  ['rpc', { category: 'subprocess', command: 'pnpm test:rpc' }],
  ['virtual-terminal', { category: 'terminal', command: 'pnpm test:virtual-terminal' }],
  ['pty', { category: 'terminal', command: 'pnpm test:pty' }],
  ['storage', { category: 'contract', command: 'pnpm test:storage' }],
  ['security', { category: 'security', command: 'pnpm test:security' }],
  ['performance', { category: 'performance', command: 'pnpm test:performance' }],
  ['live-bridge', { category: 'live', command: 'pnpm test:live:bridge' }],
  ['live-tangle', { category: 'live', command: 'pnpm test:live:tangle' }],
  ['live-supervisor', { category: 'live', command: 'pnpm test:live:supervisor' }],
  ['live-analysis', { category: 'live', command: 'pnpm test:live:analysis' }],
  ['eval', { category: 'eval', command: 'pnpm test:eval' }],
  ['install', { category: 'release', command: 'pnpm test:install' }],
  ['visual', { category: 'terminal', command: 'pnpm capture:visual' }],
  ['verify:release', { category: 'release', command: 'pnpm verify:release' }],
])
const EXACT_REQUIREMENT_CHECK_CATEGORIES = new Map([
  ['UP', new Set(['contract', 'live'])],
  ['LIVE', new Set(['live'])],
  ['PERF', new Set(['performance'])],
  ['EVAL', new Set(['eval'])],
])
const ADMISSIBLE_CATEGORIES = new Map([
  ['AN', new Set(['unit', 'contract', 'subprocess', 'live', 'security', 'eval'])],
  ['AR', new Set(['unit', 'contract', 'subprocess', 'security', 'release'])],
  ['CF', new Set(['unit', 'contract', 'subprocess', 'live', 'security'])],
  ['EVAL', new Set(['eval'])],
  ['LIVE', new Set(['live'])],
  ['PC', new Set(['unit', 'contract', 'subprocess', 'live', 'security'])],
  ['PERF', new Set(['performance'])],
  [
    'PR',
    new Set(['unit', 'contract', 'subprocess', 'terminal', 'live', 'security', 'eval', 'release']),
  ],
  ['SE', new Set(['contract', 'subprocess', 'live', 'security', 'release'])],
  ['ST', new Set(['unit', 'contract', 'security', 'performance'])],
  ['UP', new Set(['contract', 'live'])],
  ['US', new Set(['contract', 'security', 'release'])],
  ['UX', new Set(['unit', 'subprocess', 'terminal', 'live', 'security', 'performance'])],
  ['VR', new Set(['terminal', 'live', 'performance', 'security', 'eval', 'release'])],
  ['VT', new Set(['subprocess', 'terminal', 'release'])],
])

async function filesBelow(root) {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...(await filesBelow(path)))
    else files.push(path)
  }
  return files
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readRegularFileNoFollow(path))
    .digest('hex')
}

async function sha512Integrity(path) {
  return `sha512-${createHash('sha512')
    .update(await readRegularFileNoFollow(path))
    .digest('base64')}`
}

function uniqueBy(items, key, label) {
  assert(Array.isArray(items), `${label} collection is not an array`)
  const values = new Map()
  for (const item of items) {
    const value = item?.[key]
    assert(typeof value === 'string' && value.length > 0, `${label} has no ${key}`)
    assert(!values.has(value), `Duplicate ${label} ${value}`)
    values.set(value, item)
  }
  return values
}

async function artifactPath(path) {
  assert(typeof path === 'string' && path.length > 0, 'Evidence artifact has no path')
  return containedArtifactPath(repository, path)
}

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
  } catch (error) {
    if (error?.status === 0 && typeof error.stdout === 'string') return error.stdout.trim()
    throw error
  }
}

function renderReport(manifest) {
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

const docFiles = (await filesBelow(docsRoot)).filter((path) => path.endsWith('.md'))
const requirements = new Set()
const specificationDigests = []
for (const path of docFiles) {
  const text = (await readRegularFileNoFollow(path)).toString('utf8')
  for (const match of text.matchAll(REQUIREMENT_PATTERN)) requirements.add(match[0])
  specificationDigests.push({
    path: relative(repository, path),
    sha256: createHash('sha256').update(text).digest('hex'),
  })
}
assert(requirements.size > 0, 'No requirement identifiers found in docs')

assert(
  process.env.BRAID_RELEASE_ISOLATED_CHECKOUT === '1',
  'Release verification requires BRAID_RELEASE_ISOLATED_CHECKOUT=1',
)
assert(
  resolve(process.cwd()) === repository,
  'Release verification must run from its isolated checkout',
)
assert(git('rev-parse', '--is-inside-work-tree') === 'true', 'Release path is not a Git checkout')
assert(
  git('status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching') === '',
  'Release checkout contains tracked, untracked, or ignored files',
)
assert(
  git('ls-files', '--error-unmatch', 'release/execution-public-key.pem') ===
    'release/execution-public-key.pem',
  'Release public key must be tracked',
)
assert(
  git('ls-files', '--error-unmatch', 'release/execution-public-key.fingerprint') ===
    'release/execution-public-key.fingerprint',
  'Release public-key fingerprint must be tracked',
)

const packageProof = JSON.parse((await readRegularFileNoFollow(packageProofPath)).toString('utf8'))
const visualProof = JSON.parse((await readRegularFileNoFollow(visualProofPath)).toString('utf8'))
assert(SHA256_PATTERN.test(packageProof.sha256), 'Package proof has no valid tarball SHA-256')
assert(SHA256_PATTERN.test(packageProof.sourceDigest), 'Package proof has no exact source digest')
assert(packageProof.isolatedBuild === true, 'Package proof was not built in isolation')
assert(
  packageProof.sourceCheckout === 'isolated-copy-of-worktree',
  'Package proof does not identify its isolated source checkout',
)
assert(visualProof.tarballSha256 === packageProof.sha256, 'Visual proof used another tarball')
assert(
  visualProof.binary === 'clean npm install from generated tarball',
  'Visual proof is not packed',
)
assert(
  visualProof.provenance?.renderer?.package === '@earendil-works/pi-tui@0.83.0',
  'Visual proof renderer package is not pinned',
)
assert(
  typeof visualProof.provenance?.renderer?.pty === 'string',
  'Visual proof has no PTY provenance',
)
assert(
  typeof visualProof.provenance?.renderer?.emulator === 'string',
  'Visual proof has no terminal emulator provenance',
)
assert(
  typeof visualProof.provenance?.renderer?.node === 'string',
  'Visual proof has no Node provenance',
)
assert(
  visualProof.provenance?.raster?.colorMode === 'sRGB 8-bit',
  'Visual proof color mode is not pinned',
)
assert(
  visualProof.provenance?.raster?.fontFamily === 'DejaVu Sans Mono',
  'Visual proof font family is not pinned',
)
assert(
  typeof visualProof.provenance?.raster?.font === 'string',
  'Visual proof has no font provenance',
)
assert(
  typeof visualProof.provenance?.raster?.agg === 'string',
  'Visual proof has no agg provenance',
)
assert(
  typeof visualProof.provenance?.raster?.imagemagick === 'string',
  'Visual proof has no ImageMagick provenance',
)
for (const [columns, rows] of [
  [40, 12],
  [80, 24],
  [120, 40],
  [200, 60],
]) {
  for (const suffix of ['.txt', '-plain.txt', '.png']) {
    assert(
      visualProof.artifacts.some(
        (artifact) =>
          artifact.columns === columns &&
          artifact.rows === rows &&
          artifact.path === `${columns}x${rows}${suffix}`,
      ),
      `Visual proof is missing ${columns}x${rows}${suffix}`,
    )
  }
}
assert(
  visualProof.artifacts.some((artifact) => artifact.path === '80x24-flow.gif'),
  'Visual proof is missing 80x24-flow.gif',
)
const requiredVisualStates = [
  'empty',
  'active-streaming',
  'interaction',
  'fork-preview',
  'graph-or-analysis',
  'narrow',
  'failure-or-reconnect',
]
assert(Array.isArray(visualProof.states), 'Visual proof has no required state matrix')
const visualStates = new Map(visualProof.states.map((state) => [state.name, state]))
assert(visualStates.size === visualProof.states.length, 'Visual proof repeats a required state')
for (const name of requiredVisualStates) {
  const state = visualStates.get(name)
  assert(state, `Visual proof is missing ${name} state`)
  assert(
    Number.isInteger(state.columns) && Number.isInteger(state.rows),
    `${name} has no dimensions`,
  )
  assert(
    state.artifacts && typeof state.artifacts === 'object' && !Array.isArray(state.artifacts),
    `${name} has no artifact map`,
  )
  for (const kind of ['semantic-state', 'plain-frame', 'asciicast', 'ansi', 'png']) {
    const path = state.artifacts[kind]
    assert(typeof path === 'string' && path.length > 0, `${name} is missing ${kind}`)
    const artifact = visualProof.artifacts.find((candidate) => candidate.path === path)
    assert(artifact, `${name} names an unknown ${kind} artifact`)
    assert(artifact.kind === kind, `${name} ${kind} artifact kind differs`)
    assert(
      artifact.columns === state.columns && artifact.rows === state.rows,
      `${name} ${kind} dimensions differ`,
    )
  }
  const semanticPath = await containedArtifactPath(
    join(artifactRoot, 'w6'),
    state.artifacts['semantic-state'],
  )
  const semantic = JSON.parse((await readRegularFileNoFollow(semanticPath)).toString('utf8'))
  assert(semantic.schemaVersion === 2, `${name} semantic state schema differs`)
  assert(semantic.capturePhase === 'atomic-signal-frame', `${name} capture phase differs`)
  assert(
    semantic.captureRevision === semantic.packedState?.view?.revision,
    `${name} frame revision differs`,
  )
  assert(
    semantic.packedState?.capturePhase === 'atomic-signal-frame',
    `${name} packed state phase differs`,
  )
  assert(
    semantic.packedState?.state?.revision === semantic.packedState?.view?.revision,
    `${name} packed state revision differs`,
  )
  assert(
    semantic.source?.binarySha256 === visualProof.binarySha256,
    `${name} binary provenance differs`,
  )
  assert(
    JSON.stringify(semantic.provenance) === JSON.stringify(visualProof.provenance),
    `${name} renderer provenance differs`,
  )
  if (name === 'interaction') {
    assert(semantic.packedState?.view?.interactions?.length === 1, 'Interaction state is empty')
    assert(
      semantic.packedState.view.interactions[0].answerSpec?.kind === 'boolean',
      'Interaction answer spec is not real',
    )
  }
  if (name === 'fork-preview') {
    assert(semantic.packedState?.view?.forkPreview?.allowed === true, 'Fork state is unavailable')
    assert(
      typeof semantic.packedState.view.forkPreview.destination === 'string',
      'Fork destination is missing',
    )
  }
}
for (const artifact of visualProof.artifacts) {
  const path = await containedArtifactPath(join(artifactRoot, 'w6'), artifact.path)
  assert((await sha256(path)) === artifact.sha256, `Visual artifact hash changed: ${artifact.path}`)
}

const evidence = JSON.parse(
  await readRegularFileNoFollow(checksPath)
    .then((bytes) => bytes.toString('utf8'))
    .catch(() => {
      throw new Error(
        `Release evidence is incomplete: ${relative(repository, checksPath)} is missing`,
      )
    }),
)
const releaseWindow = validateReleaseInputEnvelope(evidence)
assert(evidence.braidVersion === packageProof.version, 'Release evidence version differs')
assert(evidence.gitCommit === git('rev-parse', 'HEAD'), 'Release evidence commit differs')
const sourceTree = git('rev-parse', 'HEAD^{tree}')
assert(packageProof.gitCommit === evidence.gitCommit, 'Package proof source commit differs')
assert(packageProof.treeSha256 === sourceTree, 'Package proof source tree differs')
assert(evidence.sourceState.commit === evidence.gitCommit, 'Release source commit differs')
assert(evidence.sourceState.treeSha256 === sourceTree, 'Release source tree differs')
const releaseStartedAt = releaseWindow.startedAt
const releaseFinishedAt = releaseWindow.finishedAt

assert(evidence.sourceState.clean === true, 'Source state is not clean')
assert(evidence.sourceState.commit === evidence.gitCommit, 'Source state commit differs')
assert(evidence.sourceState.tarballSha256 === packageProof.sha256, 'Source tarball digest differs')

const packageJson = JSON.parse(
  (await readRegularFileNoFollow(join(repository, 'package.json'))).toString('utf8'),
)
assert(packageJson.version === evidence.braidVersion, 'package.json version differs')
const dependencies = uniqueBy(evidence.dependencies, 'name', 'dependency')
for (const dependency of dependencies.values()) {
  assertExactKeys(dependency, ['name', 'version', 'integrity'], [], `Dependency ${dependency.name}`)
  assert(
    typeof dependency.version === 'string' && dependency.version.length > 0,
    `Dependency ${dependency.name} has no version`,
  )
  assert(
    SHA512_INTEGRITY_PATTERN.test(dependency.integrity),
    `Dependency ${dependency.name} has invalid integrity`,
  )
}
for (const [name, version] of Object.entries(packageJson.dependencies ?? {})) {
  const dependency = dependencies.get(name)
  assert(dependency, `Runtime dependency ${name} is absent from release evidence`)
  assert(dependency.version === version, `Runtime dependency ${name} version differs`)
}

const environments = uniqueBy(evidence.environments, 'id', 'environment')
for (const environment of environments.values()) {
  assertExactKeys(environment, ['id', 'kind', 'details'], [], `Environment ${environment.id}`)
  assert(
    typeof environment.kind === 'string' && environment.kind.length > 0,
    `Environment ${environment.id} has no kind`,
  )
  assert(
    environment.details &&
      typeof environment.details === 'object' &&
      !Array.isArray(environment.details),
    `Environment ${environment.id} has no details`,
  )
}

const checks = uniqueBy(evidence.checks, 'id', 'check')
const artifacts = uniqueBy(evidence.artifacts, 'id', 'artifact')
const mappings = new Map(Object.entries(evidence.requirements))
const allowedCheckIds = new Set([...REQUIRED_CHECKS.keys(), ...requirements])
const allowedCommands = new Map(
  [...REQUIRED_CHECKS.values()].map((check) => [check.command, check.category]),
)
const publicKey = (await readRegularFileNoFollow(publicKeyPath)).toString('utf8')
const publicKeyFingerprint = (await readRegularFileNoFollow(publicKeyFingerprintPath))
  .toString('utf8')
  .trim()
assert(
  publicKeyFingerprint === publicKeyId(publicKey),
  'Release public key fingerprint is not pinned',
)

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
      'receipt',
    ],
    [],
    `Check ${check.id}`,
  )
  assert(allowedCheckIds.has(check.id), `Check ${check.id} is outside the closed check catalog`)
  assert(CHECK_CATEGORIES.has(check.category), `Check ${check.id} has invalid category`)
  assert(allowedCommands.has(check.command), `Check ${check.id} uses an unregistered command`)
  assert(
    allowedCommands.get(check.command) === check.category,
    `Check ${check.id} command category differs`,
  )
  assert(check.result === 'passed', `Check ${check.id} did not pass`)
  assert(check.result !== 'unavailable', `Required check ${check.id} is unavailable`)
  assert(check.required === true, `Check ${check.id} is not marked required`)
  assert(check.buildSha256 === packageProof.sha256, `Check ${check.id} used another build`)
  assert(typeof check.cwd === 'string' && check.cwd.length > 0, `Check ${check.id} has no cwd`)
  assert(
    environments.has(check.environment),
    `Check ${check.id} names unknown environment ${check.environment}`,
  )
  const startedAt = strictIsoTimestamp(check.startedAt, `Check ${check.id} start`)
  const completedAt = strictIsoTimestamp(check.completedAt, `Check ${check.id} completion`)
  assert(startedAt >= releaseStartedAt, `Check ${check.id} started before the release`)
  assert(completedAt <= releaseFinishedAt, `Check ${check.id} ended after the release`)
  assert(completedAt >= startedAt, `Check ${check.id} completed before it started`)
  assert(
    check.durationMs === completedAt - startedAt,
    `Check ${check.id} duration differs from its timestamps`,
  )
  assert(check.exitCode === 0, `Check ${check.id} has a nonzero exit code`)
  assert(Number.isInteger(check.attempt) && check.attempt > 0, `Check ${check.id} has no attempt`)
  if (check.category === 'performance') {
    validatePerformanceMeasurements(check.measurements, `Check ${check.id}`)
    performanceMeasurements.push(...check.measurements)
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
  }
  verifyCheckReceipt(check, publicKey)
}

validatePerformanceMatrix(performanceMeasurements, 'Release performance matrix')

for (const artifact of artifacts.values()) {
  assertExactKeys(artifact, ['id', 'path', 'sha256', 'mediaType'], [], `Artifact ${artifact.id}`)
  assert(SHA256_PATTERN.test(artifact.sha256), `Artifact ${artifact.id} has invalid SHA-256`)
  assert(
    typeof artifact.mediaType === 'string' && artifact.mediaType.length > 0,
    `Artifact ${artifact.id} has no media type`,
  )
  const path = await artifactPath(artifact.path)
  assert((await sha256(path)) === artifact.sha256, `Artifact ${artifact.id} digest changed`)
}
const tarballArtifact = artifacts.get(evidence.sourceState.tarballArtifactId)
assert(tarballArtifact, 'Source state names an unknown tarball artifact')
assert(tarballArtifact.sha256 === packageProof.sha256, 'Tarball artifact digest differs')
assert(
  (await sha512Integrity(await artifactPath(tarballArtifact.path))) === evidence.packageIntegrity,
  'Tarball artifact integrity differs',
)

for (const requirement of requirements) {
  const mapping = mappings.get(requirement)
  assert(mapping, `Requirement ${requirement} has no evidence mapping`)
  assertExactKeys(mapping, ['checks', 'artifacts'], [], `Requirement ${requirement}`)
  assert(Array.isArray(mapping.checks) && mapping.checks.length > 0, `${requirement} has no checks`)
  assert(
    Array.isArray(mapping.artifacts) && mapping.artifacts.length > 0,
    `${requirement} has no artifacts`,
  )
  assert(new Set(mapping.checks).size === mapping.checks.length, `${requirement} repeats a check`)
  assert(
    new Set(mapping.artifacts).size === mapping.artifacts.length,
    `${requirement} repeats an artifact`,
  )
  for (const check of mapping.checks)
    assert(checks.has(check), `${requirement} names unknown check ${check}`)
  for (const artifact of mapping.artifacts)
    assert(artifacts.has(artifact), `${requirement} names unknown artifact ${artifact}`)
  const prefix = requirement.slice(0, requirement.indexOf('-'))
  const admissibleCategories = ADMISSIBLE_CATEGORIES.get(prefix)
  assert(admissibleCategories, `Requirement ${requirement} has no category policy`)
  assert(
    mapping.checks.some((id) => admissibleCategories.has(checks.get(id).category)),
    `${requirement} is linked only to inadmissible check categories`,
  )
  const exactCategories = EXACT_REQUIREMENT_CHECK_CATEGORIES.get(prefix)
  if (exactCategories) {
    const exactCheck = checks.get(requirement)
    assert(exactCheck, `Requirement ${requirement} requires its own check record`)
    assert(
      exactCategories.has(exactCheck.category),
      `Check ${requirement} has inadmissible category`,
    )
    assert(
      mapping.checks.includes(requirement),
      `${requirement} does not cite its own check record`,
    )
  }
}
for (const requirement of mappings.keys()) {
  assert(requirements.has(requirement), `Evidence maps unknown requirement ${requirement}`)
}
const referencedChecks = new Set(
  [...mappings.values()].flatMap((mapping) =>
    Array.isArray(mapping.checks) ? mapping.checks : [],
  ),
)
for (const id of checks.keys())
  assert(referencedChecks.has(id), `Check ${id} is not linked to a requirement`)
const referencedArtifacts = new Set([
  evidence.sourceState.tarballArtifactId,
  ...[...checks.values()].flatMap((check) => [check.stdout.artifactId, check.stderr.artifactId]),
  ...[...mappings.values()].flatMap((mapping) =>
    Array.isArray(mapping.artifacts) ? mapping.artifacts : [],
  ),
])
for (const id of artifacts.keys())
  assert(referencedArtifacts.has(id), `Artifact ${id} is unreferenced`)

const liveResources = uniqueBy(evidence.liveResources, 'id', 'live resource')
const cleanup = uniqueBy(evidence.cleanup, 'resourceId', 'cleanup record')
for (const resource of liveResources.values()) {
  assertExactKeys(
    resource,
    ['id', 'type', 'environment', 'billable'],
    [],
    `Live resource ${resource.id}`,
  )
  assert(
    environments.has(resource.environment),
    `Live resource ${resource.id} names an unknown environment`,
  )
  assert(
    typeof resource.type === 'string' && resource.type.length > 0,
    `Live resource ${resource.id} has no type`,
  )
  assert(
    typeof resource.billable === 'boolean',
    `Live resource ${resource.id} has invalid billable state`,
  )
  const record = cleanup.get(resource.id)
  assert(record, `Live resource ${resource.id} has no cleanup record`)
  assertExactKeys(
    record,
    ['resourceId', 'status', 'completedAt'],
    ['reason'],
    `Cleanup ${resource.id}`,
  )
  assert(record.status === 'confirmed', `Live resource ${resource.id} cleanup is unresolved`)
  strictIsoTimestamp(record.completedAt, `Cleanup ${resource.id} completion`)
}
for (const resourceId of cleanup.keys()) {
  assert(liveResources.has(resourceId), `Cleanup names unknown live resource ${resourceId}`)
}

const signingKeyPath = process.env.BRAID_RELEASE_SIGNING_KEY_PATH
assert(signingKeyPath, 'BRAID_RELEASE_SIGNING_KEY_PATH is required to sign the release manifest')
const signingKeyInfo = await lstat(signingKeyPath)
assert(signingKeyInfo.isFile(), 'Release signing key is not a file')
assert(!signingKeyInfo.isSymbolicLink(), 'Release signing key may not be a symlink')
assert((signingKeyInfo.mode & 0o077) === 0, 'Release signing key permissions are broader than 0600')
assert(
  !resolve(signingKeyPath).startsWith(`${repository}/`),
  'Release signing key must be outside checkout',
)
const signingKey = (await readRegularFileNoFollow(signingKeyPath)).toString('utf8')
const unsignedManifest = {
  ...evidence,
  sourceState: {
    ...evidence.sourceState,
    specificationDigests: specificationDigests.sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  },
}
const manifest = signManifest(unsignedManifest, signingKey)
verifyManifestSignature(manifest, publicKey)
const outputRoot = await containedOutputPath(
  repository,
  join('artifacts', 'verification', evidence.braidVersion),
)
const outputPath = join(outputRoot, 'manifest.json')
const reportPath = join(outputRoot, 'report.md')
await mkdir(outputRoot, { recursive: true })
await writeExclusiveAtomic(outputPath, `${JSON.stringify(manifest, null, 2)}\n`)
await writeExclusiveAtomic(reportPath, renderReport(manifest))
process.stdout.write(
  `Validated ${requirements.size} requirements, ${checks.size} signed checks, and ${artifacts.size} artifacts for @tangle-network/braid@${evidence.braidVersion}\n`,
)
