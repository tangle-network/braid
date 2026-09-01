import { ConnectionError } from '../../app/connection-errors.js'
import type { ConnectionId } from '../../domain/ids.js'
import type { ExecuteTurnInput } from '../../ports/execution.js'
import { readConnectionCredential } from '../connections/production-connection-credentials.js'
import { normalizeTangleInferenceRuntimeBaseUrl } from '../connections/production-connection-endpoints.js'
import { endpointLocation, staticExecutionObservation } from './execution-observation-source.js'
import type { PreparedExecution } from './prepared-execution.js'
import {
  connectionRecord,
  exactExecutionProfile,
  freezeExecution,
  type ProductionBackendResolverOptions,
  type ProductionExecutionSelection,
  requiredProfileModel,
} from './production-backend-common.js'

export async function resolveTangleInferenceBackend(
  options: ProductionBackendResolverOptions,
  input: ExecuteTurnInput,
  selection: ProductionExecutionSelection,
  connectionId: ConnectionId,
  endpoint: string,
): Promise<PreparedExecution> {
  const profile = await exactExecutionProfile(input.profile, selection, connectionId)
  const model = requiredProfileModel(profile, connectionId)
  if (profile.harness !== 'cli-base') {
    throw new ConnectionError(
      'CONNECTION_MODEL_HARNESS_MISMATCH',
      'Direct Tangle inference requires AgentProfile.harness=cli-base; choose CLI Bridge or sandbox for a coding runner.',
      { connectionId },
    )
  }
  const credential = await readConnectionCredential(
    connectionRecord(connectionId, options),
    options,
    endpoint,
  )
  const { createExecutor } = await import('@tangle-network/agent-runtime/kernel')
  const routerBaseUrl = normalizeTangleInferenceRuntimeBaseUrl(endpoint, connectionId)
  const routerLocation = endpointLocation(routerBaseUrl)
  const createdAt = new Date().toISOString()
  const backend = Object.freeze({
    kind: 'executor' as const,
    factory: createExecutor({
      backend: 'router',
      routerBaseUrl,
      routerKey: credential ?? '',
      ...(options.routerComplete === undefined ? {} : { complete: options.routerComplete }),
    }),
    profile,
    agentRunName: model,
  })
  return freezeExecution({
    kind: 'prepared-execution' as const,
    backend,
    cancellation: { kind: 'runtime-executor-cancel' },
    observation: staticExecutionObservation({
      kind: 'remote-service',
      provider: 'tangle-inference',
      lifecycle: 'ready',
      lifecycleMode: 'request',
      cleanup: 'not-applicable',
      continuity: 'not-applicable',
      ...routerLocation,
      createdAt,
      unavailable: [
        'router-account-balance-and-period-spend:not-exposed-by-provider',
        'effective-resources:not-exposed-by-provider',
        'machine-specs:not-exposed-by-provider',
      ],
    }),
    materializationReceipt: {
      provider: 'tangle-inference',
      backend: 'executor',
      connectionId,
      lifecycle: 'request',
      cleanup: 'not-applicable',
      model,
      runner: 'cli-base',
    },
  })
}
