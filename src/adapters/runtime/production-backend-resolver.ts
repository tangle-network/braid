import {
  type AgentProfile,
  type HarnessType,
  harnessSupportsModel,
  snapHarnessToModel,
} from '@tangle-network/agent-interface'
import type { AgentEnvironmentCapabilities } from '@tangle-network/agent-interface/environment-provider'
import type { ResolveAgentBackendOptions } from '@tangle-network/agent-runtime'
import type { AgentTurnBackend } from '@tangle-network/agent-runtime/kernel'
import type { BackendType, PromptOptions } from '@tangle-network/sandbox'
import { ConnectionError } from '../../app/connection-errors.js'
import type { ConnectionCatalog, ConnectionSelectionInput } from '../../app/connections.js'
import type { ExecuteTurnInput } from '../../ports/execution.js'
import {
  bridgeRunnerSupportsModel,
  materializeBridgeModelRoute,
  qualifyBridgeProfileModel,
} from '../connections/cli-bridge-model-route.js'
import { readConnectionCredential } from '../connections/production-connection-credentials.js'
import {
  connectionEndpoint,
  normalizeCliBridgeProviderBaseUrl,
} from '../connections/production-connection-endpoints.js'
import type { ProductionConnectionOptions } from '../connections/production-connection-types.js'
import type {
  PreparedExecution,
  PreparedSandboxExecution,
  SandboxLifecyclePolicy,
} from './prepared-execution.js'

export interface ProductionExecutionSelection {
  readonly connection: ConnectionSelectionInput
  readonly model?: string
  readonly runner?: HarnessType
}

export type ProductionExecutionSelector = (
  input: ExecuteTurnInput,
) => ProductionExecutionSelection | Promise<ProductionExecutionSelection>

export interface ProductionBackendResolverOptions extends ProductionConnectionOptions {
  readonly connections: ConnectionCatalog
  readonly select: ProductionExecutionSelector
  readonly retry?: ResolveAgentBackendOptions['retry']
  readonly defaultSandboxBackend?: BackendType
  readonly workspaceCwd?: string
}

/**
 * Adapt the application selector to Braid's existing runtime-port resolver.
 * The selector is the only place that chooses a connection; this adapter never
 * searches by name, endpoint, or provider kind.
 */
export function createProductionBackendResolver(
  options: ProductionBackendResolverOptions,
): (input: ExecuteTurnInput) => Promise<PreparedExecution> {
  return async (input) => {
    const selected = await options.select(input)
    const selection =
      input.connectionId === undefined
        ? selected
        : { ...selected, connection: { connectionId: input.connectionId } }
    return resolveProductionBackend(options, input, selection)
  }
}

export async function resolveProductionBackend(
  options: ProductionBackendResolverOptions,
  input: ExecuteTurnInput,
  selection: ProductionExecutionSelection,
): Promise<PreparedExecution> {
  const selected = options.connections.select(selection.connection)
  const record = selected.record
  const endpoint = connectionEndpoint(record, options)

  switch (record.kind) {
    case 'cli-bridge':
      return resolveCliBridgeBackend(options, input, selection, record.id, endpoint)
    case 'tangle-inference':
      return resolveTangleInferenceBackend(options, input, selection, record.id, endpoint)
    case 'tangle-sandbox':
      return resolveTangleSandboxBackend(options, input, selection, record.id)
  }
}

async function resolveCliBridgeBackend(
  options: ProductionBackendResolverOptions,
  input: ExecuteTurnInput,
  selection: ProductionExecutionSelection,
  connectionId: Parameters<typeof connectionEndpoint>[0]['id'],
  endpoint: string,
): Promise<PreparedSandboxExecution> {
  const { createCliBridgeProvider } = await import('@tangle-network/agent-provider-cli-bridge')
  const model = await requiredModel(input.profile, selection.model, connectionId)
  const runner = selection.runner ?? input.profile.harness
  if (runner === undefined) {
    throw new ConnectionError(
      'CONNECTION_MODEL_HARNESS_MISMATCH',
      `CLI Bridge requires a runner for model=${model}; choose a profile with a runner or select one for this run.`,
      { connectionId },
    )
  }
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
  const route = materializeBridgeModelRoute(runner, model)
  const credential = await readConnectionCredential(
    inputRecord(connectionId, options),
    options,
    endpoint,
  )
  const provider = createCliBridgeProvider({
    baseUrl: normalizeCliBridgeProviderBaseUrl(endpoint, connectionId),
    defaultModel: route,
    ...(credential === undefined ? {} : { bearerToken: credential }),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  return createSandboxPlan({
    provider,
    input,
    connectionId,
    model: route,
    runner,
    providerName: 'cli-bridge',
    recordName: inputRecord(connectionId, options).name,
    ...(options.workspaceCwd === undefined ? {} : { workspaceCwd: options.workspaceCwd }),
  })
}

async function resolveTangleInferenceBackend(
  options: ProductionBackendResolverOptions,
  input: ExecuteTurnInput,
  selection: ProductionExecutionSelection,
  connectionId: Parameters<typeof connectionEndpoint>[0]['id'],
  endpoint: string,
): Promise<AgentTurnBackend> {
  const { resolveAgentBackend } = await import('@tangle-network/agent-runtime')
  const model = await requiredModel(input.profile, selection.model, connectionId)
  const credential = await readConnectionCredential(
    inputRecord(connectionId, options),
    options,
    endpoint,
  )
  const backend = resolveAgentBackend({
    kind: 'tcloud',
    apiKey: credential ?? '',
    baseUrl: endpoint,
    model,
    label: 'tangle-inference',
    ...(options.fetch ? { fetchImpl: options.fetch } : {}),
    ...(options.retry ? { retry: options.retry } : {}),
  })
  return { kind: 'chat', backend }
}

async function resolveTangleSandboxBackend(
  options: ProductionBackendResolverOptions,
  input: ExecuteTurnInput,
  selection: ProductionExecutionSelection,
  connectionId: Parameters<typeof connectionEndpoint>[0]['id'],
): Promise<PreparedSandboxExecution> {
  if (input.sessionId !== undefined) {
    throw new ConnectionError(
      'CONNECTION_UNSUPPORTED',
      'Tangle sandbox session continuity is unavailable until retained environment recovery is supported',
      { connectionId },
    )
  }
  const [{ createTangleSandboxClient }, { createTangleProvider }] = await Promise.all([
    import('../connections/production-connection-providers.js'),
    import('@tangle-network/agent-provider-tangle'),
  ])
  const { cleanModelId } = await import('@tangle-network/agent-runtime')
  const backend = await sandboxBackendType(
    input.profile,
    selection.runner,
    options.defaultSandboxBackend,
    connectionId,
  )
  const model = cleanModelId(selection.model ?? input.profile.model?.default)
  if (model !== undefined && !harnessSupportsModel(backend, model)) {
    const suggestedRunner = snapHarnessToModel(backend, model)
    const runnerChoice =
      suggestedRunner === backend
        ? 'choose a runner compatible with this model'
        : `choose runner=${suggestedRunner} to keep model=${model}`
    throw new ConnectionError(
      'CONNECTION_MODEL_HARNESS_MISMATCH',
      `Profile field harness=${backend} does not support model=${model}. The authored profile was not changed; ${runnerChoice}, or choose a model advertised for runner=${backend}.`,
      { connectionId },
    )
  }
  const record = inputRecord(connectionId, options)
  const client = await createTangleSandboxClient(record, options, input.signal)
  const provider = createTangleProvider({
    client,
    defaultBackend: backend,
    name: 'tangle-sandbox',
  })
  return createSandboxPlan({
    provider,
    input,
    connectionId,
    ...(model === undefined ? {} : { model }),
    runner: backend,
    providerName: 'tangle-sandbox',
    recordName: record.name,
    ...(options.workspaceCwd === undefined ? {} : { workspaceCwd: options.workspaceCwd }),
  })
}

async function createSandboxPlan(input: {
  readonly provider: import('@tangle-network/agent-interface/environment-provider').AgentEnvironmentProvider
  readonly input: ExecuteTurnInput
  readonly connectionId: string
  readonly model?: string
  readonly runner?: string
  readonly providerName: string
  readonly recordName: string
  readonly workspaceCwd?: string
}): Promise<PreparedSandboxExecution> {
  const { providerAsSandboxClient } = await import(
    '@tangle-network/agent-runtime/environment-provider'
  )
  const providerCapabilities = await input.provider.capabilities()
  const lifecycle = lifecycleForProvider(input.providerName)
  const capabilities = capabilitiesForLifecycle(providerCapabilities, lifecycle)
  const { snapshotAgentProfile } = await import('@tangle-network/agent-interface')
  const profile = snapshotAgentProfile(input.input.profile)
  const providerSessionId = providerSessionFor(input.input, capabilities)
  const environmentId = `env-braid-${safeId(input.input.runId)}`
  const createInput = freezeDeep({
    profile,
    ...(input.runner === undefined ? {} : { backend: input.runner }),
    workspace: { cwd: requiredWorkspaceCwd(input.input.workspaceRoot, input.workspaceCwd) },
    name: input.recordName,
    idempotencyKey: environmentId,
  })
  const turnOptions = freezeDeep({
    ...(providerSessionId === undefined ? {} : { sessionId: providerSessionId }),
    ...(input.model === undefined ? {} : { model: input.model }),
    executionId: input.input.runId,
    turnId: input.input.operationId,
  } satisfies Omit<PromptOptions, 'signal'>)
  const materializationReceipt = freezeDeep({
    provider: input.providerName,
    backend: 'box',
    connectionId: input.connectionId,
    environmentId,
    lifecycle: lifecycle.mode,
    cleanup: lifecycle.cleanup,
    continuity: lifecycle.continuity,
    ...(lifecycle.reason === undefined ? {} : { continuityReason: lifecycle.reason }),
    portableContext: 'unavailable',
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.runner === undefined ? {} : { runner: input.runner }),
  })
  const client = providerAsSandboxClient(input.provider, {
    defaults: createInput,
    requireTerminalEvent: true,
  })
  return Object.freeze({
    kind: 'sandbox-plan' as const,
    client,
    createInput,
    prompt: input.input.text,
    turnOptions,
    agentRunName: input.model ?? input.recordName,
    capabilities,
    environmentId,
    lifecycle,
    ...(providerSessionId === undefined ? {} : { providerSessionId }),
    materializationReceipt,
  })
}

function lifecycleForProvider(providerName: string): SandboxLifecyclePolicy {
  if (providerName === 'tangle-sandbox') {
    return {
      mode: 'ephemeral',
      cleanup: 'delete-after-turn',
      continuity: 'unavailable',
      reason: 'Retained Tangle environment recovery is not exposed by the current Braid port',
    }
  }
  return { mode: 'ephemeral', cleanup: 'delete-after-turn', continuity: 'session' }
}

function capabilitiesForLifecycle(
  capabilities: AgentEnvironmentCapabilities,
  lifecycle: SandboxLifecyclePolicy,
): AgentEnvironmentCapabilities {
  if (lifecycle.continuity === 'session') return capabilities
  return {
    ...capabilities,
    sessions: { ...capabilities.sessions, continue: false, list: false, messages: false },
    branching: { ...capabilities.branching, checkpoint: false, fork: false },
  }
}

function providerSessionFor(
  input: ExecuteTurnInput,
  capabilities: AgentEnvironmentCapabilities,
): string | undefined {
  if (!capabilities.sessions.continue) return undefined
  return input.sessionId ?? `session-braid-${safeId(input.runId)}`
}

function safeId(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._:-]/gu, '-')
  return safe.slice(0, 128) || 'run'
}

async function requiredModel(
  profile: Readonly<AgentProfile>,
  override: string | undefined,
  connectionId: Parameters<typeof connectionEndpoint>[0]['id'],
): Promise<string> {
  const { cleanModelId } = await import('@tangle-network/agent-runtime')
  const authored = cleanModelId(override ?? profile.model?.default)
  if (!authored) {
    throw new ConnectionError(
      override === undefined ? 'CONNECTION_MODEL_REQUIRED' : 'CONNECTION_MODEL_INVALID',
      'The selected connection requires a non-empty model id',
      { connectionId },
    )
  }
  return qualifyBridgeProfileModel(authored, profile.model?.provider)
}

function requiredWorkspaceCwd(
  inputRoot: string | undefined,
  configuredRoot: string | undefined,
): string {
  const workspace = inputRoot ?? configuredRoot
  if (workspace === undefined || workspace.length === 0) {
    throw new ConnectionError(
      'CONNECTION_WORKSPACE_REQUIRED',
      'The production execution path requires the canonical workspace root',
    )
  }
  return workspace
}

async function sandboxBackendType(
  profile: Readonly<AgentProfile>,
  override: HarnessType | undefined,
  configured: BackendType | undefined,
  connectionId: Parameters<typeof connectionEndpoint>[0]['id'],
): Promise<BackendType> {
  const requested = override ?? profile.harness ?? configured ?? 'opencode'
  try {
    const { parseBackendType } = await import('@tangle-network/sandbox')
    return parseBackendType(requested)
  } catch {
    throw new ConnectionError(
      'CONNECTION_UNSUPPORTED',
      'The selected harness is not supported by the published sandbox package',
      { connectionId },
    )
  }
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}

function inputRecord(
  connectionId: Parameters<typeof connectionEndpoint>[0]['id'],
  options: ProductionBackendResolverOptions,
) {
  const record = options.connections.get(connectionId)
  if (!record) {
    throw new ConnectionError('CONNECTION_NOT_FOUND', 'The selected connection does not exist', {
      connectionId,
    })
  }
  return record
}
