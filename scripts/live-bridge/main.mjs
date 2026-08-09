import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverBridge } from './bridge.mjs'
import {
  installBridgeCredential,
  loadProviderCapabilities,
  probePackedAnalysisReadiness,
} from './config.mjs'
import { defaultTimeoutMs, exitCodes, liveProofScope, repository } from './constants.mjs'
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
import { executeTarget } from './target-flow.mjs'
import { defaultTargetPolicy, readTargetPolicy, targetPolicyEvidence } from './target-policy.mjs'

function createEvidence(policy) {
  const rawEndpoint =
    process.env.BRAID_CLI_BRIDGE_URL ??
    process.env.CLI_BRIDGE_URL ??
    `http://127.0.0.1:${process.env.BRIDGE_PORT ?? '3344'}`
  return {
    schemaVersion: 1,
    command: 'pnpm test:live:bridge',
    scope: liveProofScope,
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

export async function main() {
  let policy = defaultTargetPolicy
  let policyError
  try {
    policy = readTargetPolicy()
  } catch (error) {
    policyError = error
  }
  const evidence = createEvidence(policy)
  let status = 'failed'
  let exitCode = exitCodes.failed
  let evidencePath
  let bridgeCleanup
  let credential
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
    const bridge = await discoverBridge(
      endpoint,
      token,
      bridgeEvidence,
      repository,
      policy.definitions,
    )
    bridgeCleanup = bridge.cleanup
    const selected = bridge.selected
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
      selected[0].modelId,
    )
    credential = await installBridgeCredential(evidence, repository)
    const targetRoot = await mkdtemp(join(tmpdir(), 'braid-live-targets-'))
    tempPaths.push(targetRoot)
    let firstTargetFailure
    for (const target of selected) {
      let targetEvidence
      try {
        targetEvidence = await executeTarget(
          packed.binary,
          targetRoot,
          endpoint,
          providerCapabilities,
          target,
          credential,
          Number(process.env.BRAID_LIVE_BRIDGE_TIMEOUT_MS ?? defaultTimeoutMs),
        )
      } catch (error) {
        targetEvidence = targetFailure(error, target)
      }
      evidence.targets.push(targetEvidence)
      if (targetEvidence.status !== 'passed' && firstTargetFailure === undefined)
        firstTargetFailure = targetEvidence
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
    if (credential !== undefined) {
      try {
        await credential.store.remove(credential.credentialRef)
        evidence.credentialState = { ...(evidence.credentialState ?? {}), removed: true }
      } catch (error) {
        evidence.credentialState = {
          ...(evidence.credentialState ?? {}),
          removed: false,
          error: errorEvidence(error),
        }
        if (status === 'passed') {
          status = 'failed'
          exitCode = exitCodes.failed
        }
      }
    }
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
  process.exitCode = exitCode
}
