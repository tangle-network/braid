import { randomBytes, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { RpcSession } from '../live-bridge/process.mjs'
import {
  exactMarker,
  requestBase,
  runFromState,
  stateForRun,
  terminalMessage,
} from '../live-bridge/protocol.mjs'
import { endpointEvidence, protectedUnavailable, safeMessage } from './contracts.mjs'

const AUTH_ENVIRONMENT_NAMES = Object.freeze([
  'BRAID_ANALYSIS_AUTH',
  'BRAID_ANALYSIS_API_KEY',
  'BRAID_ANALYSIS_BEARER',
  'BRAID_CLI_BRIDGE_AUTH',
  'BRAID_CLI_BRIDGE_BEARER',
  'BRAID_TANGLE_AUTH',
  'BRAID_TANGLE_API_KEY',
  'BRAID_TANGLE_BEARER',
  'BRAID_TANGLE_SANDBOX_AUTH',
  'BRAID_TANGLE_SANDBOX_API_KEY',
  'BRAID_TANGLE_SANDBOX_BEARER',
])

function timestamp() {
  return new Date().toISOString()
}

function validCredentialId(value) {
  const candidate = value.startsWith('cred:v1:') ? value.slice('cred:v1:'.length) : value
  if (!/^(?:credential|credential-ref)-[A-Za-z0-9._~-]+$/u.test(candidate)) {
    throw protectedUnavailable(
      'PROTECTED_CREDENTIAL_REFERENCE_INVALID',
      'The supplied credential reference must be a Braid credential- or credential-ref- identifier',
    )
  }
  return candidate
}

function profileFor({ kind, model, runner, provider }) {
  return {
    name: `Braid live ${kind}`,
    description: 'Protected release flow profile',
    version: '1.0.0',
    harness: runner,
    model: { provider, default: model, reasoningEffort: 'none' },
    prompt: {
      instructions: ['Follow the release prompt exactly and return the requested marker.'],
    },
  }
}

function liveDataDirectory(root, platform = process.platform) {
  if (platform === 'win32') return join(root, 'AppData', 'Roaming', 'braid')
  if (platform === 'darwin') return join(root, 'Library', 'Application Support', 'braid')
  return join(root, '.xdg-data', 'braid')
}

function combineFailures(failures, message) {
  const present = failures.filter((failure) => failure !== undefined)
  if (present.length === 0) return undefined
  if (present.length === 1) return present[0]
  return new AggregateError(present, message)
}

function cleanupEvidence(credentialRemoved, temporaryRootRemoved) {
  return Object.freeze({ credentialRemoved, temporaryRootRemoved })
}

function withCleanupEvidence(error, evidence) {
  if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
    try {
      Object.defineProperty(error, 'cleanupEvidence', {
        configurable: true,
        enumerable: false,
        value: evidence,
      })
    } catch {}
  }
  return error
}

async function installGeneratedCredential({
  repository,
  workspace,
  configPath,
  databaseKeyFile,
  dataDirectory,
  credentialId,
  value,
  kind,
  createCredentialContext,
}) {
  let context
  let contextFactory
  const portRef = `cred:v1:${credentialId}`
  const secret = Buffer.from(value)
  const contextOptions = {
    workspace,
    configPath,
    databaseKeyFile,
    dataDirectory,
  }
  try {
    contextFactory =
      createCredentialContext ??
      (
        await import(
          pathToFileURL(
            join(resolve(repository, 'dist'), 'bin', 'production-credential-context.js'),
          ).href
        )
      ).createProductionCredentialContext

    const createContext = () => {
      const candidate = contextFactory(contextOptions)
      if (candidate === undefined)
        throw new Error('The protected credential context was not created')
      return candidate
    }

    context = createContext()
    await context.store.store({
      ref: portRef,
      value: secret,
      label: `Braid live ${kind} release check`,
    })
    let removed = false
    let removalPromise
    return {
      credentialId,
      remove: async () => {
        if (removed) return { credentialRemoved: true }
        if (removalPromise !== undefined) return removalPromise
        removalPromise = (async () => {
          let current
          let removalError
          let disposeError
          try {
            current = context ?? createContext()
            context = undefined
            await current.store.remove(portRef)
            removed = true
          } catch (error) {
            removalError = protectedUnavailable(
              'PROTECTED_CREDENTIAL_CLEANUP_FAILED',
              `The temporary ${kind} credential could not be removed`,
              error,
            )
          } finally {
            try {
              current?.dispose()
            } catch (error) {
              disposeError = protectedUnavailable(
                'PROTECTED_CREDENTIAL_CLEANUP_FAILED',
                `The temporary ${kind} credential context could not be disposed`,
                error,
              )
            }
          }
          const failure = combineFailures(
            [removalError, disposeError],
            `The temporary ${kind} credential cleanup failed`,
          )
          if (failure !== undefined) {
            if (removalError !== undefined && disposeError !== undefined) {
              throw protectedUnavailable(
                'PROTECTED_CREDENTIAL_CLEANUP_FAILED',
                `The temporary ${kind} credential cleanup failed`,
                failure,
              )
            }
            throw failure
          }
          return { credentialRemoved: true }
        })()
        try {
          return await removalPromise
        } finally {
          removalPromise = undefined
        }
      },
    }
  } catch (error) {
    let disposeError
    try {
      context?.dispose()
    } catch (cleanupError) {
      disposeError = cleanupError
    }
    const failure = combineFailures(
      [error, disposeError],
      `The supplied ${kind} credential could not be installed in Braid's protected workspace credential store`,
    )
    throw protectedUnavailable(
      'PROTECTED_CREDENTIAL_STORE_UNAVAILABLE',
      `The supplied ${kind} credential could not be installed in Braid's protected workspace credential store`,
      failure,
    )
  } finally {
    secret.fill(0)
  }
}

function childEnvironment(environment, root, statePath) {
  const child = {
    ...environment,
    HOME: root,
    NO_COLOR: '1',
    NODE_NO_WARNINGS: '1',
    BRAID_STATE_PATH: statePath,
    APPDATA: join(root, 'AppData', 'Roaming'),
    XDG_DATA_HOME: join(root, '.xdg-data'),
    XDG_CONFIG_HOME: join(root, '.xdg-config'),
  }
  for (const name of AUTH_ENVIRONMENT_NAMES) delete child[name]
  return child
}

export async function resolveBinary(repository, environment) {
  const candidate = resolve(
    environment.BRAID_LIVE_BINARY ?? join(repository, 'dist', 'bin', 'braid.js'),
  )
  try {
    await access(candidate)
  } catch (error) {
    throw protectedUnavailable(
      'BRAID_BUILD_REQUIRED',
      `The Braid binary is unavailable at ${candidate}; run the release build before live checks`,
      error,
    )
  }
  return candidate
}

export async function prepareProductionWorkspace({
  repository,
  environment = process.env,
  kind,
  endpoint,
  model,
  runner,
  provider,
  connectionName,
  providerOptions = {},
  confidentialAttestationPolicy,
  credentialRef,
  credentialValue,
  credentialContextFactory,
  removeTemporaryRoot = (path) => rm(path, { recursive: true, force: true }),
}) {
  const root = await mkdtemp(join(tmpdir(), 'braid-live-required-'))
  let generatedCredential
  try {
    const kindId = kind.replace(/[^A-Za-z0-9._~-]/gu, '-')
    const workspace = join(root, 'workspace')
    const configDirectory = join(workspace, '.braid')
    const profileDirectory = join(configDirectory, 'profiles')
    const databaseKeyFile = join(root, 'database.key')
    const configPath = join(configDirectory, 'config.json')
    const dataDirectory = liveDataDirectory(root)
    const generatedCredentialId =
      credentialValue === undefined
        ? undefined
        : `credential-live-${kindId}-${randomUUID().replaceAll('-', '')}`
    const selectedCredentialId = generatedCredentialId ?? credentialRef
    if (selectedCredentialId !== undefined) validCredentialId(selectedCredentialId)
    const profile = profileFor({ kind, model, runner, provider })
    const profileFile = `profile-${kindId}.json`
    const profilePath = join(profileDirectory, profileFile)
    const now = timestamp()
    const connection = {
      id: `connection-live-${kindId}`,
      kind,
      name: connectionName ?? `Live ${kind}`,
      endpoint,
      ...(selectedCredentialId === undefined ? {} : { credentialRef: selectedCredentialId }),
      ...(confidentialAttestationPolicy === undefined ? {} : { confidentialAttestationPolicy }),
      providerOptions: { ...providerOptions, transport: 'https' },
      createdAt: now,
      updatedAt: now,
      lastHealth: { status: 'unknown' },
    }
    await mkdir(profileDirectory, { recursive: true, mode: 0o700 })
    await writeFile(databaseKeyFile, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 })
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 })
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          format: 'braid-startup-config',
          schemaVersion: 2,
          databaseKeyFile,
          profile: `profiles/${profileFile}`,
          connectionId: connection.id,
          connections: [connection],
        },
        null,
      )}\n`,
      { mode: 0o600 },
    )
    generatedCredential =
      credentialValue === undefined
        ? undefined
        : await installGeneratedCredential({
            repository,
            workspace,
            configPath,
            databaseKeyFile,
            dataDirectory,
            credentialId: generatedCredentialId,
            value: credentialValue,
            kind,
            createCredentialContext: credentialContextFactory,
          })
    let temporaryRootRemoved = false
    let cleanupPromise
    let lastCleanupEvidence = cleanupEvidence(generatedCredential === undefined, false)
    return {
      root,
      workspace,
      configPath,
      databaseKeyFile,
      dataDirectory,
      statePath: join(root, 'state.sqlite'),
      connection,
      profile,
      endpoint: endpointEvidence(endpoint),
      credentialConfigured: selectedCredentialId !== undefined,
      environment: childEnvironment(environment, root, join(root, 'state.sqlite')),
      cleanup: async () => {
        if (temporaryRootRemoved) return lastCleanupEvidence
        if (cleanupPromise !== undefined) return cleanupPromise
        cleanupPromise = (async () => {
          let credentialResult = {
            credentialRemoved: generatedCredential === undefined,
          }
          let credentialError
          let workspaceError
          try {
            if (generatedCredential !== undefined)
              credentialResult = await generatedCredential.remove()
          } catch (error) {
            credentialError = error
          } finally {
            try {
              await removeTemporaryRoot(root)
              temporaryRootRemoved = true
            } catch (error) {
              workspaceError = error
            }
          }
          lastCleanupEvidence = cleanupEvidence(
            credentialResult.credentialRemoved === true,
            temporaryRootRemoved,
          )
          const failure = combineFailures(
            [credentialError, workspaceError],
            'The live workspace cleanup failed',
          )
          if (failure !== undefined) throw withCleanupEvidence(failure, lastCleanupEvidence)
          return lastCleanupEvidence
        })()
        try {
          return await cleanupPromise
        } finally {
          cleanupPromise = undefined
        }
      },
    }
  } catch (error) {
    const failures = [error]
    try {
      await generatedCredential?.remove()
    } catch (cleanupError) {
      failures.push(cleanupError)
    }
    try {
      await removeTemporaryRoot(root)
    } catch (cleanupError) {
      failures.push(cleanupError)
    }
    throw (
      combineFailures(
        failures,
        'The live workspace failed during setup and could not be cleaned up',
      ) ?? error
    )
  }
}

function requestId(scope) {
  return `live-required-${scope}-${randomUUID()}`
}

export async function rpcRequest(session, command, params = {}, operationId) {
  const request = {
    ...requestBase(requestId(command), command, operationId),
    params,
  }
  session.send(request)
  const response = await session.waitFor(
    `${command} acknowledgement`,
    (candidate) =>
      candidate.requestId === request.requestId &&
      (candidate.type === 'ack' || candidate.type === 'error'),
  )
  if (response.type === 'error') throw new Error(`${response.code}: ${response.message}`)
  return response
}

export async function initializedSession(binary, config, fixture) {
  if (fixture !== undefined) {
    throw new Error('The live-required RPC session accepts a built production binary only')
  }
  const session = await RpcSession.create(
    binary,
    config.workspace,
    config.environment,
    Number(process.env.BRAID_LIVE_REQUIRED_TIMEOUT_MS ?? 180_000),
  )
  try {
    const initialize = {
      ...requestBase(requestId('initialize'), 'initialize'),
      params: { workspace: config.workspace, subscribe: true },
    }
    session.send(initialize)
    const acknowledgement = await session.waitFor(
      'initialize acknowledgement',
      (candidate) =>
        candidate.requestId === initialize.requestId &&
        (candidate.type === 'ack' || candidate.type === 'error'),
    )
    if (acknowledgement.type === 'error')
      throw new Error(`${acknowledgement.code}: ${acknowledgement.message}`)
    const state = await session.waitFor(
      'initialize state',
      (candidate) => candidate.requestId === initialize.requestId && candidate.type === 'state',
    )
    return { session, state }
  } catch (error) {
    await session.close().catch(() => undefined)
    throw error
  }
}

export async function closeSession(session) {
  let closed
  try {
    if (!session.closed)
      await rpcRequest(session, 'shutdown', {}, `op-live-required-shutdown-${randomUUID()}`)
  } finally {
    closed = await session.close().catch(() => undefined)
  }
  return closed
}

export async function rpcState(session, projection = 'full') {
  const request = {
    ...requestBase(requestId('get-state'), 'get_state'),
    params: { projection },
  }
  session.send(request)
  return session.waitFor(
    'state projection',
    (candidate) => candidate.requestId === request.requestId && candidate.type === 'state',
  )
}

export async function runHeadlessTurn({ binary, config, marker, prompt, fixture }) {
  const { session, state: initial } = await initializedSession(binary, config, fixture)
  try {
    const operationId = `op-live-required-send-${randomUUID()}`
    const response = await rpcRequest(
      session,
      'send',
      {
        conversationId: initial.state.conversationId,
        branchId: initial.state.branchId,
        text: prompt,
      },
      operationId,
    )
    if (typeof response.runId !== 'string') throw new Error('send acknowledgement has no run id')
    const terminal = await session.waitFor(
      'turn terminal state',
      (candidate) => stateForRun(candidate, response.runId),
      Number(process.env.BRAID_LIVE_REQUIRED_TIMEOUT_MS ?? 180_000),
    )
    const run = runFromState(terminal.state, response.runId)
    if (run?.status !== 'completed') {
      const diagnostics = [
        typeof run?.error === 'string' && run.error.length > 0
          ? `error=${JSON.stringify(safeMessage(run.error, config.environment))}`
          : undefined,
        typeof run?.model === 'string' && run.model.length > 0
          ? `model=${JSON.stringify(safeMessage(run.model, config.environment))}`
          : undefined,
      ].filter(Boolean)
      throw new Error(
        `turn ${response.runId} ended with status ${run?.status ?? 'missing'}${diagnostics.length === 0 ? '' : `; ${diagnostics.join('; ')}`}`,
      )
    }
    const message = terminalMessage(terminal.state, response.runId)
    if (!exactMarker(message?.text, marker)) {
      throw new Error(
        `turn ${response.runId} returned ${JSON.stringify(message?.text ?? '')}; expected ${marker}`,
      )
    }
    if (typeof run.materializationDigest !== 'string' || run.materializationDigest.length === 0) {
      throw new Error(`turn ${response.runId} has no materialization receipt digest`)
    }
    return { session, initial, terminal, run, message, response }
  } catch (error) {
    await closeSession(session)
    throw error
  }
}

export async function runHeadlessCancellation({ binary, config, marker, prompt, fixture }) {
  const { session, state: initial } = await initializedSession(binary, config, fixture)
  try {
    const send = {
      ...requestBase(
        requestId('send-cancel'),
        'send',
        `op-live-required-cancel-send-${randomUUID()}`,
      ),
      params: {
        conversationId: initial.state.conversationId,
        branchId: initial.state.branchId,
        text: prompt,
      },
    }
    session.send(send)
    const sent = await session.waitFor(
      'cancellable turn acknowledgement',
      (candidate) =>
        candidate.requestId === send.requestId &&
        (candidate.type === 'ack' || candidate.type === 'error'),
    )
    if (sent.type === 'error') throw new Error(`${sent.code}: ${sent.message}`)
    if (typeof sent.runId !== 'string') throw new Error('cancellable send has no run id')
    const cancel = await rpcRequest(
      session,
      'cancel',
      { runId: sent.runId, reason: `live required ${marker}` },
      `op-live-required-cancel-${randomUUID()}`,
    )
    const terminal = await session.waitFor(
      'cancelled turn terminal state',
      (candidate) => stateForRun(candidate, sent.runId),
      Number(process.env.BRAID_LIVE_REQUIRED_TIMEOUT_MS ?? 180_000),
    )
    const run = runFromState(terminal.state, sent.runId)
    if (!['aborted', 'cancelled'].includes(run?.status))
      throw new Error(`cancelled turn ended with status ${run?.status ?? 'missing'}`)
    return { session, initial, terminal, run, cancel }
  } catch (error) {
    await closeSession(session)
    throw error
  }
}

export function configEvidence(config) {
  const providerOptions = config.connection.providerOptions ?? {}
  return {
    endpoint: config.endpoint,
    connectionId: config.connection.id,
    connectionKind: config.connection.kind,
    credentialConfigured: config.credentialConfigured,
    model: config.profile.model.default,
    runner: config.profile.harness,
    ...(providerOptions.lifecycle === undefined ? {} : { lifecycle: providerOptions.lifecycle }),
    ...(providerOptions.idleTtlSeconds === undefined
      ? {}
      : { idleTtlSeconds: providerOptions.idleTtlSeconds }),
  }
}

export function providerError(error, scope) {
  return protectedUnavailable(
    'PROTECTED_PROVIDER_UNAVAILABLE',
    `${scope} could not reach or authenticate with its configured provider: ${safeMessage(error)}`,
    error,
  )
}

export async function assertFileExists(path) {
  try {
    await access(path)
  } catch (error) {
    throw protectedUnavailable(
      'BRAID_BUILD_REQUIRED',
      `Required Braid artifact is missing: ${path}`,
      error,
    )
  }
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}
