import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import {
  PROOF_OPERATIONS,
  proofReceipt,
  tangleReceiptsArtifact,
} from '../live-required/contracts.mjs'
import {
  MULTIRUN_PROOF_SCHEMA,
  MULTIRUN_REQUIRED_PHASES,
} from '../live-required/multirun-contract.mjs'
import { bindingForCheck, readCandidateIdentity } from './build-identity.mjs'
import { serializedLiveEvidenceBinding } from './live-evidence-binding.mjs'
import { packageFileManifestFromTarball, sourceDigest } from './package-archive.mjs'
import { verifyLive10Candidate } from './publish-gate.mjs'

const RUNTIME_INTEGRITY = `sha512-${'A'.repeat(88)}`
const TARBALL_NAME = 'example-braid-1.0.0.tgz'
const TIMESTAMP_START = '2026-09-01T00:00:00.000Z'
const TIMESTAMP_FINISH = '2026-09-01T00:00:01.000Z'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function git(repository, ...args) {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_AUTHOR_NAME: 'Release fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Release fixture',
    },
  }).trim()
}

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`
}

function tarArchive(entries) {
  const blocks = []
  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0)
    const header = Buffer.alloc(512)
    header.write(entry.name, 0, 'utf8')
    header.write(octal(0o644, 8), 100, 'ascii')
    header.write(octal(0, 8), 108, 'ascii')
    header.write(octal(0, 8), 116, 'ascii')
    header.write(octal(body.length, 12), 124, 'ascii')
    header.write(octal(0, 12), 136, 'ascii')
    header.fill(0x20, 148, 156)
    header[156] = entry.type === 'directory' ? 0x35 : 0x30
    header.write('ustar\0', 257, 'ascii')
    header.write('00', 263, 'ascii')
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
    blocks.push(header, body)
    if (body.length % 512 !== 0) blocks.push(Buffer.alloc(512 - (body.length % 512)))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

function multirunProof(releaseBinding) {
  const run = (suffix, status) => ({
    runId: `run-${suffix}`,
    conversationId: `conversation-${suffix}`,
    branchId: `branch-${suffix}`,
    eventCount: 1,
    eventIdsUnique: true,
    localEnvironmentId: `local-${suffix}`,
    providerEnvironmentId: `provider-environment-${suffix}`,
    identifiers: [
      { kind: 'provider-environment', id: `provider-environment-${suffix}` },
      { kind: 'provider-session', id: `provider-session-${suffix}` },
      { kind: 'provider-execution', id: `provider-execution-${suffix}` },
      { kind: 'provider-run', id: `provider-run-${suffix}` },
    ],
    status,
  })
  const first = run('a', 'completed')
  const second = run('b', 'cancelled')
  return {
    schemaVersion: MULTIRUN_PROOF_SCHEMA,
    status: 'passed',
    releaseBinding,
    proofId: 'fixture-multirun',
    startedAt: TIMESTAMP_START,
    completedAt: TIMESTAMP_FINISH,
    provider: {
      endpoint: 'https://sandbox.tangle.tools',
      model: 'glm-5.2',
      runner: 'opencode',
      lifecycle: 'retained',
      credentialConfigured: true,
    },
    error: null,
    conversations: {
      first: { conversationId: first.conversationId, branchId: first.branchId },
      second: { conversationId: second.conversationId, branchId: second.branchId },
    },
    runs: [first, second],
    overlap: {
      activeRunCount: 2,
      independentConversations: true,
      workStripCount: 2,
      renderedWorkStripCount: 2,
      streamEventCounts: [
        { runId: first.runId, count: 1 },
        { runId: second.runId, count: 1 },
      ],
    },
    focus: {
      beforeRunId: second.runId,
      firstSwitchRunId: first.runId,
      secondSwitchRunId: second.runId,
      firstSwitchPreservedStatuses: true,
      secondSwitchPreservedStatuses: true,
    },
    cancellation: {
      dispatch: {
        eventKind: 'run.control.requested',
        control: 'cancel',
        runId: second.runId,
        operationId: 'operation-cancel-b',
      },
      targetRunId: second.runId,
      targetStatus: 'cancelled',
      unaffectedRunId: first.runId,
      unaffectedStatusAtAck: 'running',
      unaffectedFinalStatus: 'completed',
    },
    replay: {
      restartedRunCount: 2,
      noDuplicateEventIds: true,
      eventSetsStable: true,
    },
    cleanup: {
      exact: true,
      errors: [],
      resources: [
        {
          id: 'resource-a',
          runId: first.runId,
          providerEnvironmentId: first.providerEnvironmentId,
          confirmed: true,
        },
        {
          id: 'resource-b',
          runId: second.runId,
          providerEnvironmentId: second.providerEnvironmentId,
          confirmed: true,
        },
      ],
      activeResourceDelta: 0,
      accountStable: true,
      workspace: { protectedStoreClean: true, temporaryRootRemoved: true },
    },
    phases: Object.fromEntries(
      MULTIRUN_REQUIRED_PHASES.map((phase) => [phase, { status: 'passed' }]),
    ),
  }
}

function proofReceiptForRow(row, environment, multirun) {
  const common = {
    invocationId: `fixture-${row}`,
    startedAt: TIMESTAMP_START,
    completedAt: TIMESTAMP_FINISH,
    config: {
      endpoint: 'https://sandbox.tangle.tools',
      connectionId: `connection-${row}`,
      connectionKind: 'tangle-sandbox',
      credentialConfigured: true,
      model: 'glm-5.2',
      modelProvider: 'tangle-router',
      runner: row === 'LIVE-08' ? 'pi' : 'opencode',
    },
    environment,
  }
  if (row === 'LIVE-06')
    return proofReceipt({
      ...common,
      operation: PROOF_OPERATIONS.tangleInference,
      runIds: ['run-live-06', 'run-live-06-cancelled'],
      facts: {
        normalRunId: 'run-live-06',
        cancelledRunId: 'run-live-06-cancelled',
        cancellationStatus: 'confirmed',
        cancellationResponseCode: null,
      },
      checks: ['normal-turn', 'cancelled-turn', 'materialization-receipt'],
    })
  if (row === 'LIVE-07')
    return proofReceipt({
      ...common,
      operation: PROOF_OPERATIONS.tangleSandbox,
      runIds: [
        'run-live-07',
        'run-live-07-resumed',
        'run-live-07-follow-up',
        'run-live-07-cancelled',
      ],
      environmentId: 'environment-live-07',
      facts: {
        environmentId: 'environment-live-07',
        resumedRunId: 'run-live-07-resumed',
        followUpRunId: 'run-live-07-follow-up',
        cancelledRunId: 'run-live-07-cancelled',
        resumeFromCursor: 'cursor-before',
        finalCursor: 'cursor-after',
        cloudControl: {
          provider: 'tangle-sandbox',
          environmentId: 'provider-environment-live-07',
          sessionId: 'provider-session-live-07',
          executionId: 'provider-execution-live-07',
          runId: 'provider-run-live-07',
          requestDigest: `sha256:${'1'.repeat(64)}`,
        },
        exactResource: true,
        activeResourceDelta: 0,
      },
      checks: [
        'marker',
        'environment-id',
        'workspace-read-write-exec-git',
        'sigkill-reconnect',
        'exclusive-replay',
        'follow-up-session',
        'cancel-retry-conflict',
        'exact-resource-cleanup',
      ],
      observations: { multirun },
    })
  if (row === 'LIVE-08')
    return proofReceipt({
      ...common,
      operation: PROOF_OPERATIONS.tangleSandboxInteractive,
      runIds: ['run-live-08'],
      environmentId: 'environment-live-08',
      facts: {
        environmentId: 'environment-live-08',
        localRunId: 'run-live-08',
        stoppedStatus: 'cancelled',
        cloudControl: {
          provider: 'tangle-sandbox',
          environmentId: 'provider-environment-live-08',
          sessionId: 'provider-session-live-08',
          executionId: 'provider-execution-live-08',
          runId: 'provider-run-live-08',
          requestDigest: `sha256:${'2'.repeat(64)}`,
        },
        exactResource: true,
        processExitedBeforeWorkspaceCleanup: true,
        terminalResize: true,
        processGroupExitedBeforeWorkspaceCleanup: true,
        providerInput: true,
        providerReconnect: true,
        singleProviderExecution: true,
        exactOwnedResourceSetCleanup: true,
        accountIdentityStable: true,
        activeResourceDelta: 0,
        telemetryComplete: true,
        spendDisclosed: true,
        latencyObserved: true,
      },
      checks: [
        'packed-binary',
        'interactive-command',
        'input',
        'detach',
        'reconnect',
        'terminal-resize',
        'same-local-run',
        'same-provider-control-ref',
        'sandbox-observed-before-stop',
        'stop-through-braid',
        'sandbox-observed-stopped',
        'exact-resource-cleanup',
        'process-exited-before-cleanup',
        'process-group-exited-before-cleanup',
        'provider-bound-input',
        'provider-bound-reconnect',
        'single-provider-execution',
        'exact-owned-resource-set-cleanup',
        'account-identity-stable',
        'active-resource-delta',
        'telemetry-complete',
        'spend-disclosed',
        'latency-observed',
      ],
      observations: Object.fromEntries(
        [
          'checks',
          'configuration',
          'run',
          'sandbox',
          'identityContinuity',
          'processCleanup',
          'providerEvidence',
          'providerExecution',
          'usage',
          'accountIdentities',
          'accountIdentityConsistency',
          'usageDelta',
          'telemetry',
          'spend',
          'timing',
        ].map((key) => [key, {}]),
      ),
    })
  if (row === 'LIVE-09')
    return proofReceipt({
      ...common,
      operation: PROOF_OPERATIONS.tangleWorkspaceFork,
      runIds: ['run-live-09'],
      environmentId: 'environment-live-09',
      facts: {
        sourceProviderEnvironmentId: 'provider-source-09',
        destinationProviderEnvironmentId: 'provider-destination-09',
        checkpointRetried: true,
        forkRetried: true,
        restarted: true,
        sourceDigestBefore: 'source-before',
        sourceDigestAfter: 'source-before',
        destinationDigest: 'destination-after',
        cleanupCheckpoint: 'deleted',
        cleanupEnvironment: 'deleted',
      },
      checks: [
        'configuration',
        'source-run',
        'plan',
        'execute',
        'retry',
        'restart',
        'independent-destination',
        'source-unchanged',
        'cleanup-checkpoint',
        'cleanup-environment',
      ],
      observations: { fork: {} },
    })
  return proofReceipt({
    ...common,
    operation: PROOF_OPERATIONS.tangleConfidential,
    runIds: ['run-live-10'],
    environmentId: 'environment-live-10',
    materializationDigest: 'materialization-live-10',
    facts: {
      sourceProviderEnvironmentId: 'provider-source',
      destinationProviderEnvironmentId: 'provider-destination',
      capabilityAdvertised: true,
      capabilityConsistent: true,
      confidentialRequested: true,
      confidentialVerified: true,
      confidentialActionRefused: false,
      noOrdinaryPlacementDowngrade: true,
      noChildOrCheckpointCreated: false,
      missingAttestationRejected: true,
      wrongNonceRejected: true,
      wrongMeasurementRejected: true,
      selfEchoRejected: true,
      activeResourceDelta: 0,
      cleanupCheckpoint: 'deleted',
      cleanupEnvironment: 'deleted',
    },
    checks: [
      'configuration',
      'capability',
      'nitro-attestation',
      'requested-unverified-binding',
      'missing-attestation',
      'valid-attestation',
      'wrong-nonce',
      'wrong-measurement',
      'self-echo',
      'resource-census',
      'cleanup',
    ],
    observations: {
      capability: {
        providerBranchingConfidential: true,
        sourceBranchingConfidential: true,
        consistent: true,
      },
      attestation: {
        providerKeyAuthenticated: true,
        signatureDistinctFromQuote: true,
        requestedUnverifiedBeforeExecution: true,
        wrongNonceRejected: true,
        wrongMeasurementRejected: true,
        selfEchoRejected: true,
      },
      resourceCensus: {
        before: { count: 0, ids: [], resources: [] },
        after: { count: 0, ids: [], resources: [] },
        activeResourceDelta: 0,
        unchanged: true,
      },
    },
  })
}

function logFor(bytes) {
  return {
    rawByteLength: bytes.length,
    redactedSha256: sha256(bytes),
    redactedByteLength: bytes.length,
    redactedTruncated: false,
    redactionFailClosed: false,
  }
}

function releaseCheck({ id, cwd, environmentId, identity, stdout, stderr, evidenceIds = [] }) {
  const measurementName = id === 'live-tangle' ? 'LIVE-10' : id
  const stdoutId = `check-${id}-attempt-1-stdout`
  const stderrId = `check-${id}-attempt-1-stderr`
  return {
    check: {
      id,
      category: 'live',
      required: true,
      command: 'pnpm test:live:tangle',
      cwd,
      environment: environmentId,
      startedAt: TIMESTAMP_START,
      completedAt: TIMESTAMP_FINISH,
      durationMs: 1_000,
      attempt: 1,
      exitCode: 0,
      result: 'passed',
      buildSha256: identity.tarballSha256,
      measurements: [{ kind: 'scalar', name: measurementName, unit: 'verified-flow', value: 1 }],
      stdout: { artifactId: stdoutId, sha256: sha256(stdout) },
      stderr: { artifactId: stderrId, sha256: sha256(stderr) },
      failureDetails: null,
      argv: ['pnpm', 'test:live:tangle'],
      environmentSnapshot: { variables: [], omittedCount: 0 },
      boundary: {
        schemaVersion: 1,
        shell: false,
        cwd,
        processTreeStrategy: 'fixture',
        cleanupConfirmed: true,
        tarballSha256: identity.tarballSha256,
        gitCommit: identity.gitCommit,
        dependencyDigest: identity.dependencyDigest,
        requirementIds: ['LIVE-10'],
      },
      binding: bindingForCheck(identity, ['LIVE-10']),
      logs: { stdout: logFor(stdout), stderr: logFor(stderr) },
    },
    artifacts: [
      {
        id: stdoutId,
        path: `live/tangle/${id.toLowerCase()}.stdout`,
        sha256: sha256(stdout),
        mediaType: 'text/plain; charset=utf-8',
      },
      {
        id: stderrId,
        path: `live/tangle/${id.toLowerCase()}.stderr`,
        sha256: sha256(stderr),
        mediaType: 'text/plain; charset=utf-8',
      },
      ...evidenceIds,
    ],
  }
}

async function createBundle() {
  const repository = await mkdtemp(join(tmpdir(), 'braid-publish-gate-repo-'))
  const candidateRoot = await mkdtemp(join(tmpdir(), 'braid-publish-gate-candidate-'))
  const liveEvidenceRoot = await mkdtemp(join(tmpdir(), 'braid-publish-gate-live-'))
  const packageJson = {
    name: '@example/braid',
    version: '1.0.0',
    packageManager: 'pnpm@11.24.0',
    dependencies: { '@tangle-network/agent-runtime': '0.185.2' },
  }
  await mkdir(join(repository, 'docs'), { recursive: true })
  await writeFile(join(repository, 'package.json'), `${JSON.stringify(packageJson)}\n`)
  await writeFile(
    join(repository, 'pnpm-lock.yaml'),
    `lockfileVersion: '9.0'\n\npackages:\n  '@tangle-network/agent-runtime@0.185.2':\n    resolution: {integrity: ${RUNTIME_INTEGRITY}}\n`,
  )
  await writeFile(
    join(repository, 'docs', 'requirements.md'),
    '## Required live matrix\n\n| LIVE-10 | Confidential Tangle path |\n',
  )
  await mkdir(join(repository, 'release'), { recursive: true })
  await writeFile(
    join(repository, 'release', 'requirement-bindings.json'),
    `${JSON.stringify({
      'LIVE-10': {
        checks: ['live-tangle', 'LIVE-06', 'LIVE-07', 'LIVE-08', 'LIVE-09', 'LIVE-10'],
        artifacts: ['package-tarball', 'package-proof'],
      },
    })}\n`,
  )
  git(repository, 'init', '-q')
  git(repository, 'add', '.')
  git(repository, 'commit', '-qm', 'fixture')

  const packedPackageJson = { ...packageJson }
  delete packedPackageJson.packageManager
  const packageJsonBytes = Buffer.from(`${JSON.stringify(packedPackageJson)}\n`)
  const tarballBytes = tarArchive([
    { name: 'package/', type: 'directory' },
    { name: 'package/package.json', body: packageJsonBytes },
    { name: 'package/index.js', body: Buffer.from('export const ok = true\n') },
  ])
  const packageManifest = packageFileManifestFromTarball(tarballBytes)
  const proof = {
    tarball: TARBALL_NAME,
    sha256: sha256(tarballBytes),
    version: packageJson.version,
    gitCommit: git(repository, 'rev-parse', 'HEAD'),
    treeSha256: git(repository, 'rev-parse', 'HEAD^{tree}'),
    sourceDigest: await sourceDigest(repository),
    isolatedBuild: true,
    sourceCheckout: 'isolated-copy-of-worktree',
    packageFileManifest: packageManifest,
  }
  await mkdir(join(candidateRoot, 'candidate'), { recursive: true })
  await mkdir(join(candidateRoot, 'w6'), { recursive: true })
  await writeFile(join(candidateRoot, 'candidate', TARBALL_NAME), tarballBytes)
  await writeFile(join(candidateRoot, 'w6', 'package-proof.json'), `${JSON.stringify(proof)}\n`)
  for (const directory of ['candidate', 'w6'])
    await cp(join(candidateRoot, directory), join(liveEvidenceRoot, directory), { recursive: true })

  const { identity } = await readCandidateIdentity({
    repository,
    artifactRoot: candidateRoot,
    expectedCommit: proof.gitCommit,
    expectedVersion: proof.version,
  })
  const releaseBinding = serializedLiveEvidenceBinding(identity)
  const rawMultirun = multirunProof(JSON.parse(releaseBinding))
  const bindingEnvironment = {
    BRAID_RELEASE_LIVE_EVIDENCE_BINDING: releaseBinding,
  }
  const receipts = tangleReceiptsArtifact([
    ...['LIVE-06', 'LIVE-07', 'LIVE-08', 'LIVE-09', 'LIVE-10'].map((row) => ({
      row,
      status: 'passed',
      evidence: proofReceiptForRow(row, bindingEnvironment, rawMultirun),
    })),
  ])
  await mkdir(join(liveEvidenceRoot, 'live', 'tangle'), { recursive: true })
  const rawBytes = Buffer.from(`${JSON.stringify(rawMultirun)}\n`)
  const receiptBytes = Buffer.from(`${JSON.stringify(receipts)}\n`)
  await writeFile(join(liveEvidenceRoot, 'live', 'tangle', 'evidence.json'), rawBytes)
  await writeFile(join(liveEvidenceRoot, 'live', 'tangle', 'receipts.json'), receiptBytes)
  const tangleRows = ['LIVE-06', 'LIVE-07', 'LIVE-08', 'LIVE-09', 'LIVE-10']
  const requirementChecks = ['live-tangle', ...tangleRows]
  const checks = []
  const environments = []
  const artifacts = [
    {
      id: 'package-tarball',
      path: `candidate/${TARBALL_NAME}`,
      sha256: identity.tarballSha256,
      mediaType: 'application/gzip',
    },
    {
      id: 'package-proof',
      path: 'w6/package-proof.json',
      sha256: sha256(Buffer.from(`${JSON.stringify(proof)}\n`)),
      mediaType: 'application/json',
    },
  ]
  const checkEvidence = new Map()
  for (const row of tangleRows) {
    const stdoutBytes = Buffer.from(
      `BRAID_RELEASE_RESULT_JSON={"status":"passed"}\nBRAID_RELEASE_MEASUREMENTS_JSON=${JSON.stringify({ measurements: [{ kind: 'scalar', name: row, unit: 'verified-flow', value: 1 }] })}\n`,
    )
    const stderrBytes = Buffer.alloc(0)
    const environmentId = `environment-${row}`
    const evidenceIds =
      row === 'LIVE-10'
        ? [
            {
              id: 'check-LIVE-10-attempt-1-evidence-live-07',
              path: 'live/tangle/evidence.json',
              sha256: sha256(rawBytes),
              mediaType: 'application/json',
            },
            {
              id: 'check-LIVE-10-attempt-1-evidence-receipts',
              path: 'live/tangle/receipts.json',
              sha256: sha256(receiptBytes),
              mediaType: 'application/json',
            },
          ]
        : [
            {
              id: `check-${row}-attempt-1-evidence-receipts`,
              path: 'live/tangle/receipts.json',
              sha256: sha256(receiptBytes),
              mediaType: 'application/json',
            },
          ]
    const record = releaseCheck({
      id: row,
      cwd: repository,
      environmentId,
      identity,
      stdout: stdoutBytes,
      stderr: stderrBytes,
      evidenceIds,
    })
    await writeFile(join(liveEvidenceRoot, `live/tangle/${row.toLowerCase()}.stdout`), stdoutBytes)
    await writeFile(join(liveEvidenceRoot, `live/tangle/${row.toLowerCase()}.stderr`), stderrBytes)
    checks.push(record.check)
    artifacts.push(...record.artifacts)
    checkEvidence.set(row, evidenceIds)
    environments.push({ id: environmentId, kind: 'child-process', details: {} })
  }
  const aggregateStdout = Buffer.from(
    `BRAID_RELEASE_RESULT_JSON={"status":"passed"}\nBRAID_RELEASE_MEASUREMENTS_JSON=${JSON.stringify({ measurements: [{ kind: 'scalar', name: 'LIVE-10', unit: 'verified-flow', value: 1 }] })}\n`,
  )
  const aggregateStderr = Buffer.alloc(0)
  const aggregateEvidenceIds = [
    {
      id: 'check-live-tangle-attempt-1-evidence-receipts',
      path: 'live/tangle/receipts.json',
      sha256: sha256(receiptBytes),
      mediaType: 'application/json',
    },
  ]
  const aggregateRecord = releaseCheck({
    id: 'live-tangle',
    cwd: repository,
    environmentId: 'environment-live-tangle',
    identity,
    stdout: aggregateStdout,
    stderr: aggregateStderr,
    evidenceIds: aggregateEvidenceIds,
  })
  await writeFile(join(liveEvidenceRoot, 'live/tangle/live-tangle.stdout'), aggregateStdout)
  await writeFile(join(liveEvidenceRoot, 'live/tangle/live-tangle.stderr'), aggregateStderr)
  checks.push(aggregateRecord.check)
  artifacts.push(...aggregateRecord.artifacts)
  checkEvidence.set('live-tangle', aggregateEvidenceIds)
  environments.push({ id: 'environment-live-tangle', kind: 'child-process', details: {} })
  const requirementArtifacts = [
    'package-tarball',
    'package-proof',
    ...requirementChecks.flatMap((id) => {
      const check = checks.find(({ id: candidate }) => candidate === id)
      return [
        check.stdout.artifactId,
        check.stderr.artifactId,
        ...checkEvidence.get(id).map(({ id: artifactId }) => artifactId),
      ]
    }),
  ]
  const envelope = {
    schemaVersion: 1,
    braidVersion: identity.braidVersion,
    gitCommit: identity.gitCommit,
    packageIntegrity: identity.packageIntegrity,
    startedAt: TIMESTAMP_START,
    finishedAt: TIMESTAMP_FINISH,
    sourceState: {
      clean: true,
      commit: identity.gitCommit,
      treeSha256: identity.treeSha256,
      tarballSha256: identity.tarballSha256,
      tarballArtifactId: 'package-tarball',
    },
    dependencies: identity.dependencies,
    environments,
    checks,
    requirements: {
      'LIVE-10': {
        checks: requirementChecks,
        artifacts: requirementArtifacts,
      },
    },
    artifacts,
    liveResources: [],
    cleanup: [],
    signatures: [],
  }
  const checksBytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`)
  await mkdir(join(liveEvidenceRoot, 'release'), { recursive: true })
  await writeFile(join(liveEvidenceRoot, 'release', 'checks.json'), checksBytes)
  await writeFile(
    join(liveEvidenceRoot, 'release', 'collection-manifest.json'),
    `${JSON.stringify({
      schema: 'braid.release-collection.v1',
      schemaVersion: 1,
      braidVersion: identity.braidVersion,
      gitCommit: identity.gitCommit,
      gitTree: identity.gitTree,
      treeSha256: identity.treeSha256,
      tarballSha256: identity.tarballSha256,
      packageIntegrity: identity.packageIntegrity,
      packageFileManifestDigest: identity.packageFileManifestDigest,
      dependencyDigest: identity.dependencyDigest,
      requirementIds: ['LIVE-10'],
      checkIds: ['live-tangle', 'LIVE-06', 'LIVE-07', 'LIVE-08', 'LIVE-09', 'LIVE-10'],
      checkCount: checks.length,
      result: 'passed',
      startedAt: TIMESTAMP_START,
      finishedAt: TIMESTAMP_FINISH,
      checksPath: 'release/checks.json',
      checksSha256: sha256(checksBytes),
      signatures: [],
    })}\n`,
  )
  return {
    repository,
    candidateRoot,
    liveEvidenceRoot,
    identity,
    async close() {
      await Promise.all([
        rm(repository, { recursive: true, force: true }),
        rm(candidateRoot, { recursive: true, force: true }),
        rm(liveEvidenceRoot, { recursive: true, force: true }),
      ])
    },
  }
}

async function rewriteChecks(fixture, update) {
  const checksPath = join(fixture.liveEvidenceRoot, 'release', 'checks.json')
  const manifestPath = join(fixture.liveEvidenceRoot, 'release', 'collection-manifest.json')
  const envelope = JSON.parse(await readFile(checksPath, 'utf8'))
  await update(envelope)
  const checksBytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`)
  await writeFile(checksPath, checksBytes)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.checksSha256 = sha256(checksBytes)
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
}

async function assertRejected(mutate, pattern) {
  const fixture = await createBundle()
  try {
    await mutate(fixture)
    await assert.rejects(
      () =>
        verifyLive10Candidate({
          repository: fixture.repository,
          candidateRoot: fixture.candidateRoot,
          liveEvidenceRoot: fixture.liveEvidenceRoot,
          expectedCommit: fixture.identity.gitCommit,
          expectedVersion: fixture.identity.braidVersion,
        }),
      pattern,
    )
  } finally {
    await fixture.close()
  }
}

test('publish gate accepts and rejects stale or tampered candidate-bound live evidence', async () => {
  const fixture = await createBundle()
  try {
    const result = await verifyLive10Candidate({
      repository: fixture.repository,
      candidateRoot: fixture.candidateRoot,
      liveEvidenceRoot: fixture.liveEvidenceRoot,
      expectedCommit: fixture.identity.gitCommit,
      expectedVersion: fixture.identity.braidVersion,
    })
    assert.equal(result.check.id, 'LIVE-10')
  } finally {
    await fixture.close()
  }

  await assertRejected(async (fixture) => {
    const path = join(fixture.liveEvidenceRoot, 'w6', 'package-proof.json')
    const proof = JSON.parse(await readFile(path, 'utf8'))
    proof.gitCommit = 'c'.repeat(40)
    await writeFile(path, `${JSON.stringify(proof)}\n`)
  }, /Package proof was built from another Git commit/u)
  await assertRejected(async (fixture) => {
    const path = join(fixture.liveEvidenceRoot, 'candidate', TARBALL_NAME)
    await writeFile(path, Buffer.from('tampered candidate'))
  }, /Package proof tarball digest differs/u)
  await assertRejected(async (fixture) => {
    const path = join(fixture.liveEvidenceRoot, 'live', 'tangle', 'receipts.json')
    const receipts = JSON.parse(await readFile(path, 'utf8'))
    receipts.flows.find(({ row }) => row === 'LIVE-10').evidence.releaseBinding.runtimeVersion =
      '0.185.1'
    const bytes = Buffer.from(`${JSON.stringify(receipts)}\n`)
    await writeFile(path, bytes)
    await rewriteChecks(fixture, (envelope) => {
      for (const artifact of envelope.artifacts)
        if (artifact.path === 'live/tangle/receipts.json') artifact.sha256 = sha256(bytes)
    })
  }, /runtimeVersion|differs from the candidate identity/u)
  await assertRejected(async (fixture) => {
    await rewriteChecks(fixture, (envelope) => {
      envelope.checks = []
    })
  }, /Live manifest check count differs/u)
  await assertRejected(async (fixture) => {
    const path = join(fixture.liveEvidenceRoot, 'release', 'collection-manifest.json')
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    manifest.checkIds.push('FORGED-CHECK')
    await writeFile(path, `${JSON.stringify(manifest)}\n`)
  }, /Live manifest check IDs differ from the release evidence/u)
  await assertRejected(async (fixture) => {
    await rewriteChecks(fixture, (envelope) => {
      envelope.checks.find(({ id }) => id === 'LIVE-09').boundary.gitCommit = 'e'.repeat(40)
    })
  }, /Check LIVE-09 boundary commit differs/u)
  await assertRejected(async (fixture) => {
    const path = join(fixture.liveEvidenceRoot, 'live', 'tangle', 'receipts.json')
    const receipts = JSON.parse(await readFile(path, 'utf8'))
    receipts.flows.find(({ row }) => row === 'LIVE-10').status = 'failed'
    await writeFile(path, `${JSON.stringify(receipts)}\n`)
  }, /Artifact .* changed|LIVE-10 receipt artifact digest changed/u)
  await assertRejected(async (fixture) => {
    const path = join(fixture.liveEvidenceRoot, 'live', 'tangle', 'receipts.json')
    const receipts = JSON.parse(await readFile(path, 'utf8'))
    receipts.flows.find(({ row }) => row === 'LIVE-09').status = 'unavailable'
    receipts.flows.find(({ row }) => row === 'LIVE-09').evidence = undefined
    receipts.flows.find(({ row }) => row === 'LIVE-09').reason = 'fixture unavailable'
    const bytes = Buffer.from(`${JSON.stringify(receipts)}\n`)
    await writeFile(path, bytes)
    await rewriteChecks(fixture, (envelope) => {
      for (const artifact of envelope.artifacts)
        if (artifact.path === 'live/tangle/receipts.json') artifact.sha256 = sha256(bytes)
    })
  }, /LIVE-09 receipt did not pass/u)
  await assertRejected(async (fixture) => {
    const path = join(fixture.liveEvidenceRoot, 'live', 'tangle', 'evidence.json')
    const proof = JSON.parse(await readFile(path, 'utf8'))
    proof.releaseBinding.gitCommit = 'd'.repeat(40)
    const bytes = Buffer.from(`${JSON.stringify(proof)}\n`)
    await writeFile(path, bytes)
    await rewriteChecks(fixture, (envelope) => {
      envelope.artifacts.find(({ id }) => id.endsWith('evidence-live-07')).sha256 = sha256(bytes)
    })
  }, /LIVE-07 multirun evidence|differs from the candidate identity/u)
})
