import { join, relative } from 'node:path'
import { writeTargetConfig } from './config.mjs'
import { exitCodes } from './constants.mjs'
import { endpointForEvidence } from './endpoint.mjs'
import { LiveBridgeError } from './errors.mjs'
import { errorEvidence } from './evidence.mjs'
import { RpcSession } from './process.mjs'
import { classifyPackedStartup } from './protocol.mjs'
import { evidenceValue, redactString } from './redaction.mjs'
import {
  assertTargetSemantics,
  finishTarget,
  initializeTarget,
  runNormalTurn,
  verifyCancel,
  verifyInteraction,
  verifyReconnect,
} from './target-actions.mjs'

export async function executeTarget(
  binary,
  root,
  endpoint,
  providerCapabilities,
  target,
  credential,
  timeoutMs,
) {
  const config = await writeTargetConfig(root, endpoint, target, credential)
  const statePath = join(config.workspace, 'braid.sqlite')
  const env = {
    ...process.env,
    NO_COLOR: '1',
    NODE_NO_WARNINGS: '1',
    BRAID_STATE_PATH: statePath,
    XDG_DATA_HOME: join(config.workspace, '.xdg-data'),
    XDG_CONFIG_HOME: join(config.workspace, '.xdg-config'),
  }
  const session = await RpcSession.create(binary, config.workspace, env, timeoutMs)
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
  }
  try {
    await initializeTarget(session, result, classifyPackedStartup)
    const { finalRun, runId, terminal } = await runNormalTurn(session, result, target, timeoutMs)
    await verifyReconnect(session, result, runId, finalRun, providerCapabilities)
    await verifyCancel(session, result, target, finalRun, providerCapabilities)
    await verifyInteraction(session, result, providerCapabilities, terminal)
    assertTargetSemantics(result)
    await finishTarget(session, result)
    result.status = 'passed'
  } catch (error) {
    result.stderr = redactString(session.stderr)
    result.stdout = redactString(session.stdout)
    const normalizedError =
      error instanceof LiveBridgeError &&
      error.code === 'RPC_PROCESS_EXITED' &&
      /CREDENTIAL_STORE_UNAVAILABLE|operating-system credential facility|credential store/iu.test(
        session.stderr,
      )
        ? new LiveBridgeError(
            'CREDENTIAL_STORE_UNAVAILABLE',
            'The packed Braid production path cannot access its operating-system credential store',
            exitCodes.unavailable,
            { error, stderr: session.stderr },
          )
        : error
    result.error = errorEvidence(normalizedError)
    result.status =
      normalizedError instanceof LiveBridgeError &&
      normalizedError.exitCode === exitCodes.unavailable
        ? 'unavailable'
        : 'failed'
  } finally {
    result.stderr = redactString(session.stderr)
    result.stdout = redactString(session.stdout)
    const processResult = await session.close().catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    }))
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
    delete result.workspace
    delete result.targetKey
  }
  return evidenceValue(result)
}
