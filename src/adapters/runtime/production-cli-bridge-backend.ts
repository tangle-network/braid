import type {
  AgentEnvironmentCapabilities,
  AgentProfile,
  HarnessType,
} from '@tangle-network/agent-interface'
import type { CliBridgeProvider } from '@tangle-network/agent-provider-cli-bridge'
import type { BridgeModelCredential } from '@tangle-network/agent-runtime/kernel'
import { ConnectionError } from '../../app/connection-errors.js'
import type { ConnectionId } from '../../domain/ids.js'
import type { ExecuteTurnInput } from '../../ports/execution.js'
import { snapHarnessToModel } from '../agent-interface/harness-runtime.js'
import {
  bridgeRunnerSupportsModel,
  materializeBridgeModelRoute,
} from '../connections/cli-bridge-model-route.js'
import { readConnectionCredential } from '../connections/production-connection-credentials.js'
import {
  isLoopbackEndpoint,
  normalizeCliBridgeProviderBaseUrl,
} from '../connections/production-connection-endpoints.js'
import { endpointLocation, staticExecutionObservation } from './execution-observation-source.js'
import type { PreparedExecution } from './prepared-execution.js'
import {
  connectionRecord,
  exactExecutionProfile,
  freezeExecution,
  type ProductionBackendResolverOptions,
  type ProductionExecutionSelection,
  requiredProfileModel,
  requiredProfileRunner,
  requiredWorkspaceCwd,
  stableProviderId,
} from './production-backend-common.js'

const LOCAL_BRIDGE_BEARER = 'braid-local-cli-bridge'

export interface PreparedCliBridgeConnection {
  readonly profile: Readonly<AgentProfile>
  readonly model: string
  readonly runner: HarnessType
  readonly route: string
  readonly workspace: string
  readonly bridgeUrl: string
  readonly bearerToken: string
  readonly bridgeModelCredential?: BridgeModelCredential
  readonly fetch?: typeof fetch
  readonly providerSessionId: string
  readonly provider: CliBridgeProvider
  readonly capabilities: AgentEnvironmentCapabilities
  readonly observation: NonNullable<PreparedExecution['observation']>
  readonly materializationReceipt: Readonly<Record<string, unknown>>
}

export async function prepareCliBridgeConnection(
  options: ProductionBackendResolverOptions,
  input: ExecuteTurnInput,
  selection: ProductionExecutionSelection,
  connectionId: ConnectionId,
  endpoint: string,
): Promise<PreparedCliBridgeConnection> {
  const profile = await exactExecutionProfile(input.profile, selection, connectionId, {
    requireProvider: false,
  })
  const model = requiredProfileModel(profile, connectionId)
  const runner = requiredProfileRunner(profile, connectionId)
  if (!bridgeRunnerSupportsModel(runner, model)) {
    const suggestedRunner = snapHarnessToModel(runner, model)
    const runnerChoice =
      suggestedRunner === runner
        ? 'choose a runner compatible with this model'
        : `choose runner=${suggestedRunner} to keep model=${model}`
    throw new ConnectionError(
      'CONNECTION_MODEL_HARNESS_MISMATCH',
      `Profile runner=${runner} does not support model=${model}. The authored profile was not changed; ${runnerChoice}, or choose a model advertised for runner=${runner}.`,
      { connectionId },
    )
  }

  const record = connectionRecord(connectionId, options)
  const credential = await readConnectionCredential(record, options, endpoint)
  const providerSessionId = input.sessionId ?? stableProviderId('session-braid-', input.runId)
  const route = materializeBridgeModelRoute(runner, model, profile.model?.provider)
  const workspace = requiredWorkspaceCwd(input.workspaceRoot, options.workspaceCwd)
  const bridgeUrl = normalizeCliBridgeProviderBaseUrl(endpoint, connectionId)
  const bridgeLocation = endpointLocation(bridgeUrl)
  const createdAt = new Date().toISOString()
  const { createCliBridgeProvider } = await import('@tangle-network/agent-provider-cli-bridge')
  const providerFetch =
    options.bridgeModelCredential === undefined
      ? options.fetch
      : bridgeCredentialFetch(
          bridgeUrl,
          options.bridgeModelCredential,
          options.fetch ?? globalThis.fetch,
        )
  const providerOptions = {
    baseUrl: bridgeUrl,
    bearerToken: credential ?? LOCAL_BRIDGE_BEARER,
    defaultModel: route,
    ...(runner === 'pi'
      ? {
          defaultExecution: {
            kind: 'host' as const,
            jail: { mode: 'fs-jail' as const },
          },
        }
      : {}),
    ...(providerFetch === undefined ? {} : { fetch: providerFetch }),
  }
  const provider = createCliBridgeProvider(providerOptions)
  const capabilities = await provider.capabilities()
  return freezeExecution({
    profile,
    model,
    runner,
    route,
    workspace,
    bridgeUrl,
    bearerToken: credential ?? LOCAL_BRIDGE_BEARER,
    ...(options.bridgeModelCredential === undefined
      ? {}
      : { bridgeModelCredential: options.bridgeModelCredential }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    provider,
    capabilities,
    providerSessionId,
    observation: staticExecutionObservation({
      kind: bridgeLocation.location === 'local' ? 'local-process' : 'remote-service',
      provider: 'cli-bridge',
      lifecycle: 'ready',
      lifecycleMode: 'retained',
      cleanup: 'explicit',
      continuity: 'session',
      ...bridgeLocation,
      createdAt,
      unavailable: [
        'cli-subscription-and-quota:not-exposed-by-provider',
        'effective-resources:not-exposed-by-provider',
        'machine-specs:not-exposed-by-provider',
        'runtime-cpu-memory-usage:not-exposed-by-provider',
      ],
    }),
    materializationReceipt: {
      provider: 'cli-bridge',
      backend: 'executor',
      connectionId,
      sessionId: providerSessionId,
      lifecycle: 'retained-session',
      cleanup: 'explicit',
      portableContext: 'unavailable',
      workspace,
      model,
      route,
      runner,
    },
  })
}

function bridgeCredentialFetch(
  bridgeUrl: string,
  credential: BridgeModelCredential,
  fetcher: typeof fetch,
): typeof fetch {
  if (!isLoopbackEndpoint(bridgeUrl)) {
    throw new Error('A request-scoped CLI Bridge model credential requires a loopback endpoint')
  }
  return async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
    )
    if (!usesBridgeModelCredential(url, init)) return fetcher(input, init)
    const [token, baseUrl] = await Promise.all([
      credentialValue(credential, credential.key),
      credentialValue(credential, credential.baseUrlKey),
    ])
    const upstream = safeModelBaseUrl(baseUrl)
    const headers = new Headers(init?.headers)
    headers.set('x-cli-bridge-model-credential', token)
    headers.set('x-cli-bridge-model-base-url', upstream)
    return fetcher(input, { ...init, headers })
  }
}

function usesBridgeModelCredential(url: URL, init?: RequestInit): boolean {
  const method = init?.method?.toUpperCase() ?? 'GET'
  if (method !== 'POST') return false
  return (
    url.pathname === '/v1/chat/completions' ||
    url.pathname === '/v1/sessions' ||
    /^\/v1\/sessions\/[^/]+\/(?:turns|continue)$/u.test(url.pathname)
  )
}

async function credentialValue(credential: BridgeModelCredential, key: string): Promise<string> {
  let value: string | undefined
  try {
    value = await credential.provider.get(key)
  } catch {
    throw new Error(`The CLI Bridge model credential provider failed for ${key}`)
  }
  if (typeof value !== 'string' || value.length === 0 || /[\r\n\0]/u.test(value)) {
    throw new Error(`The CLI Bridge model credential provider has no usable value for ${key}`)
  }
  return value
}

function safeModelBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('The CLI Bridge model credential base URL is invalid')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(
      'The CLI Bridge model credential base URL must be an HTTPS URL without credentials',
    )
  }
  return url.toString().replace(/\/$/u, '')
}
