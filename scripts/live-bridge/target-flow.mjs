import { join, relative } from 'node:path'
import {
  createLiveCredentialReference,
  installPackedTargetCredential,
  profileForBridgeTarget,
  writeTargetConfig,
} from './config.mjs'
import { exitCodes } from './constants.mjs'
import { endpointForEvidence } from './endpoint.mjs'
import { LiveBridgeError } from './errors.mjs'
import { errorEvidence } from './evidence.mjs'
import { RpcSession, sleep } from './process.mjs'
import {
  classifyPackedStartup,
  requestBase,
  responseForRequest,
  runFromState,
  stateForRun,
} from './protocol.mjs'
import { evidenceValue, redactString, withoutBridgeSecrets } from './redaction.mjs'
import {
  assertObservedUsage,
  assertTargetRunIdentity,
  assertUniqueRunIds,
} from './release-proof-validation.mjs'
import {
  assertTargetSemantics,
  finishTarget,
  initializeTarget,
  runNormalTurn,
  verifyCancel,
  verifyInteraction,
} from './target-actions.mjs'

export async function executeTarget(
  binary,
  installRoot,
  root,
  endpoint,
  providerCapabilities,
  target,
  token,
  timeoutMs,
  { operation = 'cli-bridge.target-smoke', operationPrefix = 'live', strict = false } = {},
) {
  const credential = token === undefined ? undefined : createLiveCredentialReference()
  const config = await writeTargetConfig(root, endpoint, target, credential)
  const statePath = join(config.workspace, 'braid.sqlite')
  const env = {
    ...withoutBridgeSecrets(),
    NO_COLOR: '1',
    NODE_NO_WARNINGS: '1',
    BRAID_STATE_PATH: statePath,
    XDG_DATA_HOME: join(config.workspace, '.xdg-data'),
    XDG_CONFIG_HOME: join(config.workspace, '.xdg-config'),
  }
  let session
  let credentialInstallation
  const result = {
    targetKey: target.key,
    workspace: config.workspace,
    label: target.definition.label,
    target: target.modelId,
    profile: {
      path: relative(config.workspace, config.profilePath),
      harness: config.profile.harness,
      model: config.profile.model.default,
      provider: config.profile.model.provider,
    },
    connection: {
      id: config.connection.id,
      kind: config.connection.kind,
      endpoint: endpointForEvidence(config.connection.endpoint),
      credentialConfigured: credential !== undefined,
    },
    providerCapabilities: evidenceValue(providerCapabilities),
    requests: [],
    operation,
  }
  try {
    if (credential !== undefined) {
      credentialInstallation = await installPackedTargetCredential(
        installRoot,
        config,
        credential,
        token,
      )
      result.credentialLifecycle = credentialInstallation.state
    } else {
      result.credentialLifecycle = { configured: false, stored: false, removed: true }
    }
    session = await RpcSession.create(binary, config.workspace, env, timeoutMs)
    await initializeTarget(session, result, classifyPackedStartup)
    const { finalRun, runId, terminal } = await runNormalTurn(session, result, target, timeoutMs, {
      operationPrefix,
    })
    await verifyCancel(session, result, target, finalRun, providerCapabilities, {
      operationPrefix,
      timeoutMs,
    })
    await verifyInteraction(session, result, providerCapabilities, terminal, { operationPrefix })
    assertTargetSemantics(result, { strict })
    if (strict) {
      const targetProof = assertTargetRunIdentity(finalRun, target)
      assertObservedUsage(finalRun)
      result.targetProof = targetProof
      result.profile = {
        ...result.profile,
        harness: targetProof.harness,
        model: targetProof.model,
        provider: targetProof.provider,
      }
      result.runIds = assertUniqueRunIds(
        [runId, result.cancel?.runId, result.interaction?.runId],
        new Set(),
        operation,
      )
    }
    await finishTarget(session, result, { operationPrefix })
    result.operationEvidence = evidenceValue({
      normal: result.normal,
      cancel: result.cancel,
      interaction: result.interaction,
      targetProof: result.targetProof,
    })
    result.operationReceipt = {
      operation,
      packed: true,
      runId,
      status: 'passed',
    }
    result.status = 'passed'
  } catch (error) {
    const stderr = session?.stderr ?? ''
    const normalizedError =
      error instanceof LiveBridgeError &&
      error.code === 'RPC_PROCESS_EXITED' &&
      /CREDENTIAL_STORE_UNAVAILABLE|operating-system credential facility|credential store/iu.test(
        stderr,
      )
        ? new LiveBridgeError(
            'CREDENTIAL_STORE_UNAVAILABLE',
            'The packed Braid production path cannot access its configured credential store',
            exitCodes.unavailable,
            { error, stderr },
          )
        : error
    result.error = errorEvidence(normalizedError)
    result.status =
      normalizedError instanceof LiveBridgeError &&
      normalizedError.exitCode === exitCodes.unavailable
        ? 'unavailable'
        : 'failed'
  } finally {
    const processResult =
      session === undefined
        ? { started: false }
        : await session.close().catch((error) => ({
            error: error instanceof Error ? error.message : String(error),
          }))
    result.stderr = redactString(session?.stderr ?? '')
    result.stdout = redactString(session?.stdout ?? '')
    result.process = evidenceValue(processResult)
    const cleanShutdown =
      processResult.termination?.cleanupStatus === 'natural-exit' &&
      processResult.termination.termSent === false &&
      processResult.termination.killSent === false &&
      processResult.termination.exited === true &&
      processResult.termination.descendantsExited === true &&
      processResult.termination.descendantsVerified === true
    if (result.status === 'passed' && (!cleanShutdown || processResult.error !== undefined)) {
      result.status = 'failed'
      result.error = errorEvidence(
        new LiveBridgeError(
          'RPC_SHUTDOWN_TIMEOUT',
          'Packed Braid RPC did not exit cleanly after shutdown',
          exitCodes.failed,
          { process: processResult },
        ),
      )
    }
    if (credentialInstallation !== undefined) {
      try {
        result.credentialLifecycle = evidenceValue(await credentialInstallation.cleanup())
      } catch (error) {
        result.credentialLifecycle = {
          ...(result.credentialLifecycle ?? {}),
          removed: false,
          error: errorEvidence(error),
        }
        result.status = 'failed'
        result.credentialCleanupError = errorEvidence(
          new LiveBridgeError(
            'TARGET_CREDENTIAL_CLEANUP_FAILED',
            'The packed Braid live credential was not removed',
            exitCodes.failed,
            { cause: error instanceof Error ? error.message : String(error) },
          ),
        )
        if (result.error === undefined) result.error = result.credentialCleanupError
      }
    }
    delete result.workspace
    delete result.targetKey
  }
  return evidenceValue(result)
}

function targetResult(config, target, providerCapabilities, credential, operation) {
  return {
    targetKey: target.key,
    workspace: config.workspace,
    label: target.definition.label,
    target: target.modelId,
    profile: {
      path: relative(config.workspace, config.profilePath),
      harness: config.profile.harness,
      model: config.profile.model.default,
      provider: config.profile.model.provider,
    },
    connection: {
      id: config.connection.id,
      kind: config.connection.kind,
      endpoint: endpointForEvidence(config.connection.endpoint),
      credentialConfigured: credential !== undefined,
    },
    providerCapabilities: evidenceValue(providerCapabilities),
    requests: [],
    operation,
  }
}

function operationEnvironment(config) {
  return {
    ...withoutBridgeSecrets(),
    NO_COLOR: '1',
    NODE_NO_WARNINGS: '1',
    BRAID_STATE_PATH: join(config.workspace, 'braid.sqlite'),
    XDG_DATA_HOME: join(config.workspace, '.xdg-data'),
    XDG_CONFIG_HOME: join(config.workspace, '.xdg-config'),
  }
}

function normalizeOperationError(error, session) {
  if (
    error instanceof LiveBridgeError &&
    error.code === 'RPC_PROCESS_EXITED' &&
    /CREDENTIAL_STORE_UNAVAILABLE|operating-system credential facility|credential store/iu.test(
      session?.stderr ?? '',
    )
  ) {
    return new LiveBridgeError(
      'CREDENTIAL_STORE_UNAVAILABLE',
      'The packed Braid production path cannot access its configured credential store',
      exitCodes.unavailable,
      { error, stderr: session?.stderr ?? '' },
    )
  }
  return error
}

function cleanShutdown(processResult) {
  return (
    processResult?.termination?.cleanupStatus === 'natural-exit' &&
    processResult.termination.termSent === false &&
    processResult.termination.killSent === false &&
    processResult.termination.exited === true &&
    processResult.termination.descendantsExited === true &&
    processResult.termination.descendantsVerified === true
  )
}

export async function executeNamedOperation({
  binary,
  installRoot,
  root,
  endpoint,
  providerCapabilities,
  target,
  token,
  timeoutMs,
  operation,
  operationPrefix,
  execute,
}) {
  const credential = token === undefined ? undefined : createLiveCredentialReference()
  const config = await writeTargetConfig(root, endpoint, target, credential)
  const env = operationEnvironment(config)
  let session
  let credentialInstallation
  const result = targetResult(config, target, providerCapabilities, credential, operation)
  try {
    if (credential !== undefined) {
      credentialInstallation = await installPackedTargetCredential(
        installRoot,
        config,
        credential,
        token,
      )
      result.credentialLifecycle = credentialInstallation.state
    } else {
      result.credentialLifecycle = { configured: false, stored: false, removed: true }
    }
    session = await RpcSession.create(binary, config.workspace, env, timeoutMs)
    await initializeTarget(session, result, classifyPackedStartup, { operationPrefix })
    const operationResult = await execute({
      result,
      target,
      config,
      env,
      getSession: () => session,
      setSession: (nextSession) => {
        session = nextSession
      },
    })
    if (
      operationResult === undefined ||
      typeof operationResult.runId !== 'string' ||
      operationResult.runId.length === 0 ||
      operationResult.evidence === undefined
    ) {
      throw new LiveBridgeError(
        'LIVE_RELEASE_OPERATION_EVIDENCE_MISSING',
        `${operation} did not return its executed run ID and operation evidence`,
        exitCodes.failed,
      )
    }
    if (operationResult.targetProof === undefined)
      throw new LiveBridgeError(
        'LIVE_RELEASE_TARGET_RECEIPT_MISSING',
        `${operation} did not return an actual target receipt`,
        exitCodes.failed,
      )
    result.targetProof = operationResult.targetProof
    result.profile = {
      ...result.profile,
      harness: operationResult.targetProof.harness,
      model: operationResult.targetProof.model,
      provider: operationResult.targetProof.provider,
    }
    result.runIds = assertUniqueRunIds(
      operationResult.runIds ?? [operationResult.runId],
      new Set(),
      operation,
    )
    if (session === undefined) {
      throw new LiveBridgeError(
        'LIVE_RELEASE_SESSION_MISSING',
        `${operation} lost its replacement session before final cleanup`,
        exitCodes.failed,
      )
    }
    await finishTarget(session, result, { operationPrefix })
    result.operationEvidence = evidenceValue(operationResult.evidence)
    result.operationReceipt = {
      operation,
      packed: true,
      runId: operationResult.runId,
      status: 'passed',
    }
    result.status = 'passed'
  } catch (error) {
    const normalizedError = normalizeOperationError(error, session)
    result.error = errorEvidence(normalizedError)
    result.status =
      normalizedError instanceof LiveBridgeError &&
      normalizedError.exitCode === exitCodes.unavailable
        ? 'unavailable'
        : 'failed'
  } finally {
    const processResult =
      session === undefined
        ? { started: false }
        : await session.close().catch((error) => ({
            error: error instanceof Error ? error.message : String(error),
          }))
    result.stderr = redactString(session?.stderr ?? '')
    result.stdout = redactString(session?.stdout ?? '')
    result.process = evidenceValue(processResult)
    if (
      result.status === 'passed' &&
      (!cleanShutdown(processResult) || processResult.error !== undefined)
    ) {
      result.status = 'failed'
      result.error = errorEvidence(
        new LiveBridgeError(
          'RPC_SHUTDOWN_TIMEOUT',
          'Packed Braid RPC did not exit cleanly after the release operation',
          exitCodes.failed,
          { process: processResult },
        ),
      )
    }
    if (credentialInstallation !== undefined) {
      try {
        const lifecycle = evidenceValue(await credentialInstallation.cleanup())
        result.credentialLifecycle = lifecycle
        if (lifecycle.removed !== true) {
          const cleanupError = new LiveBridgeError(
            'TARGET_CREDENTIAL_CLEANUP_FAILED',
            'The packed Braid release credential was not removed',
            exitCodes.failed,
            { lifecycle },
          )
          result.status = 'failed'
          result.credentialCleanupError = errorEvidence(cleanupError)
          if (result.error === undefined) result.error = result.credentialCleanupError
        }
      } catch (error) {
        result.credentialLifecycle = {
          ...(result.credentialLifecycle ?? {}),
          removed: false,
          error: errorEvidence(error),
        }
        result.status = 'failed'
        result.credentialCleanupError = errorEvidence(
          new LiveBridgeError(
            'TARGET_CREDENTIAL_CLEANUP_FAILED',
            'The packed Braid release credential was not removed',
            exitCodes.failed,
            { cause: error instanceof Error ? error.message : String(error) },
          ),
        )
        if (result.error === undefined) result.error = result.credentialCleanupError
      }
    }
    delete result.workspace
    delete result.targetKey
  }
  return evidenceValue(result)
}

export function operationRequest(result, prefix, action, command, params, suffix) {
  const stem = `${prefix}-${action}${suffix === undefined ? '' : `-${suffix}`}-${result.targetKey}`
  return {
    ...requestBase(stem, command, command === 'get_state' ? undefined : `op-${stem}`),
    params,
  }
}

export async function sendOperationRequest(session, result, request, label, timeoutMs) {
  result.requests.push(evidenceValue(request))
  session.send(request)
  return await session.waitFor(label, responseForRequest(request.requestId), timeoutMs)
}

export async function admitOperationTurn(session, result, target, prefix, text, timeoutMs) {
  const send = operationRequest(result, prefix, 'send', 'send', {
    conversationId: result.conversationId,
    branchId: result.branchId,
    text,
  })
  const response = await sendOperationRequest(
    session,
    result,
    send,
    'release operation send acknowledgement',
    timeoutMs,
  )
  if (response.type === 'error' || typeof response.runId !== 'string') {
    throw new LiveBridgeError(
      'LIVE_RELEASE_SEND_FAILED',
      `Packed Braid did not admit the named ${target.definition.label} release operation`,
      exitCodes.failed,
      { response },
    )
  }
  return { send, response, runId: response.runId }
}

export async function operationState(session, result, prefix, suffix, timeoutMs) {
  const request = operationRequest(
    result,
    prefix,
    'state',
    'get_state',
    { projection: 'full' },
    suffix,
  )
  const response = await sendOperationRequest(
    session,
    result,
    request,
    'release operation state',
    Math.min(timeoutMs, 15_000),
  )
  if (response.type !== 'state') {
    throw new LiveBridgeError(
      'LIVE_RELEASE_STATE_INVALID',
      'Packed Braid did not return a state response for the release operation',
      exitCodes.failed,
      { response },
    )
  }
  return response
}

export async function terminalOperationState(session, result, prefix, runId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  while (Date.now() < deadline) {
    const response = await operationState(session, result, prefix, `poll-${attempt}`, timeoutMs)
    const run = runFromState(response.state, runId)
    if (run !== undefined && stateForRun(response, runId)) return { response, run }
    attempt += 1
    await sleep(Math.min(250, Math.max(25, deadline - Date.now())))
  }
  throw new LiveBridgeError(
    'LIVE_RELEASE_RUN_NOT_TERMINAL',
    `Packed Braid run ${runId} did not reach a terminal state during the named release operation`,
    exitCodes.failed,
    { runId, timeoutMs },
  )
}

export function providerSessionId(run) {
  return run?.providerSessionId ?? run?.receipt?.providerSessionId
}

export function applyTargetReceipt(result, config, target) {
  const profile = profileForBridgeTarget(target)
  result.targetKey = target.key
  result.label = target.definition.label
  result.target = target.modelId
  result.profile = {
    path: relative(config.workspace, config.profilePath),
    harness: profile.harness,
    model: profile.model.default,
    provider: profile.model.provider,
  }
}
