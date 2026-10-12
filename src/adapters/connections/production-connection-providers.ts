import type {
  AgentWorkspaceBranching,
  AgentWorkspaceBranchingProvider,
} from '@tangle-network/agent-interface'
import { canonicalCandidateDigest } from '@tangle-network/agent-interface'
import type {
  AgentEnvironment,
  AgentEnvironmentCapabilities,
  AgentEnvironmentProvider,
} from '@tangle-network/agent-interface/environment-provider'
import { createCliBridgeProvider } from '@tangle-network/agent-provider-cli-bridge'
import {
  createTangleProvider,
  defaultTangleSandboxCapabilities,
  type SandboxClientLike,
} from '@tangle-network/agent-provider-tangle'
import type {
  ExecutionConnection,
  WorkerInteractiveProviderResolver,
} from '@tangle-network/agent-runtime/kernel'
import { Sandbox } from '@tangle-network/sandbox'
import { ConnectionError } from '../../app/connection-errors.js'
import { type ConnectionRegistry, connectionExecutionDigest } from '../../app/connections.js'
import type { ConnectionRecord } from '../../domain/entities.js'
import { assertConnectionRecord } from '../../domain/invariants-profile.js'
import {
  environmentSupportsInteractionResponse,
  supportsNativeContinuation,
} from '../../ports/execution.js'
import { withRetainedSandboxPolicy } from '../runtime/tangle-sandbox-retention.js'
import {
  nitroVerifiersForConnection,
  normalizeNitroConfidentialAttestationTrustPolicy,
} from './nitro-confidential-attestation.js'
import { readConnectionCredential } from './production-connection-credentials.js'
import { connectionEndpoint } from './production-connection-endpoints.js'
import type {
  ConnectionCapabilityAction,
  ConnectionCapabilityReport,
  ConnectionProviderMethods,
  ConnectionRuntimeCapabilities,
  ProductionConnectionOptions,
} from './production-connection-types.js'
import {
  createConnectionProviderResolver,
  createRegisteredEnvironmentProvider,
} from './registered-provider.js'
import { supportsTangleRetainedControlLookup } from './tangle-retained-control-lookup.js'

export async function createTangleSandboxClient(
  record: ConnectionRecord,
  options: ProductionConnectionOptions,
  signal?: AbortSignal,
): Promise<SandboxClientLike> {
  signal?.throwIfAborted()
  if (options.sandboxClient) return options.sandboxClient
  const endpoint = connectionEndpoint(record, options)
  const apiKey = await readConnectionCredential(record, options, endpoint)
  signal?.throwIfAborted()
  if (!apiKey) {
    throw new ConnectionError(
      'CONNECTION_CREDENTIAL_REQUIRED',
      'Tangle sandbox requires an API credential',
      { connectionId: record.id },
    )
  }
  if (options.sandboxClientFactory) {
    return options.sandboxClientFactory({ record, endpoint, apiKey, ...(signal ? { signal } : {}) })
  }
  // SandboxInstance exposes `name: string | undefined` in its declaration,
  // while SandboxClientLike uses exact-optional fields; the published runtime
  // objects are structurally compatible for the provider methods we consume.
  return new Sandbox({ baseUrl: endpoint, apiKey }) as unknown as SandboxClientLike
}

/** Construct the selected Tangle provider without creating or retaining an environment. */
export async function createTangleEnvironmentProvider(
  record: ConnectionRecord,
  options: ProductionConnectionOptions,
  signal?: AbortSignal,
): Promise<AgentEnvironmentProvider> {
  assertConnectionRecord(record)
  const { lifecycle, idleTtlSeconds } = record.providerOptions
  const confidential = nitroVerifiersForConnection(record, options)
  const client = await createTangleSandboxClient(record, options, signal)
  signal?.throwIfAborted()
  return createTangleProvider({
    client:
      lifecycle === 'retained' && idleTtlSeconds !== undefined
        ? withRetainedSandboxPolicy(client, idleTtlSeconds)
        : client,
    name: 'tangle-sandbox',
    ...(confidential?.tangle === undefined
      ? {}
      : { confidentialAttestationVerifier: confidential.tangle }),
  })
}

/** Bind a new worker to the saved connection and the public transport actually used. */
export function createSupervisorExecutionConnection(
  record: ConnectionRecord,
  options: ProductionConnectionOptions = {},
): ExecutionConnection {
  return Object.freeze({
    connectionId: record.id,
    executionConfigDigest: canonicalCandidateDigest({
      connectionDigest: connectionExecutionDigest(record),
      endpoint: connectionEndpoint(record, options),
      confidentialAttestationPolicy:
        options.tangleConfidentialAttestationPolicy ?? record.confidentialAttestationPolicy ?? null,
    }),
  })
}

/** Resolve only the connection attested by Runtime's exact live worker receipt. */
export function createSupervisorWorkerProviderResolver(
  connections: ConnectionRegistry,
  options: ProductionConnectionOptions,
): WorkerInteractiveProviderResolver {
  // A startup-wide client has no saved-account binding. Only a record-aware
  // factory or the official client may reconstruct another worker's owner.
  const { sandboxClient: _startupClient, ...configuredOptions } = options
  const connectionOptions = Object.freeze({
    ...configuredOptions,
    ...(configuredOptions.tangleConfidentialAttestationPolicy === undefined
      ? {}
      : {
          tangleConfidentialAttestationPolicy: normalizeNitroConfidentialAttestationTrustPolicy(
            configuredOptions.tangleConfidentialAttestationPolicy,
          ),
        }),
  })
  const resolveRegistered = createConnectionProviderResolver(connectionOptions)
  return async ({ binding, executionConnection, signal }) => {
    signal?.throwIfAborted()
    if (executionConnection === undefined) return undefined
    let record: ConnectionRecord
    try {
      record = connections.select({ connectionId: executionConnection.connectionId }).record
    } catch (error) {
      if (error instanceof ConnectionError) return undefined
      throw error
    }
    try {
      if (
        createSupervisorExecutionConnection(record, connectionOptions).executionConfigDigest !==
        executionConnection.executionConfigDigest
      )
        return undefined
    } catch (error) {
      if (error instanceof ConnectionError) return undefined
      throw error
    }
    if (record.kind === 'tangle-sandbox' && binding.ref.run.provider === 'tangle-sandbox')
      return createTangleEnvironmentProvider(record, connectionOptions, signal)
    if (
      record.kind === 'agent-provider' &&
      record.providerOptions.provider === binding.ref.run.provider
    )
      return resolveRegistered(record, signal)
    return undefined
  }
}

/**
 * Create a restart-safe source lookup without retaining a live environment.
 *
 * The provider constructs the source-scoped handle and owns every Sandbox call.
 * Braid retains only this lazy factory, so restart recovery cannot use stale state.
 */
export function createTangleWorkspaceBranchingProvider(
  record: ConnectionRecord,
  options: ProductionConnectionOptions,
): AgentWorkspaceBranchingProvider {
  return Object.freeze({
    async forEnvironment(
      sourceEnvironmentId: string,
      operation?: { readonly signal?: AbortSignal },
    ): Promise<AgentWorkspaceBranching | null> {
      const provider = await createTangleEnvironmentProvider(record, options, operation?.signal)
      const branching = provider.workspaceBranching
      if (branching === undefined) return null
      return branching.forEnvironment(sourceEnvironmentId, operation)
    },
  })
}

/** Reconstruct one provider environment for an independent workspace check. */
export async function getTangleSandboxEnvironment(
  record: ConnectionRecord,
  options: ProductionConnectionOptions,
  environmentId: string,
  signal?: AbortSignal,
): Promise<AgentEnvironment | null> {
  const provider = await createTangleEnvironmentProvider(record, options, signal)
  if (provider.get === undefined) return null
  return provider.get(environmentId, signal === undefined ? undefined : { signal })
}

export async function capabilitiesForConnection(
  record: ConnectionRecord,
  options: ProductionConnectionOptions,
): Promise<ConnectionCapabilityReport> {
  switch (record.kind) {
    case 'cli-bridge': {
      const endpoint = connectionEndpoint(record, options)
      const provider = createCliBridgeProvider({ baseUrl: endpoint })
      const environment = await provider.capabilities()
      return capabilityReport(record, 'chat', environment, {
        create: typeof provider.create === 'function',
        get: typeof provider.get === 'function',
        list: typeof provider.list === 'function',
      })
    }
    case 'agent-provider': {
      const provider = await createRegisteredEnvironmentProvider(record, options)
      const reported = await provider.capabilities()
      const environment = retainedConnectionCapabilities(
        record,
        reported,
        provider.get !== undefined,
      )
      const executable = reported.streaming.live && reported.create?.durableIdempotency === true
      return capabilityReport(record, 'executor', environment, {
        create: executable && typeof provider.create === 'function',
        get: typeof provider.get === 'function',
        list: typeof provider.list === 'function',
      })
    }
    case 'tangle-inference':
      connectionEndpoint(record, options)
      return capabilityReport(record, 'chat', undefined, {
        create: true,
        get: false,
        list: false,
      })
    case 'tangle-sandbox': {
      const confidential = nitroVerifiersForConnection(record, options)
      const reported =
        options.sandboxClient === undefined
          ? {
              ...defaultTangleSandboxCapabilities(),
              branching: {
                checkpoint: false,
                fork: false,
                confidential: false,
                retrySafe: false,
                lookup: false,
                cleanup: false,
              },
              confidential: false,
            }
          : await createTangleProvider({
              client: options.sandboxClient,
              ...(confidential?.tangle === undefined
                ? {}
                : {
                    confidentialAttestationVerifier: confidential.tangle,
                  }),
            }).capabilities()
      const environment = retainedConnectionCapabilities(
        record,
        reported,
        options.tangleRetainedControlLookup !== undefined ||
          options.sandboxClient === undefined ||
          supportsTangleRetainedControlLookup(options.sandboxClient),
      )
      const client = options.sandboxClient
      return capabilityReport(record, 'executor', environment, {
        create: true,
        get: client === undefined ? 'unknown' : typeof client.get === 'function',
        list: client === undefined ? 'unknown' : typeof client.list === 'function',
      })
    }
  }
}

function retainedConnectionCapabilities(
  record: ConnectionRecord,
  reported: AgentEnvironmentCapabilities,
  hasRetainedControlLookup = false,
): AgentEnvironmentCapabilities {
  if (record.providerOptions.lifecycle !== 'retained') {
    return {
      ...reported,
      streaming: { ...reported.streaming, replay: false, detach: false },
      sessions: { ...reported.sessions, continue: false, list: false, messages: false },
    }
  }
  const retained = reported.retainedControl
  const exactRetained =
    hasRetainedControlLookup &&
    retained?.exactRunIdentity === true &&
    retained.resultIdentity === true &&
    retained.eventIdentity === true &&
    retained.cancellationIdempotency === true &&
    reported.streaming.replay &&
    reported.streaming.detach &&
    reported.streaming.turnIdempotency
  return {
    ...reported,
    streaming: {
      ...reported.streaming,
      live: exactRetained && reported.streaming.live,
      replay: exactRetained && reported.streaming.replay,
      detach: exactRetained && reported.streaming.detach,
      turnIdempotency: exactRetained && reported.streaming.turnIdempotency,
    },
    sessions: {
      ...reported.sessions,
      continue:
        record.kind === 'agent-provider' && exactRetained && supportsNativeContinuation(reported),
      list: false,
      messages: false,
    },
  }
}

function capabilityReport(
  record: ConnectionRecord,
  backend: ConnectionRuntimeCapabilities['backend'],
  environment: AgentEnvironmentCapabilities | undefined,
  providerMethods: ConnectionProviderMethods,
): ConnectionCapabilityReport {
  const streaming = environment?.streaming ?? {
    live: true,
    replay: false,
    detach: false,
    turnIdempotency: true,
  }
  const sessions = environment?.sessions ?? {
    continue: false,
    list: false,
    messages: false,
  }
  const runtime: ConnectionRuntimeCapabilities = {
    backend,
    streaming,
    sessions,
    interactions: {
      originate: environment?.interactions !== undefined,
      respond: environmentSupportsInteractionResponse(environment),
    },
  }
  const actions: Record<ConnectionCapabilityAction, boolean> = {
    stream: runtime.streaming.live && providerMethods.create,
    replay: runtime.streaming.replay,
    detach: runtime.streaming.detach,
    'continue-session': runtime.sessions.continue,
    'list-sessions': runtime.sessions.list,
    'session-messages': runtime.sessions.messages,
    checkpoint: environment?.branching.checkpoint === true,
    fork: environment?.branching.fork === true,
    placement: environment?.placement === true,
    usage: environment?.usage === true,
    'respond-interaction': runtime.interactions.respond,
  }
  return Object.freeze({
    connectionId: record.id,
    kind: record.kind,
    runtime: Object.freeze({
      ...runtime,
      streaming: Object.freeze(runtime.streaming),
      sessions: Object.freeze(runtime.sessions),
      interactions: Object.freeze(runtime.interactions),
    }),
    ...(environment ? { environment } : {}),
    providerMethods: Object.freeze(providerMethods),
    actions: Object.freeze(actions),
  })
}
