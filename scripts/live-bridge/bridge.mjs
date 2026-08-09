import { access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pnpmInvocation } from '../release/platform.mjs'
import { StreamingRedactor } from './capture.mjs'
import { exitCodes } from './constants.mjs'
import {
  healthBackendsReady,
  healthIsStructurallyValid,
  modelIds,
  requestJson,
} from './endpoint.mjs'
import { LiveBridgeError } from './errors.mjs'
import { managedSpawn, sleep, terminateProcess } from './process.mjs'
import { redactString } from './redaction.mjs'

export function bridgeSourceDirectory(repository, configuredDirectory) {
  return resolve(configuredDirectory ?? join(repository, '..', 'cli-bridge'))
}

export function bridgeLaunchEnvironment(
  definitions,
  endpoint,
  { environment = process.env, platform = process.platform } = {},
) {
  const childEnv = { ...environment }
  if (childEnv.BRIDGE_BACKENDS === undefined) {
    childEnv.BRIDGE_BACKENDS = [...new Set(definitions.map(({ backend }) => backend))].join(',')
  }
  if (
    platform === 'linux' &&
    definitions.some(({ backend }) => backend === 'pi') &&
    childEnv.BRIDGE_JAIL_MODE === undefined &&
    childEnv.WORKER_FS_JAIL === undefined
  ) {
    childEnv.BRIDGE_JAIL_MODE = 'fs-jail'
  }
  const parsedEndpoint = new URL(endpoint)
  if (parsedEndpoint.port && childEnv.BRIDGE_PORT === undefined)
    childEnv.BRIDGE_PORT = parsedEndpoint.port
  return childEnv
}

export async function launchBridgeIfRequested(endpoint, token, evidence, repository, definitions) {
  const initialHealth = await requestJson(endpoint, '/health', token)
  evidence.initialHealth = initialHealth
  if (healthIsStructurallyValid(initialHealth)) return { health: initialHealth }
  if (initialHealth.status !== undefined) {
    throw new LiveBridgeError(
      'BRIDGE_NOT_READY',
      `CLI Bridge responded at ${endpoint} but is not fully ready; the driver will not start a second bridge`,
      exitCodes.unavailable,
      { health: initialHealth },
    )
  }
  if (process.env.BRAID_CLI_BRIDGE_START !== '1') {
    throw new LiveBridgeError(
      'BRIDGE_NOT_READY',
      `CLI Bridge is not ready at ${endpoint}; set BRAID_CLI_BRIDGE_START=1 to launch the local bridge explicitly`,
      exitCodes.unavailable,
      { health: initialHealth },
    )
  }
  const bridgeDirectory = bridgeSourceDirectory(repository, process.env.BRAID_CLI_BRIDGE_DIR)
  try {
    await access(join(bridgeDirectory, 'package.json'))
  } catch (error) {
    throw new LiveBridgeError(
      'BRIDGE_SOURCE_NOT_FOUND',
      `CLI Bridge launch directory is not available: ${bridgeDirectory}`,
      exitCodes.unavailable,
      { cause: error instanceof Error ? error.message : String(error) },
    )
  }
  const childEnv = bridgeLaunchEnvironment(definitions, endpoint)
  const pnpm = pnpmInvocation(['start'], { environment: childEnv })
  const child = await managedSpawn(pnpm.file, pnpm.args, {
    cwd: bridgeDirectory,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdoutCapture = new StreamingRedactor()
  const stderrCapture = new StreamingRedactor()
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => stdoutCapture.push(chunk))
  child.stderr.on('data', (chunk) => stderrCapture.push(chunk))
  let exited
  const exit = new Promise((resolveExit) => {
    let spawnError
    child.once('error', (error) => {
      spawnError = error instanceof Error ? error.message : String(error)
    })
    child.once('close', (code, signal) => resolveExit({ code, signal, error: spawnError }))
  })
  let stopPromise
  const stopChild = async () => {
    if (stopPromise !== undefined) return stopPromise
    stopPromise = (async () => {
      const processResult = {
        termination: await terminateProcess(child),
        exit: await Promise.race([exit, sleep(1_000).then(() => ({ timeout: true }))]),
        stdout: stdoutCapture.finish(),
        stderr: stderrCapture.finish(),
      }
      if (evidence.launch?.process !== undefined) {
        evidence.launch.process = { ...evidence.launch.process, ...processResult }
      }
      return processResult
    })()
    return stopPromise
  }
  const deadline = Date.now() + Number(process.env.BRAID_CLI_BRIDGE_START_TIMEOUT_MS ?? 30_000)
  let health = initialHealth
  while (Date.now() < deadline) {
    await sleep(250)
    health = await requestJson(endpoint, '/health', token)
    if (healthIsStructurallyValid(health)) break
    if (child.exitCode !== null || child.signalCode !== null) {
      exited = await Promise.race([exit, sleep(1_000).then(() => ({ timeout: true }))])
    }
    if (exited !== undefined) break
  }
  evidence.launch = {
    requested: true,
    directory: bridgeDirectory,
    command: 'pnpm start',
    health,
    process: {
      stdout: stdoutCapture.snapshot(),
      stderr: stderrCapture.snapshot(),
      exited,
    },
  }
  if (!healthIsStructurallyValid(health)) {
    evidence.launch.cleanup = { stopped: await stopChild() }
    throw new LiveBridgeError(
      'BRIDGE_START_FAILED',
      `CLI Bridge did not become ready at ${endpoint}`,
      exitCodes.unavailable,
      {
        health,
        process: {
          stdout: stdoutCapture.snapshot(),
          stderr: stderrCapture.snapshot(),
          exited,
        },
      },
    )
  }
  return {
    health,
    cleanup: stopChild,
  }
}

export async function discoverBridge(endpoint, token, evidence, repository, definitions) {
  const bridge = await launchBridgeIfRequested(endpoint, token, evidence, repository, definitions)
  try {
    const modelsResponse = await requestJson(endpoint, '/v1/models', token)
    evidence.models = modelsResponse
    const ids = modelIds(modelsResponse)
    const selected = definitions
      .filter((definition) => ids.includes(definition.modelId))
      .map((definition) => ({
        definition,
        key: definition.key,
        modelId: definition.modelId,
        backend: definition.backend,
      }))
    const missing = definitions.filter((definition) => !ids.includes(definition.modelId))
    evidence.advertisedModels = ids
    evidence.missingTargets = missing.map(({ key, label, modelId, backend }) => ({
      key,
      label,
      modelId,
      backend,
    }))
    evidence.selectedTargets = selected.map(({ definition, modelId }) => ({
      key: definition.key,
      label: definition.label,
      modelId,
    }))
    if (missing.length > 0) {
      throw new LiveBridgeError(
        'TARGET_MODEL_NOT_ADVERTISED',
        `CLI Bridge does not advertise every required target: ${missing.map(({ modelId }) => modelId).join(', ')}`,
        exitCodes.unavailable,
        {
          requiredTargets: definitions.map(({ modelId }) => modelId),
          missingTargets: missing.map(({ modelId }) => modelId),
          advertisedModels: ids,
        },
      )
    }
    const health = await requestJson(endpoint, '/health', token)
    evidence.requiredHealth = health
    const unavailableBackends = selected.filter(
      (target) => !healthBackendsReady(health, [target.backend]),
    )
    if (unavailableBackends.length > 0) {
      throw new LiveBridgeError(
        'TARGET_BACKEND_NOT_READY',
        `CLI Bridge does not report every selected target backend ready: ${unavailableBackends.map((target) => target.modelId).join(', ')}`,
        exitCodes.unavailable,
        {
          targets: unavailableBackends.map((target) => target.modelId),
          health,
        },
      )
    }
    return { ...bridge, health, selected }
  } catch (error) {
    if (bridge.cleanup !== undefined) {
      try {
        evidence.discoveryCleanup = { stopped: await bridge.cleanup() }
      } catch (cleanupError) {
        evidence.discoveryCleanup = {
          stopped: false,
          error: redactString(
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          ),
        }
      }
    }
    throw error
  }
}
