import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  confidentialExecutionVerified,
  forkedEnvironmentConfidentialityVerified,
  workspaceCheckpointRequestDigest,
  workspaceForkRequestDigest,
} from '@tangle-network/agent-interface'
import { generateAttestationNonce } from '@tangle-network/sandbox'

import { connectionConfiguration } from './configuration.mjs'
import {
  PROOF_OPERATIONS,
  proofInvocation,
  proofReceipt,
  protectedUnavailable,
  scalarMeasurement,
} from './contracts.mjs'
import { configEvidence, prepareProductionWorkspace } from './headless.mjs'

const DEFAULT_REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_ENDPOINT = 'https://sandbox.tangle.tools'
const DEFAULT_MODEL = 'tangle-router/glm-5.2'
const DEFAULT_RUNNER = 'opencode'
const DEFAULT_PROVIDER = 'tangle'
const DEFAULT_IDLE_TTL_SECONDS = 1_800
const DEFAULT_ABSENCE_ATTEMPTS = 6
const DEFAULT_ABSENCE_DELAY_MS = 500

function configurationEnvironment(environment) {
  if (
    !environment.BRAID_TANGLE_SANDBOX_CREDENTIAL_REF &&
    !environment.BRAID_TANGLE_SANDBOX_AUTH &&
    !environment.BRAID_TANGLE_SANDBOX_API_KEY &&
    !environment.BRAID_TANGLE_SANDBOX_BEARER &&
    environment.TANGLE_API_KEY
  ) {
    return { ...environment, BRAID_TANGLE_SANDBOX_API_KEY: environment.TANGLE_API_KEY }
  }
  return environment
}

function sandboxConfiguration(environment) {
  return connectionConfiguration(configurationEnvironment(environment), {
    prefix: 'BRAID_TANGLE_SANDBOX',
    kind: 'tangle-sandbox',
    endpointNames: ['BRAID_TANGLE_ENDPOINT'],
    modelNames: ['BRAID_TANGLE_MODEL'],
    runnerNames: ['BRAID_TANGLE_RUNNER'],
    providerNames: ['BRAID_TANGLE_SANDBOX_PROVIDER'],
    fallbackEndpoint: DEFAULT_ENDPOINT,
    fallbackModel: DEFAULT_MODEL,
    fallbackRunner: DEFAULT_RUNNER,
    fallbackProvider: DEFAULT_PROVIDER,
  })
}

function idleTtlSeconds(environment) {
  const candidate = Number(environment.BRAID_TANGLE_SANDBOX_IDLE_TTL_SECONDS)
  if (!Number.isSafeInteger(candidate) || candidate < 60 || candidate > 604_800)
    return DEFAULT_IDLE_TTL_SECONDS
  return candidate
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function sha256Digest(value) {
  if (typeof value !== 'string') throw new Error('A provider digest is missing')
  if (/^sha256:[0-9a-f]{64}$/u.test(value)) return value
  if (/^[0-9a-f]{64}$/u.test(value)) return `sha256:${value}`
  throw new Error('A provider returned an invalid SHA-256 digest')
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message)
}

function unavailable(code, message, cause) {
  return protectedUnavailable(code, message, cause)
}

function providerEnvironmentId(record, label) {
  const value = record?.providerEnvironmentId
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${label} has no provider environment identity`)
  return value
}

function sourceEnvironmentRecord(state, run) {
  const environment = state.environments.find((candidate) => candidate.id === run.environmentId)
  if (environment === undefined) throw new Error(`Source run ${run.id} has no environment record`)
  const providerId = providerEnvironmentId(environment, 'Source environment')
  assertCondition(
    run.controlRef?.environmentId === providerId,
    'Source run and environment identities do not match',
  )
  return { environment, providerId }
}

function sourceRunFor(state, runId) {
  const run = state.runs.find((candidate) => candidate.id === runId)
  if (run === undefined) throw new Error(`Source run ${runId} is missing from durable state`)
  if (run.status !== 'completed' || run.complete !== true)
    throw new Error(`Source run ${runId} did not complete`)
  if (run.controlRef === undefined)
    throw new Error(`Source run ${runId} has no exact provider control reference`)
  return run
}

async function runtimeModules(repository) {
  const dist = resolve(repository, 'dist')
  const [startup, application, credentials, connections, profiles] = await Promise.all([
    import(pathToFileURL(join(dist, 'bin', 'production-startup.js')).href),
    import(pathToFileURL(join(dist, 'bin', 'production-application.js')).href),
    import(pathToFileURL(join(dist, 'bin', 'production-credential-context.js')).href),
    import(pathToFileURL(join(dist, 'adapters', 'connections', 'production-connections.js')).href),
    import(pathToFileURL(join(dist, 'adapters', 'agent-interface', 'profile-runtime.js')).href),
  ])
  return { startup, application, credentials, connections, profiles }
}

function verifierExports(moduleNamespace) {
  const defaultExport =
    moduleNamespace.default !== null && typeof moduleNamespace.default === 'object'
      ? moduleNamespace.default
      : undefined
  return { ...(defaultExport ?? {}), ...moduleNamespace }
}

/**
 * Load the deployment's trust decision without inventing a local TEE verdict.
 *
 * The module must export `verifyTeeAttestation` and `verifyConfidentialAttestation`.
 * The first checks the raw provider quote and returns provider key evidence.
 * The second checks the canonical attestation against the deployment policy.
 */
export async function loadConfidentialVerifier(environment, repository = DEFAULT_REPOSITORY) {
  const configured =
    environment.BRAID_TANGLE_TEE_VERIFIER_MODULE ??
    environment.BRAID_TANGLE_CONFIDENTIAL_VERIFIER_MODULE
  if (typeof configured !== 'string' || configured.trim().length === 0) {
    throw unavailable(
      'PROTECTED_CONFIDENTIAL_VERIFIER_REQUIRED',
      'LIVE-10 requires BRAID_TANGLE_TEE_VERIFIER_MODULE with trusted provider-key and measurement checks',
    )
  }
  const modulePath = isAbsolute(configured) ? configured : resolve(repository, configured)
  let loaded
  try {
    loaded = await import(pathToFileURL(modulePath).href)
  } catch (error) {
    throw unavailable(
      'PROTECTED_CONFIDENTIAL_VERIFIER_UNAVAILABLE',
      `LIVE-10 could not load its configured confidential verifier module: ${modulePath}`,
      error,
    )
  }
  const exports = verifierExports(loaded)
  const raw = exports.verifyTeeAttestation
  const canonical = exports.verifyConfidentialAttestation
  if (typeof raw !== 'function' || typeof canonical !== 'function') {
    throw unavailable(
      'PROTECTED_CONFIDENTIAL_VERIFIER_INVALID',
      'LIVE-10 verifier module must export verifyTeeAttestation and verifyConfidentialAttestation',
    )
  }
  return Object.freeze({
    raw: async (input) => {
      const result = await raw(input)
      if (result === null) return null
      if (result === undefined || typeof result !== 'object' || Array.isArray(result)) return null
      if (
        typeof result.providerKeyId !== 'string' ||
        result.providerKeyId.length === 0 ||
        result.providerKeyId === 'unverified' ||
        typeof result.providerSignature !== 'string' ||
        result.providerSignature.length === 0 ||
        result.providerSignature === 'unverified'
      ) {
        return null
      }
      return {
        providerKeyId: result.providerKeyId,
        providerSignature: result.providerSignature,
        ...(result.measurement === undefined ? {} : { measurement: result.measurement }),
      }
    },
    canonical: (attestation, expected) => {
      if (
        attestation === null ||
        typeof attestation !== 'object' ||
        Array.isArray(attestation) ||
        attestation.providerKeyId === 'unverified' ||
        attestation.providerSignature === 'unverified' ||
        attestation.providerSignature === attestation.quote
      ) {
        return false
      }
      try {
        return canonical(attestation, expected) === true
      } catch {
        return false
      }
    },
  })
}

async function openProofApplication({ repository, config, verifier }) {
  const modules = await runtimeModules(repository)
  let context
  try {
    context = modules.credentials.createProductionCredentialContext({
      workspace: config.workspace,
      configPath: config.configPath,
      databaseKeyFile: config.databaseKeyFile,
      dataDirectory: config.dataDirectory,
    })
    if (context === undefined)
      throw unavailable(
        'PROTECTED_DATABASE_KEY_REQUIRED',
        "The live proof could not create Braid's protected credential context",
      )
    const startupOptions = {
      workspace: config.workspace,
      configPath: config.configPath,
      databaseKeyFile: config.databaseKeyFile,
      credentialContext: context,
      credentialStore: context.store,
    }
    const startup = await modules.startup.loadProductionStartup(startupOptions)
    const connection = startup.connections.find(
      (candidate) => candidate.id === startup.connectionId,
    )
    if (connection === undefined)
      throw new Error('The live proof configuration selected no connection')
    const connectionOptions = {
      ...(startup.connectionOptions ?? {}),
      credentials: context.store,
      ...(verifier?.raw === undefined
        ? {}
        : { tangleConfidentialAttestationVerifier: verifier.raw }),
      ...(verifier?.canonical === undefined
        ? {}
        : { confidentialAttestationVerifier: verifier.canonical }),
    }
    const production = {
      ...startup,
      workspaceRoot: config.workspace,
      connectionOptions,
    }
    const opened = await modules.application.openProductionApplication({
      workspace: config.workspace,
      statePath: config.statePath,
      startupOptions,
      production,
    })
    try {
      await modules.application.activateProductionConnection(
        opened.app,
        startup.connectionId,
        startup.connections,
      )
    } catch (error) {
      await opened.close().catch(() => undefined)
      throw error
    }
    return Object.freeze({
      ...opened,
      startup,
      production,
      connection,
      modules,
    })
  } catch (error) {
    context?.dispose()
    throw error
  }
}

function providerAdapters(opened) {
  const { createTangleWorkspaceBranchingProvider, getTangleSandboxEnvironment } =
    opened.modules.connections
  const options = opened.production.connectionOptions ?? {}
  const factory = createTangleWorkspaceBranchingProvider(opened.connection, options)
  return Object.freeze({
    freshBranching: async (sourceEnvironmentId) => {
      const branching = await factory.forEnvironment(sourceEnvironmentId)
      if (branching === null)
        throw unavailable(
          'PROTECTED_WORKSPACE_BRANCHING_UNAVAILABLE',
          `Tangle Sandbox did not expose workspace branching for ${sourceEnvironmentId}`,
        )
      return branching
    },
    freshEnvironment: (environmentId) =>
      getTangleSandboxEnvironment(opened.connection, options, environmentId),
  })
}

function markerFor(proofId, label) {
  return `BRAID_WORKSPACE_${proofId}_${label}`.toUpperCase()
}

function markerPath(proofId) {
  return `.braid-live/${proofId}/workspace-marker.txt`
}

function sourcePrompt(marker, path) {
  return [
    'Use the current Tangle Sandbox working directory for every command in this turn.',
    `Run mkdir -p ${shellQuote(dirname(path))}.`,
    `Run printf '%s\\n' ${shellQuote(marker)} > ${shellQuote(path)}.`,
    `Run cat ${shellQuote(path)} and verify the content is exactly ${shellQuote(marker)}.`,
    `Reply with exactly ${marker}.`,
  ].join(' ')
}

async function sendSource(app, proofId) {
  const initial = app.state()
  const marker = markerFor(proofId, 'SOURCE')
  const path = markerPath(proofId)
  const operationId = `op-live-required-${proofId}-source-${randomUUID()}`
  const receipt = app.send({
    operationId,
    conversationId: initial.conversationId,
    branchId: initial.branchId,
    text: sourcePrompt(marker, path),
  })
  await receipt.admissionReady
  const terminal = await receipt.completion
  const run = sourceRunFor(terminal, receipt.runId)
  const source = sourceEnvironmentRecord(terminal, run)
  return Object.freeze({
    marker,
    path,
    operationId,
    receipt,
    run,
    ...source,
  })
}

async function readWorkspace(adapters, environmentId, path, label) {
  const environment = await adapters.freshEnvironment(environmentId)
  if (environment === null)
    throw new Error(`${label} provider environment ${environmentId} is missing`)
  if (typeof environment.read !== 'function')
    throw unavailable(
      'PROTECTED_WORKSPACE_READ_UNAVAILABLE',
      `Tangle Sandbox did not expose workspace read for ${label}`,
    )
  const content = await environment.read(path)
  return Object.freeze({ content, digest: sha256(content) })
}

async function writeWorkspace(adapters, environmentId, path, content, label) {
  const environment = await adapters.freshEnvironment(environmentId)
  if (environment === null)
    throw new Error(`${label} provider environment ${environmentId} is missing`)
  if (typeof environment.write !== 'function')
    throw unavailable(
      'PROTECTED_WORKSPACE_WRITE_UNAVAILABLE',
      `Tangle Sandbox did not expose workspace write for ${label}`,
    )
  await environment.write(path, content)
}

function checkpointAndForkRequests(state, plan, operationId, sourceRun, destinationId) {
  const checkpoint = state.checkpoints.find((candidate) => candidate.operationId === operationId)
  if (checkpoint === undefined) throw new Error('Braid did not persist the workspace checkpoint')
  const operation = state.operations.find((candidate) => candidate.id === operationId)
  const providerCheckpointId = operation?.result?.providerCheckpointId
  if (typeof providerCheckpointId !== 'string' || providerCheckpointId.length === 0)
    throw new Error('Braid did not persist the provider checkpoint identity')
  const source = structuredClone(sourceRun.controlRef)
  const checkpointMaterial = {
    source,
    name: `braid checkpoint ${plan.sourceBranchId}`,
    metadata: {
      braidOperationId: operationId,
      sourceBranchId: String(plan.sourceBranchId),
      ...(plan.throughMessageId === undefined ? {} : { throughMessageId: plan.throughMessageId }),
    },
  }
  const checkpointRequestDigest = workspaceCheckpointRequestDigest(checkpointMaterial)
  assertCondition(
    sha256Digest(checkpoint.requestDigest) === checkpointRequestDigest,
    'Persisted checkpoint digest does not match Braid request material',
  )
  const checkpointRef = {
    checkpointId: providerCheckpointId,
    provider: source.provider,
    source,
    idempotencyKey: `${operationId}:checkpoint`,
    requestDigest: checkpointRequestDigest,
    createdAt: checkpoint.createdAt,
    metadata: checkpointMaterial.metadata,
  }
  const placement = plan.placement ?? { kind: 'provider' }
  const forkMaterial = {
    checkpoint: checkpointRef,
    name: `braid fork ${plan.destinationBranchId}`,
    placement,
    ...(plan.confidential === undefined ? {} : { confidential: plan.confidential }),
    metadata: {
      braidOperationId: operationId,
      destinationBranchId: String(plan.destinationBranchId),
    },
  }
  const forkRequestDigest = workspaceForkRequestDigest(forkMaterial)
  const graphEdge = state.graphEdges.find((candidate) => {
    const sourceNode = state.graphNodes.find((node) => node.id === candidate.source)
    const destinationNode = state.graphNodes.find((node) => node.id === candidate.destination)
    return (
      candidate.kind === 'forked_environment' &&
      sourceNode?.reference.kind === 'checkpoint' &&
      sourceNode.reference.id === checkpoint.id &&
      destinationNode?.reference.kind === 'environment' &&
      destinationNode.reference.id === destinationId
    )
  })
  assertCondition(graphEdge !== undefined, 'Braid did not persist the fork graph edge')
  const recordedForkDigest = graphEdge.provenance.sourceDigest
  assertCondition(recordedForkDigest !== undefined, 'Braid fork graph edge has no request digest')
  assertCondition(
    sha256Digest(recordedForkDigest) === forkRequestDigest,
    'Persisted fork digest does not match Braid request material',
  )
  return Object.freeze({
    checkpoint,
    checkpointRef,
    checkpointRequest: {
      ...checkpointMaterial,
      idempotencyKey: `${operationId}:checkpoint`,
      requestDigest: checkpointRequestDigest,
    },
    forkRequest: {
      ...forkMaterial,
      idempotencyKey: `${operationId}:fork`,
      requestDigest: forkRequestDigest,
    },
  })
}

async function lookupAfterRestart(adapters, sourceProviderEnvironmentId, requests) {
  const checkpointHandle = await adapters.freshBranching(sourceProviderEnvironmentId)
  const checkpoint = await checkpointHandle.lookupCheckpoint({
    idempotencyKey: requests.checkpointRequest.idempotencyKey,
    requestDigest: requests.checkpointRequest.requestDigest,
  })
  if (checkpoint.status !== 'found')
    throw new Error(`Restart checkpoint lookup returned ${checkpoint.status}`)
  assertCondition(
    checkpoint.checkpoint.checkpointId === requests.checkpointRef.checkpointId,
    'Restart checkpoint lookup returned another checkpoint',
  )
  const forkHandle = await adapters.freshBranching(sourceProviderEnvironmentId)
  const fork = await forkHandle.lookupFork({
    idempotencyKey: requests.forkRequest.idempotencyKey,
    requestDigest: requests.forkRequest.requestDigest,
  })
  if (fork.status !== 'found') throw new Error(`Restart fork lookup returned ${fork.status}`)
  assertCondition(
    fork.environment.sourceEnvironmentId === sourceProviderEnvironmentId,
    'Restart fork lookup returned another source environment',
  )
  return Object.freeze({ checkpoint, fork })
}

async function destroySource(adapters, sourceProviderEnvironmentId) {
  const environment = await adapters.freshEnvironment(sourceProviderEnvironmentId)
  if (environment === null) return true
  if (typeof environment.destroy !== 'function')
    throw unavailable(
      'PROTECTED_ENVIRONMENT_CLEANUP_UNAVAILABLE',
      'Tangle Sandbox did not expose source environment cleanup',
    )
  await environment.destroy()
  for (let attempt = 0; attempt < DEFAULT_ABSENCE_ATTEMPTS; attempt += 1) {
    if ((await adapters.freshEnvironment(sourceProviderEnvironmentId)) === null) return true
    await new Promise((resolvePromise) => setTimeout(resolvePromise, DEFAULT_ABSENCE_DELAY_MS))
  }
  throw new Error(
    `Source provider environment ${sourceProviderEnvironmentId} remained after cleanup`,
  )
}

function checkpointIdForDestination(state, destinationId) {
  const edge = state.graphEdges.find((candidate) => {
    const source = state.graphNodes.find((node) => node.id === candidate.source)
    const destination = state.graphNodes.find((node) => node.id === candidate.destination)
    return (
      candidate.kind === 'forked_environment' &&
      destination?.reference.kind === 'environment' &&
      destination.reference.id === destinationId &&
      source?.reference.kind === 'checkpoint'
    )
  })
  if (edge === undefined) return undefined
  const source = state.graphNodes.find((node) => node.id === edge.source)
  if (source?.reference.kind !== 'checkpoint') return undefined
  return state.checkpoints.find((candidate) => candidate.id === source.reference.id)?.id
}

function confidentialExpected(source, destinationProviderEnvironmentId, requestDigest) {
  return {
    provider: source.provider,
    environmentId: destinationProviderEnvironmentId,
    source: structuredClone(source),
    requestDigest,
    confidentialRequested: true,
  }
}

/** Run the canonical negative checks used by LIVE-10 and by its deterministic test. */
export function confidentialNegativeChecks({
  request,
  environment,
  attestation,
  verifyProviderAttestation,
}) {
  const wrongNonce = {
    ...request,
    nonce: `${request.nonce}-wrong`,
  }
  const wrongMeasurement = {
    ...attestation,
    measurement: `sha256:${'f'.repeat(64)}`,
  }
  const selfEcho = {
    ...attestation,
    providerKeyId: 'unverified',
    providerSignature: 'unverified',
  }
  return Object.freeze({
    missingAttestationRejected: !confidentialExecutionVerified({
      request,
      environment,
      verifyProviderAttestation,
    }),
    wrongNonceRejected: !confidentialExecutionVerified({
      request: wrongNonce,
      environment,
      attestation,
      verifyProviderAttestation,
    }),
    wrongMeasurementRejected: !confidentialExecutionVerified({
      request,
      environment,
      attestation: wrongMeasurement,
      verifyProviderAttestation,
    }),
    selfEchoRejected: !confidentialExecutionVerified({
      request,
      environment,
      attestation: selfEcho,
      verifyProviderAttestation,
    }),
  })
}

async function runWorkspaceProof({
  repository = DEFAULT_REPOSITORY,
  environment = process.env,
  invocationId = proofInvocation('live-tangle-workspace'),
  confidential = false,
}) {
  const proofId = `${Date.now()}-${randomUUID().replaceAll('-', '')}`
  const startedAt = new Date().toISOString()
  const verifier = confidential
    ? await loadConfidentialVerifier(environment, repository)
    : undefined
  const values = sandboxConfiguration(environment)
  const config = await prepareProductionWorkspace({
    repository,
    environment,
    kind: 'tangle-sandbox',
    connectionName: confidential ? 'Live tangle confidential' : 'Live tangle workspace fork',
    endpoint: values.endpoint,
    model: values.model,
    runner: values.runner,
    provider: values.provider,
    credentialRef: values.credentialRef,
    credentialValue: values.credentialValue,
    providerOptions: {
      lifecycle: 'retained',
      idleTtlSeconds: idleTtlSeconds(environment),
    },
  })
  let opened
  let restarted
  let source
  let destination
  let destinationProviderId
  let sourceBefore
  let destinationAfterMutation
  let sourceAfterCleanup
  let branchOperationId
  let cleanupOperationId
  let resources
  let cleanupResult
  let sourceDestroyed = false
  let primaryError
  let completedResult
  let cleanupFailure
  try {
    opened = await openProofApplication({ repository, config, verifier })
    const adapters = providerAdapters(opened)
    source = await sendSource(opened.app, proofId)
    sourceBefore = await readWorkspace(adapters, source.providerId, source.path, 'source')
    assertCondition(
      sourceBefore.content.trim() === source.marker,
      'Source workspace marker was not materialized exactly',
    )
    branchOperationId = `op-live-required-${proofId}-fork`
    const planInput = {
      operationId: branchOperationId,
      conversationId: opened.app.state().conversationId,
      branchId: opened.app.state().branchId,
      kind: 'workspace',
      placement: { kind: 'provider' },
      ...(confidential
        ? {
            confidential: {
              requested: true,
              nonce: generateAttestationNonce(),
              policy: 'tangle-confidential-v1',
              profileDigest: `sha256:${opened.modules.profiles.canonicalAgentProfileDigestHex(opened.app.state().profile)}`,
            },
          }
        : {}),
    }
    const plan = opened.app.conversations.branches.plan(planInput)
    if (!plan.allowed)
      throw unavailable(
        'PROTECTED_WORKSPACE_BRANCHING_UNAVAILABLE',
        plan.reason ?? 'Tangle Sandbox did not report retry-safe workspace branching',
      )
    const requestedUnverifiedBinding = confidential
      ? !confidentialExecutionVerified({
          request: plan.confidential,
          environment: confidentialExpected(
            source.run.controlRef,
            'pending-destination',
            `sha256:${'0'.repeat(64)}`,
          ),
          verifyProviderAttestation: verifier.canonical,
        })
      : true
    assertCondition(
      requestedUnverifiedBinding,
      'Confidential placement passed without an attestation before execution',
    )
    const branch = await opened.app.conversations.branches.execute({
      ...planInput,
      planDigest: plan.digest,
    })
    const afterExecute = opened.app.state()
    const sourceRun = sourceRunFor(afterExecute, source.run.id)
    destination = afterExecute.environments.find(
      (candidate) => candidate.id === branch.environmentId,
    )
    if (destination === undefined) throw new Error('Braid did not persist the forked environment')
    destinationProviderId = providerEnvironmentId(destination, 'Destination environment')
    assertCondition(
      destinationProviderId !== source.providerId,
      'Fork reused the source environment',
    )
    resources = checkpointAndForkRequests(
      afterExecute,
      plan,
      branchOperationId,
      sourceRun,
      destination.id,
    )
    const destinationMarker = markerFor(proofId, 'DESTINATION')
    await writeWorkspace(
      adapters,
      destinationProviderId,
      source.path,
      `${destinationMarker}\n`,
      'destination',
    )
    destinationAfterMutation = await readWorkspace(
      adapters,
      destinationProviderId,
      source.path,
      'destination',
    )
    assertCondition(
      destinationAfterMutation.content.trim() === destinationMarker,
      'Destination mutation was not independently materialized',
    )
    const sourceAfterMutation = await readWorkspace(
      adapters,
      source.providerId,
      source.path,
      'source',
    )
    assertCondition(
      sourceAfterMutation.content === sourceBefore.content,
      'Destination mutation changed the source workspace',
    )

    await opened.close()
    opened = undefined
    restarted = await openProofApplication({ repository, config, verifier })
    const restartedAdapters = providerAdapters(restarted)
    const replayBranch = await restarted.app.conversations.branches.execute({
      ...planInput,
      planDigest: plan.digest,
    })
    assertCondition(replayBranch.id === branch.id, 'Restart replay produced another branch')
    const lookedUp = await lookupAfterRestart(restartedAdapters, source.providerId, resources)
    if (confidential) {
      const attestation = lookedUp.fork.environment.confidentialAttestation
      if (attestation === undefined)
        throw unavailable(
          'PROTECTED_CONFIDENTIAL_DEPLOYMENT_UNAVAILABLE',
          'Tangle Sandbox did not return a TEE attestation for the confidential fork',
        )
      assertCondition(
        attestation.providerKeyId !== 'unverified' &&
          attestation.providerSignature !== 'unverified',
        'Tangle Sandbox returned an unauthenticated confidential attestation',
      )
      assertCondition(
        attestation.providerSignature !== attestation.quote,
        'Tangle Sandbox returned the quote as its provider signature',
      )
      const expected = confidentialExpected(
        sourceRun.controlRef,
        destinationProviderId,
        resources.forkRequest.requestDigest,
      )
      assertCondition(
        forkedEnvironmentConfidentialityVerified(
          resources.forkRequest,
          lookedUp.fork.environment,
          verifier.canonical,
        ),
        'Canonical confidential attestation verification failed for the valid fork',
      )
      const negatives = confidentialNegativeChecks({
        request: resources.forkRequest.confidential,
        environment: expected,
        attestation,
        verifyProviderAttestation: verifier.canonical,
      })
      assertCondition(
        negatives.missingAttestationRejected,
        'Missing confidential attestation was accepted',
      )
      assertCondition(negatives.wrongNonceRejected, 'Wrong confidential nonce was accepted')
      assertCondition(
        negatives.wrongMeasurementRejected,
        'Wrong confidential measurement was accepted',
      )
      assertCondition(negatives.selfEchoRejected, 'Self-echoed confidential evidence was accepted')
      assertCondition(
        destination.placement.confidentialRequested,
        'Confidential request was not recorded',
      )
      assertCondition(
        destination.placement.confidentialVerified,
        'Confidential attestation was not verified',
      )
    }
    cleanupOperationId = `op-live-required-${proofId}-cleanup`
    cleanupResult = await restarted.app.conversations.branches.cleanup({
      operationId: cleanupOperationId,
      checkpointId: String(resources.checkpoint.id),
      environmentId: String(destination.id),
    })
    assertCondition(
      ['deleted', 'already_absent'].includes(cleanupResult.checkpoint),
      'Checkpoint cleanup did not reach a terminal deletion status',
    )
    assertCondition(
      ['deleted', 'already_absent'].includes(cleanupResult.environment),
      'Fork cleanup did not reach a terminal deletion status',
    )
    const cleanupReplay = await restarted.app.conversations.branches.cleanup({
      operationId: cleanupOperationId,
      checkpointId: String(resources.checkpoint.id),
      environmentId: String(destination.id),
    })
    assertCondition(
      JSON.stringify(cleanupReplay) === JSON.stringify(cleanupResult),
      'Cleanup replay returned a different durable result',
    )
    const finalState = restarted.app.state()
    assertCondition(
      finalState.checkpoints.find((candidate) => candidate.id === resources.checkpoint.id)
        ?.status === 'deleted',
      'Braid did not record checkpoint cleanup',
    )
    assertCondition(
      finalState.environments.find((candidate) => candidate.id === destination.id)?.lifecycle ===
        'destroyed',
      'Braid did not record fork environment cleanup',
    )
    sourceAfterCleanup = await readWorkspace(
      restartedAdapters,
      source.providerId,
      source.path,
      'source',
    )
    assertCondition(
      sourceAfterCleanup.digest === sourceBefore.digest,
      'Source workspace digest changed during cleanup',
    )
    sourceDestroyed = await destroySource(restartedAdapters, source.providerId)
    await restarted.close()
    restarted = undefined
    completedResult = {
      status: 'passed',
      measurement: scalarMeasurement(confidential ? 'LIVE-10' : 'LIVE-09'),
      evidence: proofReceipt({
        invocationId,
        operation: confidential
          ? PROOF_OPERATIONS.tangleConfidential
          : PROOF_OPERATIONS.tangleWorkspaceFork,
        startedAt,
        completedAt: new Date().toISOString(),
        config: configEvidence(config),
        runIds: [source.run.id],
        environmentId: source.run.environmentId,
        materializationDigest: source.run.materializationDigest ?? null,
        facts: confidential
          ? {
              sourceProviderEnvironmentId: source.providerId,
              destinationProviderEnvironmentId: destinationProviderId,
              confidentialRequested: true,
              confidentialVerified: true,
              missingAttestationRejected: true,
              wrongNonceRejected: true,
              wrongMeasurementRejected: true,
              cleanupCheckpoint: cleanupResult.checkpoint,
              cleanupEnvironment: cleanupResult.environment,
            }
          : {
              sourceProviderEnvironmentId: source.providerId,
              destinationProviderEnvironmentId: destinationProviderId,
              checkpointRetried: true,
              forkRetried: true,
              restarted: true,
              sourceDigestBefore: sourceBefore.digest,
              sourceDigestAfter: sourceAfterCleanup.digest,
              destinationDigest: destinationAfterMutation.digest,
              cleanupCheckpoint: cleanupResult.checkpoint,
              cleanupEnvironment: cleanupResult.environment,
            },
        checks: confidential
          ? [
              'configuration',
              'external-verifier',
              'requested-unverified-binding',
              'missing-attestation',
              'valid-attestation',
              'wrong-nonce',
              'wrong-measurement',
              'cleanup',
            ]
          : [
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
        observations: {
          source: {
            providerEnvironmentId: source.providerId,
            path: source.path,
            digestBefore: sourceBefore.digest,
            digestAfter: sourceAfterCleanup.digest,
            destroyed: sourceDestroyed,
          },
          destination: {
            providerEnvironmentId: destinationProviderId,
            digest: destinationAfterMutation.digest,
            independentMutation: true,
          },
          recovery: {
            checkpointLookup: 'found',
            forkLookup: 'found',
            branchReplay: true,
            cleanupReplay: true,
          },
          ...(confidential
            ? {
                attestation: {
                  providerKeyAuthenticated: true,
                  signatureDistinctFromQuote: true,
                  requestedUnverifiedBeforeExecution: true,
                  wrongNonceRejected: true,
                  wrongMeasurementRejected: true,
                  selfEchoRejected: true,
                },
              }
            : {}),
        },
        environment,
      }),
    }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    let cleanupError
    let cleanupOwner = restarted ?? opened
    let rescueOwner = false
    if (source !== undefined) {
      if (cleanupOwner === undefined) {
        try {
          cleanupOwner = await openProofApplication({ repository, config, verifier })
          rescueOwner = true
        } catch (error) {
          cleanupError ??= error
        }
      }
      const cleanupCheckpointId =
        resources?.checkpoint.id ??
        (cleanupOwner === undefined || destination === undefined
          ? undefined
          : checkpointIdForDestination(cleanupOwner.app.state(), destination.id))
      if (
        cleanupOwner !== undefined &&
        destination !== undefined &&
        cleanupCheckpointId !== undefined &&
        cleanupResult === undefined
      ) {
        cleanupOperationId ??= `op-live-required-${proofId}-cleanup`
        try {
          cleanupResult = await cleanupOwner.app.conversations.branches.cleanup({
            operationId: cleanupOperationId,
            checkpointId: String(cleanupCheckpointId),
            environmentId: String(destination.id),
          })
        } catch (error) {
          cleanupError ??= error
        }
      }
      if (cleanupOwner !== undefined && !sourceDestroyed) {
        try {
          sourceDestroyed = await destroySource(providerAdapters(cleanupOwner), source.providerId)
        } catch (error) {
          cleanupError ??= error
        }
      }
    }
    if (rescueOwner && cleanupOwner !== undefined) {
      try {
        await cleanupOwner.close()
      } catch (error) {
        cleanupError ??= error
      }
      if (restarted === cleanupOwner) restarted = undefined
      if (opened === cleanupOwner) opened = undefined
    }
    try {
      if (restarted !== undefined) await restarted.close()
    } catch (error) {
      cleanupError ??= error
    }
    try {
      if (opened !== undefined) await opened.close()
    } catch (error) {
      cleanupError ??= error
    }
    try {
      await config.cleanup()
    } catch (error) {
      cleanupError ??= error
    }
    if (cleanupError !== undefined && primaryError === undefined) cleanupFailure = cleanupError
  }
  if (cleanupFailure !== undefined) throw cleanupFailure
  return completedResult
}

export function runWorkspaceForkProof(input) {
  return runWorkspaceProof({ ...input, confidential: false })
}

export function runConfidentialProof(input) {
  return runWorkspaceProof({ ...input, confidential: true })
}
