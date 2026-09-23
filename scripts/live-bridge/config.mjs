import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { harnessHonorsEffort, reasoningEffortsFor } from '@tangle-network/agent-interface'

import { exitCodes } from './constants.mjs'
import { LiveBridgeError } from './errors.mjs'
import { errorEvidence } from './evidence.mjs'
import { evidenceValue } from './redaction.mjs'

/**
 * The reasoning effort a live smoke profile pins for one target, or `undefined` to leave the
 * harness default in place.
 *
 * `default` is the Bridge sentinel for "the harness picks the model". Braid cannot know which
 * efforts that model accepts, and the harness-level set overstates it: Codex lists `none`, but
 * its current default model rejects `none`. The harness default is the only value that is valid
 * for whatever model it picks. A harness that drops the effort control gets no pin either.
 * Otherwise the profile pins the cheapest rung the shared capability data lists for the harness.
 */
export function liveReasoningEffort(harness, model) {
  if (model === 'default' || !harnessHonorsEffort(harness)) return undefined
  return reasoningEffortsFor(harness)[0]
}

export function profileForBridgeTarget(target) {
  const parts = target.modelId.split('/')
  const harness = parts.shift()
  const provider = parts.length > 1 ? parts.shift() : undefined
  const model = parts.join('/')
  if (
    harness !== target.backend ||
    provider === '' ||
    model.length === 0 ||
    parts.some((part) => part.length === 0)
  ) {
    throw new LiveBridgeError(
      'TARGET_MODEL_ROUTE_INVALID',
      `CLI Bridge target ${target.modelId} must be <runner>/<model> or <runner>/<provider>/<model> and agree with backend ${target.backend}`,
      exitCodes.unavailable,
      { target: target.modelId, backend: target.backend },
    )
  }
  const reasoningEffort = liveReasoningEffort(harness, model)
  return {
    name: `Braid live ${target.modelId}`,
    description: 'Opt-in packed CLI Bridge smoke profile',
    version: '0.1.0',
    harness,
    model: {
      ...(provider === undefined ? {} : { provider }),
      default: model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    },
  }
}

export function createLiveCredentialId(uuid = randomUUID()) {
  return `credential-live-bridge-${uuid.replaceAll('-', '')}`
}

export function createLiveCredentialReference() {
  const recordRef = createLiveCredentialId()
  return { recordRef, credentialRef: `cred:v1:${recordRef}` }
}

export async function installPackedTargetCredential(installRoot, config, credential, token) {
  let context
  try {
    const module = await import(
      pathToFileURL(
        join(
          installRoot,
          'node_modules',
          '@tangle-network',
          'braid',
          'dist',
          'bin',
          'production-credential-context.js',
        ),
      ).href
    )
    context = module.createProductionCredentialContext({
      workspace: config.workspace,
      configPath: config.configPath,
      databaseKeyFile: config.databaseKeyFile,
      dataDirectory: join(config.workspace, '.xdg-data', 'braid'),
    })
    if (context === undefined) throw new Error('headless credential context was not created')
    const secret = Buffer.from(token)
    try {
      await context.store.store({
        ref: credential.credentialRef,
        value: secret,
        label: 'Braid live CLI Bridge smoke',
      })
    } finally {
      secret.fill(0)
    }
    return {
      state: {
        configured: true,
        stored: true,
        facility: 'encrypted-headless',
      },
      cleanup: async () => {
        try {
          await context.store.remove(credential.credentialRef)
          return {
            configured: true,
            stored: true,
            removed: true,
            facility: 'encrypted-headless',
          }
        } finally {
          context.dispose()
        }
      },
    }
  } catch (error) {
    context?.dispose()
    throw new LiveBridgeError(
      'TARGET_CREDENTIAL_STORE_FAILED',
      'The packed Braid credential store could not prepare the live Bridge credential',
      exitCodes.failed,
      { cause: error instanceof Error ? error.message : String(error) },
    )
  }
}

export async function probePackedAnalysisReadiness(installRoot, endpoint, target) {
  const distRoot = join(installRoot, 'node_modules', '@tangle-network', 'braid', 'dist')
  try {
    const [runnerModule, adapterModule] = await Promise.all([
      import(pathToFileURL(join(distRoot, 'adapters', 'analysis', 'python-runner.js')).href),
      import(
        pathToFileURL(join(distRoot, 'adapters', 'analysis', 'trace-analysis-adapter.js')).href
      ),
    ])
    const runner = await runnerModule.resolvePythonRunner()
    const profile = profileForBridgeTarget(target)
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

export async function loadProviderCapabilities(installRoot, backend) {
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
  return module.defaultCliBridgeCapabilities(backend)
}

export async function writeTargetConfig(root, endpoint, target, credential) {
  const key = target.modelId
    .replaceAll(/[^a-z0-9]+/giu, '-')
    .replace(/^-|-$/gu, '')
    .toLowerCase()
  const operationNamespace = randomUUID()
  const workspace = join(root, `workspace-${key}-${operationNamespace}`)
  const configDirectory = join(workspace, '.braid')
  const profileDirectory = join(configDirectory, 'profiles')
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 })
  const profileFile = `profile-${key}.json`
  const profilePath = join(profileDirectory, profileFile)
  const profile = profileForBridgeTarget(target)
  const connectionId = 'connection-live-cli-bridge'
  const now = new Date().toISOString()
  const databaseKeyFile = join(root, `database-key-${key}-${operationNamespace}`)
  await writeFile(databaseKeyFile, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 })
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
        schemaVersion: 2,
        databaseKeyFile,
        profile: `profiles/${profileFile}`,
        connectionId,
        connections: [connection],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
  return {
    workspace,
    configPath,
    profilePath,
    profile,
    connection,
    key,
    operationNamespace,
    databaseKeyFile,
  }
}
