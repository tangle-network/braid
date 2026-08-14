import { exitCodes, liveReleaseProofOperations } from './constants.mjs'
import { LiveBridgeError } from './errors.mjs'
import { errorEvidence } from './evidence.mjs'
import { evidenceValue } from './redaction.mjs'
import {
  executeCrossRunnerHandoff,
  executeInteractiveProtocol,
  executeRestartReconciliation,
} from './release-operations.mjs'
import { assertUniqueRunIds } from './release-proof-validation.mjs'
import { executeTarget } from './target-flow.mjs'

export const RELEASE_PROOF_MEASUREMENT_UNIT = 'successful-packed-live-operation'

const REQUIREMENTS = Object.freeze({
  pi: 'LIVE-01',
  codexHandoff: 'LIVE-02',
  interactive: 'LIVE-03',
  restart: 'LIVE-04',
  runner: 'LIVE-05',
})

function targetForHarness(targets, harness) {
  return (targets ?? []).find((target) => target.definition.backend === harness)
}

function proofTarget(target, operationResult) {
  const proof = operationResult?.targetProof
  if (
    typeof target?.key !== 'string' ||
    proof?.key !== target.key ||
    proof?.route !== target.modelId ||
    typeof proof?.harness !== 'string' ||
    (proof?.provider !== undefined && typeof proof.provider !== 'string') ||
    typeof proof?.model !== 'string'
  )
    return undefined
  return {
    key: target.key,
    harness: proof.harness,
    ...(proof.provider === undefined ? {} : { provider: proof.provider }),
    model: proof.model,
  }
}

function targetRecordMatches(targetRecord, target, descriptor) {
  const proof = targetRecord?.targetProof
  return (
    targetRecord?.status === 'passed' &&
    proof?.key === target.key &&
    proof?.route === target.modelId &&
    proof?.harness === descriptor.harness &&
    proof?.provider === descriptor.provider &&
    proof?.model === descriptor.model
  )
}

function passedProof(requirementId, operation, target, operationResult, targetRecords, usedRunIds) {
  if (
    operationResult?.status !== 'passed' ||
    operationResult?.operationReceipt?.operation !== operation ||
    operationResult.operationReceipt.packed !== true ||
    operationResult.operationReceipt.status !== 'passed' ||
    operationResult.operationEvidence === undefined ||
    typeof operationResult.operationReceipt.runId !== 'string' ||
    operationResult.operationReceipt.runId.length === 0
  ) {
    throw new LiveBridgeError(
      'LIVE_RELEASE_OPERATION_EVIDENCE_MISSING',
      `${operation} did not return a passed packed operation receipt`,
      exitCodes.failed,
      { requirementId, operation },
    )
  }
  const descriptor = proofTarget(target, operationResult)
  if (descriptor === undefined) {
    throw new LiveBridgeError(
      'LIVE_RELEASE_TARGET_RECEIPT_MISSING',
      `${operation} did not return a profile receipt for its target`,
      exitCodes.failed,
      { requirementId, operation },
    )
  }
  if (!targetRecords.some((record) => targetRecordMatches(record, target, descriptor))) {
    throw new LiveBridgeError(
      'LIVE_RELEASE_TARGET_NOT_RETAINED',
      `${operation} target has no matching passed packed target receipt`,
      exitCodes.failed,
      { requirementId, operation, target: descriptor },
    )
  }
  const runIds = assertUniqueRunIds(
    operationResult.runIds ?? [operationResult.operationReceipt.runId],
    usedRunIds,
    operation,
  )
  if (!runIds.includes(operationResult.operationReceipt.runId))
    throw new LiveBridgeError(
      'LIVE_RELEASE_RUN_ID_MISSING',
      `${operation} did not include its receipt run ID`,
      exitCodes.failed,
      { requirementId, operation },
    )
  return {
    requirementId,
    operation,
    target: descriptor,
    status: 'passed',
    packed: true,
    runId: operationResult.operationReceipt.runId,
    measurement: {
      kind: 'scalar',
      name: requirementId,
      unit: RELEASE_PROOF_MEASUREMENT_UNIT,
      value: 1,
    },
  }
}

function operationFailure(requirementId, operation, target, error) {
  const proofFailure =
    error instanceof LiveBridgeError &&
    (error.code.startsWith('LIVE_RELEASE_') || error.code === 'LIVE_CAPABILITY_CONTRADICTION')
  return {
    requirementId,
    operation,
    target:
      target === undefined
        ? undefined
        : {
            key: target.key,
            modelId: target.modelId,
            harness: target.definition.backend,
          },
    status: proofFailure
      ? 'failed'
      : error instanceof LiveBridgeError && error.exitCode === exitCodes.unavailable
        ? 'unavailable'
        : 'failed',
    error: errorEvidence(error),
  }
}

function missingTarget(requirementId, operation, harness, targets) {
  return operationFailure(
    requirementId,
    operation,
    undefined,
    new LiveBridgeError(
      'LIVE_RELEASE_TARGET_UNAVAILABLE',
      `${operation} requires an advertised ${harness} target`,
      exitCodes.unavailable,
      {
        harness,
        advertisedTargets: targets.map(({ key, modelId, backend }) => ({ key, modelId, backend })),
      },
    ),
  )
}

/**
 * Executes each strict release operation and emits no receipt for an operation
 * unless that operation returned its own packed run receipt.
 */
export async function executeReleaseProofs({
  binary,
  installRoot,
  root,
  endpoint,
  providerCapabilities,
  targets = [],
  targetRecords = [],
  token,
  timeoutMs,
} = {}) {
  const releaseProofs = []
  const releaseOperations = []
  const failures = []
  const usedRunIds = new Set()
  for (const record of targetRecords) {
    if (record?.status === 'passed')
      assertUniqueRunIds(
        record.runIds ?? [record.operationReceipt?.runId],
        usedRunIds,
        'target conformance',
      )
  }

  if (!Array.isArray(targets) || targets.length === 0) {
    const failure = missingTarget(
      REQUIREMENTS.runner,
      liveReleaseProofOperations.runner,
      'advertised runner',
      [],
    )
    releaseOperations.push(failure)
    failures.push(failure)
  }

  const execute = async (requirementId, operation, target, action) => {
    if (target === undefined) {
      const harness =
        operation === liveReleaseProofOperations.pi
          ? 'pi'
          : operation === liveReleaseProofOperations.codexHandoff
            ? 'codex'
            : 'advertised runner'
      const failure = missingTarget(requirementId, operation, harness, targets)
      releaseOperations.push(failure)
      failures.push(failure)
      return
    }
    try {
      const operationResult = await action(target)
      const proof = passedProof(
        requirementId,
        operation,
        target,
        operationResult,
        targetRecords,
        usedRunIds,
      )
      releaseProofs.push(proof)
      releaseOperations.push(
        evidenceValue({
          requirementId,
          operation,
          target: proof.target,
          status: 'passed',
          packed: true,
          runId: proof.runId,
          evidence: operationResult.operationEvidence,
        }),
      )
    } catch (error) {
      const failure = operationFailure(requirementId, operation, target, error)
      releaseOperations.push(failure)
      failures.push(failure)
    }
  }

  await execute(
    REQUIREMENTS.pi,
    liveReleaseProofOperations.pi,
    targetForHarness(targets, 'pi'),
    (target) =>
      executeTarget(
        binary,
        installRoot,
        root,
        endpoint,
        providerCapabilities,
        target,
        token,
        timeoutMs,
        {
          operation: liveReleaseProofOperations.pi,
          operationPrefix: 'pi-conformance',
          strict: true,
        },
      ),
  )

  const piTarget = targetForHarness(targets, 'pi')
  await execute(
    REQUIREMENTS.codexHandoff,
    liveReleaseProofOperations.codexHandoff,
    targetForHarness(targets, 'codex'),
    (target) =>
      executeCrossRunnerHandoff(
        binary,
        installRoot,
        root,
        endpoint,
        providerCapabilities,
        piTarget,
        target,
        token,
        timeoutMs,
      ),
  )

  const interactiveTarget = targets[0]
  await execute(
    REQUIREMENTS.interactive,
    liveReleaseProofOperations.interactive,
    interactiveTarget,
    (target) =>
      executeInteractiveProtocol(
        binary,
        installRoot,
        root,
        endpoint,
        providerCapabilities,
        target,
        token,
        timeoutMs,
      ),
  )

  const restartTarget = targets[0]
  await execute(REQUIREMENTS.restart, liveReleaseProofOperations.restart, restartTarget, (target) =>
    executeRestartReconciliation(
      binary,
      installRoot,
      root,
      endpoint,
      providerCapabilities,
      target,
      token,
      timeoutMs,
    ),
  )

  for (const target of targets) {
    await execute(REQUIREMENTS.runner, liveReleaseProofOperations.runner, target, (candidate) =>
      executeTarget(
        binary,
        installRoot,
        root,
        endpoint,
        providerCapabilities,
        candidate,
        token,
        timeoutMs,
        {
          operation: liveReleaseProofOperations.runner,
          operationPrefix: 'runner-conformance',
          strict: true,
        },
      ),
    )
  }

  return evidenceValue({
    releaseProofs,
    releaseOperations,
    failures,
    passed: failures.length === 0,
  })
}
