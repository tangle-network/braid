import type { AgentProfile } from '@tangle-network/agent-interface'
import type { AgentEnvironmentCapabilities } from '@tangle-network/agent-interface/environment-provider'
import type { SandboxClientLike } from '@tangle-network/agent-provider-tangle'
import type { SandboxClient } from '@tangle-network/agent-runtime/kernel'
import type { BackendType, CreateSandboxOptions, SandboxInstance } from '@tangle-network/sandbox'
import { ConnectionError } from '../../app/connection-errors.js'
import { canonicalDigest } from '../../domain/canonical.js'
import type { ConnectionId } from '../../domain/ids.js'
import type { ExecuteTurnInput } from '../../ports/execution.js'
import { harnessSupportsModel, snapHarnessToModel } from '../agent-interface/harness-runtime.js'
import type { PreparedExecution, SandboxLifecyclePolicy } from './prepared-execution.js'
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

export async function resolveTangleSandboxBackend(
  options: ProductionBackendResolverOptions,
  input: ExecuteTurnInput,
  selection: ProductionExecutionSelection,
  connectionId: ConnectionId,
): Promise<PreparedExecution> {
  if (input.sessionId !== undefined) {
    throw new ConnectionError(
      'CONNECTION_UNSUPPORTED',
      'Tangle sandbox session continuity is unavailable until retained environment recovery is supported',
      { connectionId },
    )
  }
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

  const [{ createTangleSandboxClient }, { createTangleProvider }, { createExecutor }] =
    await Promise.all([
      import('../connections/production-connection-providers.js'),
      import('@tangle-network/agent-provider-tangle'),
      import('@tangle-network/agent-runtime/kernel'),
    ])
  const record = connectionRecord(connectionId, options)
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
