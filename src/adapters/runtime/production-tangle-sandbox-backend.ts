import type { AgentExactRunControlRef, AgentProfile } from '@tangle-network/agent-interface'
import type {
  AgentEnvironmentCapabilities,
  AgentEnvironmentProvider,
} from '@tangle-network/agent-interface/environment-provider'
import type { SandboxClientLike } from '@tangle-network/agent-provider-tangle'
import type { SandboxClient } from '@tangle-network/agent-runtime/kernel'
import type { BackendType, CreateSandboxOptions, SandboxInstance } from '@tangle-network/sandbox'
import { ConnectionError } from '../../app/connection-errors.js'
import { canonicalDigest } from '../../domain/canonical.js'
import type { ConnectionId } from '../../domain/ids.js'
import type { ExecuteTurnInput } from '../../ports/execution.js'
import { harnessSupportsModel, snapHarnessToModel } from '../agent-interface/harness-runtime.js'
import type {
  ExecutionObservationSource,
  PreparedExecution,
  SandboxLifecyclePolicy,
} from './prepared-execution.js'
import {
  connectionRecord,
  exactExecutionProfile,
  freezeExecution,
  type ProductionBackendResolverOptions,
  type ProductionExecutionSelection,
  requiredProfileModel,
  requiredProfileRunner,
  safeExecutionId,
} from './production-backend-common.js'
import { observeSandboxClient } from './sandbox-observation.js'
import { withSandboxResultProjection } from './sandbox-result-projection.js'
import {
  retainedSandboxIdentity,
  retainedSandboxLifecycle,
  withRetainedSandboxPolicy,
} from './tangle-sandbox-retention.js'

export async function resolveTangleSandboxBackend(
  options: ProductionBackendResolverOptions,
  input: ExecuteTurnInput,
  selection: ProductionExecutionSelection,
  connectionId: ConnectionId,
): Promise<PreparedExecution> {
  const record = connectionRecord(connectionId, options)
  if (record.providerOptions.lifecycle === 'retained') {
    throw new ConnectionError(
      'CONNECTION_UNSUPPORTED',
      'A retained Tangle sandbox connection must execute through the retained execution port',
      { connectionId },
    )
  }
  if (input.sessionId !== undefined) {
    throw new ConnectionError(
      'CONNECTION_UNSUPPORTED',
      'Tangle sandbox session continuity is unavailable until retained environment recovery is supported',
      { connectionId },
    )
  }
  const { profile, model, runner } = await tangleExecutionIdentity(input, selection, connectionId)

  const [{ createTangleSandboxClient }, { createTangleProvider }, { createExecutor }] =
    await Promise.all([
      import('../connections/production-connection-providers.js'),
      import('@tangle-network/agent-provider-tangle'),
      import('@tangle-network/agent-runtime/kernel'),
    ])
  const lifecycle = sandboxLifecycle()
  const idempotencyKey = `env-braid-${safeExecutionId(input.runId)}`
  const environmentRequestDigest = canonicalDigest({
    kind: 'tangle-sandbox-environment-request',
    idempotencyKey,
  })
  const rawClient = await createTangleSandboxClient(record, options, input.signal)
  const observedClient = observeSandboxClient(rawClient, lifecycle)
  const sdkProvider = createTangleProvider({
    client: observedClient.client,
    defaultBackend: runner,
    name: 'tangle-sandbox',
  })
  const capabilities = capabilitiesForLifecycle(await sdkProvider.capabilities(), lifecycle)
  const providerSessionId = providerSessionFor(input, capabilities)
  const backend = Object.freeze({
    kind: 'executor' as const,
    factory: withSandboxResultProjection((spec, context) =>
      createExecutor({
        backend: 'sandbox',
        sandboxClient: runtimeSandboxClient(
          observedClient.client,
          record.name,
          idempotencyKey,
          context.signal,
        ),
        maxIterations: 1,
      })(spec, context),
    ),
    profile,
    agentRunName: model,
  })
  return freezeExecution({
    kind: 'prepared-execution' as const,
    backend,
    capabilities,
    observation: observedClient.observation,
    ...(providerSessionId === undefined ? {} : { providerSessionId }),
    materializationReceipt: {
      provider: 'tangle-sandbox',
      backend: 'executor',
      connectionId,
      environmentRequestDigest,
      lifecycle: lifecycle.mode,
      cleanup: lifecycle.cleanup,
      continuity: lifecycle.continuity,
      ...(lifecycle.reason === undefined ? {} : { continuityReason: lifecycle.reason }),
      portableContext: 'unavailable',
      model,
      runner,
    },
  })
}

export interface PreparedTangleRetainedConnection {
  readonly profile: Readonly<AgentProfile>
  readonly model: string
  readonly runner: BackendType
  readonly provider: AgentEnvironmentProvider
  readonly capabilities: AgentEnvironmentCapabilities
  readonly observation: ExecutionObservationSource
  readonly providerSessionId: string
  readonly environmentIdempotencyKey: string
  readonly environmentName: string
  readonly environmentMetadata: Readonly<Record<string, unknown>>
  readonly idleTtlSeconds: number
  readonly discoverControlRef: (
    braidRunId: string,
    signal?: AbortSignal,
  ) => Promise<AgentExactRunControlRef | null>
  readonly materializationReceipt: Readonly<Record<string, unknown>>
}

/** Resolve a retained cloud session without creating the sandbox. */
export async function resolveTangleSandboxRetainedConnection(
  options: ProductionBackendResolverOptions,
  input: ExecuteTurnInput,
  selection: ProductionExecutionSelection,
  connectionId: ConnectionId,
): Promise<PreparedTangleRetainedConnection> {
  const record = connectionRecord(connectionId, options)
  const idleTtlSeconds = record.providerOptions.idleTtlSeconds
  if (record.providerOptions.lifecycle !== 'retained' || idleTtlSeconds === undefined) {
    throw new ConnectionError(
      'CONNECTION_UNSUPPORTED',
      'The retained Tangle port requires lifecycle=retained and idleTtlSeconds',
      { connectionId },
    )
  }
  const { profile, model, runner } = await tangleExecutionIdentity(input, selection, connectionId)
  const providerSessionId = input.sessionId ?? `session-braid-${safeExecutionId(input.runId)}`
  if (!providerSessionId.startsWith('session-braid-')) {
    throw new ConnectionError(
      'CONNECTION_UNSUPPORTED',
      'Retained Tangle continuation requires a Braid-owned provider session',
      { connectionId },
    )
  }
  const identity = retainedSandboxIdentity(providerSessionId)
  const retainedControlLookup = options.tangleRetainedControlLookup
  if (retainedControlLookup === undefined) {
    throw new ConnectionError(
      'CONNECTION_UNSUPPORTED',
      'Retained Tangle execution requires provider-backed lookup after an unacknowledged dispatch',
      { connectionId },
    )
  }
  const lifecycle = retainedSandboxLifecycle(idleTtlSeconds)
  const [{ createTangleSandboxClient }, { createTangleProvider }] = await Promise.all([
    import('../connections/production-connection-providers.js'),
    import('@tangle-network/agent-provider-tangle'),
  ])
  const rawClient = await createTangleSandboxClient(record, options, input.signal)
  if (rawClient.get === undefined) {
    throw new ConnectionError(
      'CONNECTION_UNSUPPORTED',
      'Retained Tangle execution requires exact sandbox reconstruction',
      { connectionId },
    )
  }
  const boundedClient = withRetainedSandboxPolicy(rawClient, idleTtlSeconds)
  const observedClient = observeSandboxClient(boundedClient, lifecycle)
  const provider = createTangleProvider({
    client: observedClient.client,
    defaultBackend: runner,
    name: 'tangle-sandbox',
  })
  const reportedCapabilities = await provider.capabilities()
  const retained = reportedCapabilities.retainedControl
  if (
    retained?.exactRunIdentity !== true ||
    retained.resultIdentity !== true ||
    retained.eventIdentity !== true ||
    retained.cancellationIdempotency !== true ||
    !reportedCapabilities.streaming.replay ||
    !reportedCapabilities.streaming.detach ||
    !reportedCapabilities.streaming.turnIdempotency
  ) {
    throw new ConnectionError(
      'CONNECTION_UNSUPPORTED',
      'The published Tangle provider did not report exact retained-run control',
      { connectionId },
    )
  }
  const capabilities = withoutNativeTangleContinuation(reportedCapabilities)
  const environmentRequestDigest = canonicalDigest({
    kind: 'tangle-retained-environment-request',
    idempotencyKey: identity.environmentIdempotencyKey,
    name: identity.name,
    metadata: identity.metadata,
    idleTtlSeconds,
  })
  return freezeExecution({
    profile,
    model,
    runner,
    provider,
    capabilities,
    observation: observedClient.observation,
    providerSessionId,
    environmentIdempotencyKey: identity.environmentIdempotencyKey,
    environmentName: identity.name,
    environmentMetadata: identity.metadata,
    idleTtlSeconds,
    discoverControlRef: (braidRunId, signal) =>
      retainedControlLookup({
        connectionId,
        braidRunId,
        providerSessionId,
        executionId: safeExecutionId(braidRunId),
        environmentIdempotencyKey: identity.environmentIdempotencyKey,
        ...(signal === undefined ? {} : { signal }),
      }),
    materializationReceipt: {
      provider: 'tangle-sandbox',
      backend: 'environment-provider',
      connectionId,
      environmentRequestDigest,
      lifecycle: lifecycle.mode,
      cleanup: lifecycle.cleanup,
      continuity: lifecycle.continuity,
      idleTtlSeconds,
      portableContext: 'unavailable',
      model,
      runner,
    },
  })
}

function withoutNativeTangleContinuation(
  reported: AgentEnvironmentCapabilities,
): AgentEnvironmentCapabilities {
  const capabilities = { ...reported }
  delete capabilities.nativeContinuation
  return Object.freeze({
    ...capabilities,
    sessions: Object.freeze({ ...reported.sessions, continue: false }),
  })
}

function runtimeSandboxClient(
  client: SandboxClientLike,
  name: string,
  idempotencyKey: string,
  signal: AbortSignal,
): SandboxClient {
  return Object.freeze({
    async create(createOptions?: CreateSandboxOptions) {
      return (await client.create(
        {
          ...createOptions,
          name,
          idempotencyKey,
        },
        { signal },
      )) as unknown as SandboxInstance
    },
  })
}

function sandboxLifecycle(): SandboxLifecyclePolicy {
  return {
    mode: 'ephemeral',
    cleanup: 'delete-after-turn',
    continuity: 'unavailable',
    reason: 'Retained Tangle environment recovery is not exposed by the current Braid port',
  }
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
  return input.sessionId ?? `session-braid-${safeExecutionId(input.runId)}`
}

async function tangleExecutionIdentity(
  input: ExecuteTurnInput,
  selection: ProductionExecutionSelection,
  connectionId: ConnectionId,
): Promise<{
  readonly profile: Readonly<AgentProfile>
  readonly model: string
  readonly runner: BackendType
}> {
  const profile = await exactExecutionProfile(input.profile, selection, connectionId)
  const model = requiredProfileModel(profile, connectionId)
  const runner = await sandboxBackendType(profile, connectionId)
  if (!harnessSupportsModel(runner, model)) {
    const suggestedRunner = snapHarnessToModel(runner, model)
    const runnerChoice =
      suggestedRunner === runner
        ? 'choose a runner compatible with this model'
        : `choose runner=${suggestedRunner} to keep model=${model}`
    throw new ConnectionError(
      'CONNECTION_MODEL_HARNESS_MISMATCH',
      `Profile field harness=${runner} does not support model=${model}. The authored profile was not changed; ${runnerChoice}, or choose a model advertised for runner=${runner}.`,
      { connectionId },
    )
  }
  return { profile, model, runner }
}

async function sandboxBackendType(
  profile: Readonly<AgentProfile>,
  connectionId: ConnectionId,
): Promise<BackendType> {
  const requested = requiredProfileRunner(profile, connectionId)
  try {
    const { parseBackendType } = await import('@tangle-network/sandbox')
    return parseBackendType(requested)
  } catch {
    throw new ConnectionError(
      'CONNECTION_UNSUPPORTED',
      'The selected runner is not supported by the published sandbox package',
      { connectionId },
    )
  }
}
