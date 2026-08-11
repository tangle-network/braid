import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverBridge, releaseTargetDefinitions, selectBridgeTargets } from './bridge.mjs'
import { loadProviderCapabilities, probePackedAnalysisReadiness } from './config.mjs'
import {
  defaultTimeoutMs,
  exitCodes,
  liveProofScope,
  liveReleaseProofScope,
  repository,
} from './constants.mjs'
import {
  bridgeAuthToken,
  endpointForEvidence,
  isLoopback,
  safeEndpoint,
  unknownEndpointForEvidence,
} from './endpoint.mjs'
import { LiveBridgeError } from './errors.mjs'
import { errorEvidence, removeTemp, safeErrorMessage, writeEvidence } from './evidence.mjs'
import { buildPackedBinary } from './pack.mjs'
import { evidenceValue } from './redaction.mjs'
import { executeReleaseProofs } from './release-proofs.mjs'
import { executeTarget } from './target-flow.mjs'
import { defaultTargetPolicy, readTargetPolicy, targetPolicyEvidence } from './target-policy.mjs'

function createEvidence(policy, requireCompleteReleaseProof) {
  const rawEndpoint =
    process.env.BRAID_CLI_BRIDGE_URL ??
    process.env.CLI_BRIDGE_URL ??
    `http://127.0.0.1:${process.env.BRIDGE_PORT ?? '3344'}`
  return {
    schemaVersion: 1,
    command: requireCompleteReleaseProof
      ? 'pnpm test:live:bridge:release'
      : 'pnpm test:live:bridge',
    scope: requireCompleteReleaseProof ? liveReleaseProofScope : liveProofScope,
    optIn: process.env.BRAID_LIVE_BRIDGE === '1',
    startedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cwd: repository,
    },
    environment: {
      endpoint: unknownEndpointForEvidence(rawEndpoint),
      bearerConfigured: bridgeAuthToken() !== undefined,
      launchRequested: process.env.BRAID_CLI_BRIDGE_START === '1',
    },
    targetPolicy: targetPolicyEvidence(policy),
    targets: [],
    ...(requireCompleteReleaseProof ? { releaseProofs: [], releaseOperations: [] } : {}),
  }
}

function targetFailure(error, target) {
  const unavailable = error instanceof LiveBridgeError && error.exitCode === exitCodes.unavailable
  return {
    label: target.definition.label,
    target: target.modelId,
    status: unavailable ? 'unavailable' : 'failed',
    error: errorEvidence(error),
  }
}

function markCleanupFailure(evidence, label, details, setStatus) {
  const failure = errorEvidence(
    new LiveBridgeError(
      'CLEANUP_FAILED',
      `${label} did not provide complete bounded cleanup proof`,
      exitCodes.failed,
      details,
    ),
  )
  evidence.cleanupError = { label, ...failure }
  if (evidence.error === undefined) evidence.error = failure
  setStatus()
}

export async function main({ requireCompleteReleaseProof = false } = {}) {
  let policy = defaultTargetPolicy
  let policyError
  try {
    policy = readTargetPolicy()
  } catch (error) {
    policyError = error
  }
  const evidence = createEvidence(policy, requireCompleteReleaseProof)
  let status = 'failed'
  let exitCode = exitCodes.failed
  let evidencePath
  let bridgeCleanup
  const tempPaths = []
  try {
    if (policyError !== undefined) throw policyError
    if (!evidence.optIn) {
      throw new LiveBridgeError(
        'OPT_IN_REQUIRED',
        'Live CLI Bridge smoke is opt-in; set BRAID_LIVE_BRIDGE=1 to execute it',
        exitCodes.unavailable,
      )
    }
    const rawEndpoint =
      process.env.BRAID_CLI_BRIDGE_URL ??
      process.env.CLI_BRIDGE_URL ??
      `http://127.0.0.1:${process.env.BRIDGE_PORT ?? '3344'}`
    const endpoint = safeEndpoint(rawEndpoint)
    evidence.environment.endpoint = endpointForEvidence(endpoint)
    const token = bridgeAuthToken()
    if (!isLoopback(endpoint) && token === undefined) {
      throw new LiveBridgeError(
        'BRIDGE_CREDENTIAL_REQUIRED',
        'A non-loopback CLI Bridge endpoint requires BRAID_CLI_BRIDGE_BEARER for the secure packed configuration',
        exitCodes.unavailable,
      )
    }
    const bridgeEvidence = {}
    evidence.bridge = bridgeEvidence
    const launchDefinitions = requireCompleteReleaseProof
      ? [
          ...policy.definitions,
          { key: 'release-pi', label: 'release Pi runner', backend: 'pi' },
          { key: 'release-codex', label: 'release Codex runner', backend: 'codex' },
        ]
      : policy.definitions
    const bridge = await discoverBridge(
      endpoint,
      token,
      bridgeEvidence,
      repository,
      requireCompleteReleaseProof ? [] : policy.definitions,
      {
        launchDefinitions,
        requireDefinitions: !requireCompleteReleaseProof,
      },
    )
    bridgeCleanup = bridge.cleanup
    let selected = bridge.selected
    if (requireCompleteReleaseProof) {
      const releaseDefinitions = releaseTargetDefinitions(
        policy.definitions,
        bridgeEvidence.models,
        bridge.health,
      )
      if (releaseDefinitions.length === 0) {
        throw new LiveBridgeError(
          'LIVE_RELEASE_TARGETS_UNAVAILABLE',
          'The CLI Bridge advertised no ready runner with a usable model route',
          exitCodes.unavailable,
          { models: bridgeEvidence.models, health: bridge.health },
        )
      }
      selected = selectBridgeTargets(
        releaseDefinitions,
        bridgeEvidence.models,
        bridge.health,
        bridgeEvidence,
      )
      evidence.targetPolicy = targetPolicyEvidence({
        ...policy,
        source: `${policy.source}:release-runners`,
        definitions: releaseDefinitions,
      })
    }
    evidence.selectedTargets = bridgeEvidence.selectedTargets
    const packed = await buildPackedBinary(evidence, repository, (path) => tempPaths.push(path))
    const providerCapabilities = await loadProviderCapabilities(packed.installRoot)
    evidence.provider = {
      package: '@tangle-network/agent-provider-cli-bridge',
      capabilities: evidenceValue(providerCapabilities),
    }
    evidence.analysis = await probePackedAnalysisReadiness(
      packed.installRoot,
      endpoint,
      selected[0],
    )
    const targetRoot = await mkdtemp(join(tmpdir(), 'braid-live-targets-'))
    tempPaths.push(targetRoot)
    let firstTargetFailure
    for (const target of selected) {
      let targetEvidence
      try {
        targetEvidence = await executeTarget(
          packed.binary,
          packed.installRoot,
          targetRoot,
          endpoint,
          providerCapabilities,
          target,
          token,
          Number(process.env.BRAID_LIVE_BRIDGE_TIMEOUT_MS ?? defaultTimeoutMs),
          { strict: requireCompleteReleaseProof },
        )
      } catch (error) {
        targetEvidence = targetFailure(error, target)
      }
      evidence.targets.push(targetEvidence)
      if (targetEvidence.status !== 'passed' && firstTargetFailure === undefined)
        firstTargetFailure = targetEvidence
    }
    evidence.credentialState = {
      configured: token !== undefined,
      facility: token === undefined ? 'none' : 'encrypted-headless',
      targetCount: evidence.targets.length,
      storedCount: evidence.targets.filter((target) => target.credentialLifecycle?.stored === true)
        .length,
      removedCount: evidence.targets.filter(
        (target) => target.credentialLifecycle?.removed === true,
      ).length,
    }
    if (firstTargetFailure !== undefined) {
      throw new LiveBridgeError(
        firstTargetFailure.status === 'unavailable'
          ? 'LIVE_TARGET_UNAVAILABLE'
          : 'LIVE_TARGET_FAILED',
        `At least one packed live target was ${firstTargetFailure.status}`,
        firstTargetFailure.status === 'unavailable' ? exitCodes.unavailable : exitCodes.failed,
        { target: firstTargetFailure },
      )
    }
    if (requireCompleteReleaseProof) {
      const release = await executeReleaseProofs({
        binary: packed.binary,
        installRoot: packed.installRoot,
        root: targetRoot,
        endpoint,
        providerCapabilities,
        targets: selected,
        targetRecords: evidence.targets,
        token,
        timeoutMs: Number(process.env.BRAID_LIVE_BRIDGE_TIMEOUT_MS ?? defaultTimeoutMs),
      })
      evidence.releaseProofs = release.releaseProofs
      evidence.releaseOperations = release.releaseOperations
      if (release.passed !== true) {
        const unavailable = release.failures.some((failure) => failure.status === 'unavailable')
        throw new LiveBridgeError(
          'LIVE_RELEASE_PROOFS_INCOMPLETE',
          'At least one named packed release operation did not produce its own proof receipt',
          unavailable ? exitCodes.unavailable : exitCodes.failed,
          { failures: release.failures },
        )
      }
    }
    status = 'passed'
    exitCode = exitCodes.passed
  } catch (error) {
    status =
      error instanceof LiveBridgeError && error.exitCode === exitCodes.unavailable
        ? 'unavailable'
        : 'failed'
    exitCode = error instanceof LiveBridgeError ? error.exitCode : exitCodes.failed
    evidence.error = errorEvidence(error)
  } finally {
    if (bridgeCleanup !== undefined) {
      try {
        const cleanup = await bridgeCleanup()
        evidence.bridgeCleanup = { stopped: evidenceValue(cleanup) }
        if (
          cleanup?.termination?.exited !== true ||
          cleanup.termination.descendantsExited !== true ||
          cleanup.termination.descendantsVerified !== true
        ) {
          markCleanupFailure(evidence, 'CLI Bridge process', { cleanup }, () => {
            status = 'failed'
            exitCode = exitCodes.failed
          })
        }
      } catch (error) {
        evidence.bridgeCleanup = { stopped: false, error: errorEvidence(error) }
        markCleanupFailure(evidence, 'CLI Bridge process', { error }, () => {
          status = 'failed'
          exitCode = exitCodes.failed
        })
      }
    }
    try {
      const cleanup = await removeTemp(tempPaths)
      evidence.cleanup = evidenceValue(cleanup)
      if (cleanup.ok !== true) {
        markCleanupFailure(evidence, 'temporary directories', { cleanup }, () => {
          status = 'failed'
          exitCode = exitCodes.failed
        })
      }
    } catch (error) {
      evidence.cleanup = { ok: false, error: errorEvidence(error) }
      markCleanupFailure(evidence, 'temporary directories', { error }, () => {
        status = 'failed'
        exitCode = exitCodes.failed
      })
    }
    evidence.status = status
    evidence.exitCode = exitCode
    evidence.finishedAt = new Date().toISOString()
    if (evidence.optIn || process.env.BRAID_LIVE_BRIDGE_EVIDENCE !== undefined) {
      try {
        evidencePath = await writeEvidence(evidence)
      } catch (error) {
        evidencePath = undefined
        process.stderr.write(`could not write live bridge evidence: ${safeErrorMessage(error)}\n`)
        status = 'failed'
        exitCode = exitCodes.failed
      }
    }
  }
  const summary = {
    status,
    exitCode,
    scope: evidence.scope.name,
    selectedTargets: evidence.selectedTargets ?? [],
    evidence: evidencePath,
    error:
      evidence.error === undefined
        ? undefined
        : {
            code: evidence.error.code,
            message: evidence.error.message,
            exitCode: evidence.error.exitCode,
          },
  }
  process.stdout.write(`${JSON.stringify(evidenceValue(summary))}\n`)
  process.stdout.write(
    `BRAID_RELEASE_RESULT_JSON=${JSON.stringify({
      status,
      ...(status === 'passed'
        ? {}
        : { reason: evidence.error?.code ?? 'live bridge check did not pass' }),
    })}\n`,
  )
  if (status === 'passed') {
    process.stdout.write(
      `BRAID_RELEASE_MEASUREMENTS_JSON=${JSON.stringify({
        measurements: [
          {
            kind: 'scalar',
            name: 'live-bridge-targets',
            unit: 'count',
            value: evidence.targets.length,
          },
        ],
      })}\n`,
    )
  }
  process.exitCode = exitCode
}
