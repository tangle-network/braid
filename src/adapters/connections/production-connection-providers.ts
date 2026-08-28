import type {
  AgentWorkspaceBranching,
  AgentWorkspaceBranchingProvider,
} from '@tangle-network/agent-interface'
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
import { Sandbox } from '@tangle-network/sandbox'
import { ConnectionError } from '../../app/connection-errors.js'
import type { ConnectionRecord } from '../../domain/entities.js'
import { environmentSupportsInteractionResponse } from '../../ports/execution.js'
import { readConnectionCredential } from './production-connection-credentials.js'
import { connectionEndpoint } from './production-connection-endpoints.js'
import type {
  ConnectionCapabilityAction,
  ConnectionCapabilityReport,
  ConnectionProviderMethods,
  ConnectionRuntimeCapabilities,
  ProductionConnectionOptions,
} from './production-connection-types.js'
import { supportsTangleRetainedControlLookup } from './tangle-retained-control-lookup.js'

export async function createTangleSandboxClient(
  record: ConnectionRecord,
  options: ProductionConnectionOptions,
  signal?: AbortSignal,
): Promise<SandboxClientLike> {
  if (options.sandboxClient) return options.sandboxClient
  const endpoint = connectionEndpoint(record, options)
  const apiKey = await readConnectionCredential(record, options, endpoint)
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
  const client = await createTangleSandboxClient(record, options, signal)
  return createTangleProvider({
    client,
    name: 'tangle-sandbox',
    ...(options.tangleConfidentialAttestationVerifier === undefined
      ? {}
      : { confidentialAttestationVerifier: options.tangleConfidentialAttestationVerifier }),
  })
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
    case 'tangle-inference':
      connectionEndpoint(record, options)
      return capabilityReport(record, 'chat', undefined, {
        create: true,
        get: false,
        list: false,
      })
    case 'tangle-sandbox': {
      const reported =
        options.sandboxClient === undefined
          ? {
              ...defaultTangleSandboxCapabilities(),
              branching: {
                checkpoint: false,
                fork: false,
                retrySafe: false,
                lookup: false,
                cleanup: false,
              },
              confidential: false,
            }
          : await createTangleProvider({
              client: options.sandboxClient,
              ...(options.tangleConfidentialAttestationVerifier === undefined
                ? {}
                : {
                    confidentialAttestationVerifier: options.tangleConfidentialAttestationVerifier,
                  }),
            }).capabilities()
      const environment = tangleConnectionCapabilities(
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

function tangleConnectionCapabilities(
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
    sessions: { ...reported.sessions, continue: false, list: false, messages: false },
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
