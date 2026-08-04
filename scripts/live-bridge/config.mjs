import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { exitCodes } from './constants.mjs'
import { bridgeAuthToken } from './endpoint.mjs'
import { LiveBridgeError } from './errors.mjs'
import { errorEvidence } from './evidence.mjs'
import { evidenceValue } from './redaction.mjs'

export async function installBridgeCredential(evidence, repository) {
  const token = bridgeAuthToken()
  if (token === undefined) return undefined
  const credentialId = `live-bridge-${randomUUID().replaceAll('-', '')}`
  const credentialRef = `cred:v1:${credentialId}`
  try {
    const module = await import(
      pathToFileURL(join(repository, 'dist', 'adapters', 'credentials', 'os.js')).href
    )
    const store = module.createOperatingSystemCredentialStore()
    await store.store({
      ref: credentialRef,
      value: Buffer.from(token),
      label: 'Braid live CLI Bridge smoke',
    })
    evidence.credentialState = { configured: true, stored: true, facility: process.platform }
    return { store, credentialRef, recordRef: credentialId }
  } catch (error) {
    throw new LiveBridgeError(
      'CREDENTIAL_STORE_UNAVAILABLE',
      'A bridge bearer token was provided, but Braid could not install it in the operating-system credential store',
      exitCodes.unavailable,
      { cause: error instanceof Error ? error.message : String(error) },
    )
  }
}

export async function probePackedAnalysisReadiness(installRoot, endpoint, modelId) {
  const distRoot = join(installRoot, 'node_modules', '@tangle-network', 'braid', 'dist')
  try {
    const [runnerModule, adapterModule] = await Promise.all([
      import(pathToFileURL(join(distRoot, 'adapters', 'analysis', 'python-runner.js')).href),
      import(
        pathToFileURL(join(distRoot, 'adapters', 'analysis', 'trace-analysis-adapter.js')).href
      ),
    ])
    const runner = await runnerModule.resolvePythonRunner()
    const profile = {
      name: `Braid live ${modelId}`,
      harness: modelId.split('/')[0],
      model: { default: modelId },
    }
    const connection = {
      id: 'connection-live-cli-bridge',
      kind: 'cli-bridge',
      name: 'Live local CLI Bridge',
      endpoint,
      providerOptions: { transport: 'local' },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      lastHealth: { status: 'unknown' },
    }
    const configuration = await adapterModule.createTraceAnalysisAdapter({ connection, profile })
    const unavailableStatuses = new Set([
      'missing-python',
      'missing-python-package',
      'missing-model',
      'missing-credential',
      'unsupported-connection',
      'unavailable',
    ])
    return {
      claim: 'packed-analysis-readiness-only',
      python: evidenceValue({
        status: runner.status,
        readiness: runner.status === 'ready' ? 'ready' : 'unavailable',
        command: runner.command,
        source: runner.source,
        message: runner.message,
      }),
      ask: evidenceValue({
        readiness:
          configuration.status === 'engine-configured'
            ? 'ready'
            : unavailableStatuses.has(configuration.status)
              ? 'unavailable'
              : 'probe-failed',
        status: configuration.status,
        diagnostics: configuration.diagnostics,
      }),
    }
  } catch (error) {
    return {
      claim: 'packed-analysis-readiness-only',
      python: { status: 'probe-failed' },
      ask: { status: 'probe-failed' },
      error: errorEvidence(error),
    }
  }
}

export async function loadProviderCapabilities(installRoot) {
  const module = await import(
    pathToFileURL(
      join(
        installRoot,
        'node_modules',
        '@tangle-network',
        'agent-provider-cli-bridge',
        'dist',
        'index.js',
      ),
    ).href
  )
  return module.defaultCliBridgeCapabilities()
}

export async function writeTargetConfig(root, endpoint, modelId, credential) {
  const key = modelId
    .replaceAll(/[^a-z0-9]+/giu, '-')
    .replace(/^-|-$/gu, '')
    .toLowerCase()
  const workspace = join(root, `workspace-${key}`)
  const configDirectory = join(workspace, '.braid')
  const profileDirectory = join(configDirectory, 'profiles')
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 })
  const profileFile = `profile-${key}.json`
  const profilePath = join(profileDirectory, profileFile)
  const harness = modelId.split('/')[0]
  const profile = {
    name: `Braid live ${modelId}`,
    description: 'Opt-in packed CLI Bridge smoke profile',
    version: '0.1.0',
    harness,
    model: { default: modelId, reasoningEffort: 'none' },
  }
  const connectionId = 'connection-live-cli-bridge'
  const now = new Date().toISOString()
  const connection = {
    id: connectionId,
    kind: 'cli-bridge',
    name: 'Live local CLI Bridge',
    endpoint,
    ...(credential === undefined ? {} : { credentialRef: credential.recordRef }),
    providerOptions: { transport: 'local' },
    createdAt: now,
    updatedAt: now,
    lastHealth: { status: 'healthy', checkedAt: now },
  }
  const configPath = join(configDirectory, 'config.json')
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 })
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        format: 'braid-startup-config',
        schemaVersion: 1,
        profile: `profiles/${profileFile}`,
        connectionId,
        connections: [connection],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
  return { workspace, configPath, profilePath, profile, connection, key }
}
