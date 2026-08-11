import { snapHarnessToModel } from '../agent-interface/harness-runtime.js'
import { ConnectionError } from '../../app/connection-errors.js'
import type { ConnectionId } from '../../domain/ids.js'
import type { ExecuteTurnInput } from '../../ports/execution.js'
import {
  bridgeRunnerSupportsModel,
  materializeBridgeModelRoute,
} from '../connections/cli-bridge-model-route.js'
import { readConnectionCredential } from '../connections/production-connection-credentials.js'
import { normalizeCliBridgeProviderBaseUrl } from '../connections/production-connection-endpoints.js'
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
  safeExecutionId,
} from './production-backend-common.js'

const LOCAL_BRIDGE_BEARER = 'braid-local-cli-bridge'

export async function resolveCliBridgeBackend(
  options: ProductionBackendResolverOptions,
  input: ExecuteTurnInput,
  selection: ProductionExecutionSelection,
  connectionId: ConnectionId,
  endpoint: string,
): Promise<PreparedExecution> {
  const profile = await exactExecutionProfile(input.profile, selection, connectionId)
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
  const providerSessionId = input.sessionId ?? `session-braid-${safeExecutionId(input.runId)}`
  const route = materializeBridgeModelRoute(runner, model, profile.model?.provider)
  const workspace = requiredWorkspaceCwd(input.workspaceRoot, options.workspaceCwd)
  const bridgeUrl = normalizeCliBridgeProviderBaseUrl(endpoint, connectionId)
  const bridgeLocation = endpointLocation(bridgeUrl)
  const createdAt = new Date().toISOString()
  const [{ createExecutor }, { defaultCliBridgeCapabilities }] = await Promise.all([
    import('@tangle-network/agent-runtime/kernel'),
    import('@tangle-network/agent-provider-cli-bridge'),
  ])
  const backend = Object.freeze({
    kind: 'executor' as const,
    factory: createExecutor({
      backend: 'bridge',
      bridgeUrl,
      bridgeBearer: credential ?? LOCAL_BRIDGE_BEARER,
      cwd: workspace,
      sessionId: providerSessionId,
    }),
    profile,
    agentRunName: route,
  })
  return freezeExecution({
    kind: 'prepared-execution' as const,
    backend,
    capabilities: defaultCliBridgeCapabilities(runner),
    providerSessionId,
    cancellation: { kind: 'runtime-executor-teardown' },
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
