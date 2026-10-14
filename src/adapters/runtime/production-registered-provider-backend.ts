import {
  AgentEnvironmentCapabilitiesSchema,
  canonicalAgentProfileDigest,
  contextTransferResultMatchesRequest,
  workspaceCwdPathForBase,
} from '@tangle-network/agent-interface'
import type { AgentEnvironmentProvider } from '@tangle-network/agent-interface/environment-provider'
import {
  assertProfileMaterializes,
  createExecutor,
  type ExecutorFactory,
} from '@tangle-network/agent-runtime/kernel'
import { validateProfile } from '../../app/profile-validation.js'
import { ConnectionError } from '../../app/connection-errors.js'
import { snapshotWorkspaceRequest, workspaceRequestDigest } from '../../app/workspace-request.js'
import type { ConnectionId } from '../../domain/ids.js'
import type { ExecuteTurnInput } from '../../ports/execution.js'
import { createRegisteredEnvironmentProvider } from '../connections/registered-provider.js'
import { endpointLocation, staticExecutionObservation } from './execution-observation-source.js'
import type { PreparedRetainedProviderConnection } from './provider-retained-run.js'
import type { PreparedExecution } from './prepared-execution.js'
import {
  connectionRecord,
  exactExecutionProfile,
  freezeExecution,
  type ProductionBackendResolverOptions,
  type ProductionExecutionSelection,
  requiredProfileModel,
  requiredProfileRunner,
  stableProviderId,
} from './production-backend-common.js'

/** Prepare the complete canonical profile without allocating an environment. */
export async function resolveRegisteredProviderBackend(
  options: ProductionBackendResolverOptions,
  input: ExecuteTurnInput,
  selection: ProductionExecutionSelection,
  connectionId: ConnectionId,
): Promise<PreparedExecution> {
  const record = connectionRecord(connectionId, options)
  if (
    input.contextTransfer !== undefined ||
    input.sessionId !== undefined ||
    record.providerOptions.lifecycle === 'retained'
  ) {
    throw new ConnectionError(
      'CONNECTION_UNSUPPORTED',
      'This provider requires exact retained admission for context transfer or session continuity',
      { connectionId },
    )
  }
  const { profile, provider, reported, workspace, resources, model } =
    await prepareRegisteredProvider(options, input, selection, connectionId)
  const capabilities = {
    ...reported,
    streaming: { ...reported.streaming, replay: false, detach: false },
    sessions: { continue: false, list: false, messages: false },
  }
  const backend = {
    kind: 'executor' as const,
    factory: ((spec, context) =>
      createExecutor({
        backend: 'provider',
        provider,
        defaults: {
          profile,
          backend: requiredProfileRunner(profile, connectionId),
          name: record.name,
          idempotencyKey: stableProviderId('env-braid-', input.runId),
          ...(workspace === undefined ? {} : { workspace }),
          ...(resources === undefined ? {} : { resources }),
          signal: context.signal,
        },
        destroyOnSettle: true,
        requireTerminalEvent: true,
      })(spec, context)) satisfies ExecutorFactory<unknown>,
    profile,
    ...(model === undefined ? {} : { agentRunName: model }),
  }
  return freezeExecution({
    kind: 'prepared-execution' as const,
    backend,
    capabilities,
    cancellation: { kind: 'runtime-executor-cancel' as const },
    materializationReceipt: {
      provider: provider.name,
      backend: 'executor',
      connectionId,
      lifecycle: 'ephemeral',
      cleanup: 'delete-after-turn',
      continuity: 'unavailable',
      portableContext: 'unavailable',
      model,
      runner: profile.harness,
      ...(workspace === undefined
        ? {}
        : { workspaceRequestDigest: workspaceRequestDigest(workspace) }),
    },
  })
}

/** Prepare retry-safe retained ownership through the existing shared Runtime lifecycle. */
export async function resolveRegisteredProviderRetainedConnection(
  options: ProductionBackendResolverOptions,
  input: ExecuteTurnInput,
  selection: ProductionExecutionSelection,
  connectionId: ConnectionId,
): Promise<PreparedRetainedProviderConnection> {
  const record = connectionRecord(connectionId, options)
  const { profile, provider, reported, workspace, resources, model } =
    await prepareRegisteredProvider(options, input, selection, connectionId)
  const retained = reported.retainedControl
  if (
    provider.get === undefined ||
    retained?.exactRunIdentity !== true ||
    retained.resultIdentity !== true ||
    retained.eventIdentity !== true ||
    retained.cancellationIdempotency !== true ||
    !reported.streaming.replay ||
    !reported.streaming.detach ||
    !reported.streaming.turnIdempotency
  ) {
    throw new ConnectionError(
      'CONNECTION_UNSUPPORTED',
      'The selected provider cannot reconstruct and control an exact retained run',
      { connectionId },
    )
  }
  const receipt = input.contextTransferReceipt
  if (
    input.contextTransfer !== undefined &&
    (receipt === undefined ||
      !contextTransferResultMatchesRequest(input.contextTransfer, receipt) ||
      reported.contextTransfer?.attach !== true)
  ) {
    throw new ConnectionError(
      'CONNECTION_UNSUPPORTED',
      'The selected provider cannot attach the accepted context transfer receipt',
      { connectionId },
    )
  }
  if (receipt !== undefined && input.contextTransfer === undefined)
    throw new Error('A context transfer receipt requires its accepted request')
  if (
    receipt !== undefined &&
    input.sessionId !== undefined &&
    input.sessionId !== receipt.sessionId
  )
    throw new Error('The selected session conflicts with the accepted context transfer receipt')
  const location =
    record.endpoint === undefined
      ? { location: 'unknown' as const }
      : endpointLocation(record.endpoint)
  return {
    profile,
    model,
    runner: requiredProfileRunner(profile, connectionId),
    provider,
    capabilities: reported,
    // A registered provider reports no environment telemetry, so the retained stream
    // observes only the connection facts Braid holds and names the rest unavailable.
    observation: staticExecutionObservation({
      kind: location.location === 'local' ? 'local-process' : 'remote-service',
      provider: provider.name,
      lifecycle: 'ready',
      lifecycleMode: 'retained',
      cleanup: 'explicit',
      continuity: 'session',
      ...location,
      createdAt: new Date().toISOString(),
      unavailable: [
        'effective-resources:not-exposed-by-provider',
        'machine-specs:not-exposed-by-provider',
        'runtime-cpu-memory-usage:not-exposed-by-provider',
      ],
    }),
    providerSessionId:
      receipt?.sessionId ?? input.sessionId ?? stableProviderId('session-braid-', input.runId),
    ...(receipt === undefined
      ? {}
      : {
          executionId: receipt.executionId,
          environmentId: receipt.environmentId,
          providerRunId: receipt.runId,
        }),
    ...(workspace === undefined ? {} : { workspaceRequest: workspace }),
    ...(resources === undefined ? {} : { resourceRequest: resources }),
    environmentIdempotencyKey: stableProviderId('env-braid-', input.runId),
    environmentName: record.name,
    environmentMetadata: { braidRunId: input.runId },
    materializationReceipt: {
      provider: provider.name,
      connectionId,
      backend: 'environment-provider',
      lifecycle: 'retained',
      cleanup: 'explicit',
      continuity: 'session',
      portableContext: receipt === undefined ? 'unavailable' : 'accepted',
      model,
      runner: profile.harness,
      ...(workspace === undefined
        ? {}
        : { workspaceRequestDigest: workspaceRequestDigest(workspace) }),
    },
  }
}

async function prepareRegisteredProvider(
  options: ProductionBackendResolverOptions,
  input: ExecuteTurnInput,
  selection: ProductionExecutionSelection,
  connectionId: ConnectionId,
) {
  const record = connectionRecord(connectionId, options)
  if (input.mode === 'interactive')
    throw new ConnectionError(
      'CONNECTION_UNSUPPORTED',
      'This provider connection does not expose Braid native terminal attachment',
      { connectionId },
    )
  const profile = await exactExecutionProfile(input.profile, selection, connectionId)
  const provider: AgentEnvironmentProvider = await (options.resolveConnectionProvider?.(
    record,
    input.signal,
  ) ?? createRegisteredEnvironmentProvider(record, options, input.signal))
  const reported = await provider.capabilities()
  AgentEnvironmentCapabilitiesSchema.parse(reported)
  if (!reported.streaming.live) {
    throw new ConnectionError(
      'CONNECTION_UNSUPPORTED',
      'The selected provider does not expose agent turn streaming',
      { connectionId },
    )
  }
  if (input.contextTransfer === undefined && reported.create?.durableIdempotency !== true) {
    throw new ConnectionError(
      'CONNECTION_UNSUPPORTED',
      'The selected provider cannot create an agent environment with durable retry identity',
      { connectionId },
    )
  }
  const validation = await validateProfile(profile, {
    ...(provider.validateProfile === undefined ? {} : { provider }),
    signal: input.signal,
  })
  if (!validation.ok || validation.issues.some((issue) => issue.level === 'error')) {
    throw new ConnectionError(
      'CONNECTION_UNSUPPORTED',
      'The selected provider cannot materialize this AgentProfile; review its profile validation',
      { connectionId },
    )
  }
  if (
    validation.profile !== undefined &&
    canonicalAgentProfileDigest(validation.profile) !== canonicalAgentProfileDigest(profile)
  ) {
    throw new ConnectionError(
      'CONNECTION_UNSUPPORTED',
      'The selected provider would change the accepted AgentProfile',
      { connectionId },
    )
  }
  if (provider.validateProfile === undefined)
    assertProfileMaterializes(
      profile,
      // Interface names runners that Runtime's materializer cannot plan
      // (for example `acp`); the materializer refuses those at this call.
      requiredProfileRunner(profile, connectionId) as Parameters<
        typeof assertProfileMaterializes
      >[1],
      'Selected provider AgentProfile',
    )
  const workspace = snapshotWorkspaceRequest(input.workspaceRequest)
  if (
    workspace?.cwd !== undefined &&
    (workspaceCwdPathForBase(workspace.cwd, 'repository', 'Selected provider') === undefined ||
      reported.workspace.cwdBases?.repository !== true)
  ) {
    throw new ConnectionError(
      'CONNECTION_UNSUPPORTED',
      'The selected provider cannot honor this repository workspace start path',
      { connectionId },
    )
  }
  if (
    (workspace?.repoUrl !== undefined || workspace?.gitRef !== undefined) &&
    !reported.workspace.git
  ) {
    throw new ConnectionError(
      'CONNECTION_UNSUPPORTED',
      'The selected provider cannot restore a Git workspace',
      { connectionId },
    )
  }
  if (workspace?.snapshot !== undefined && reported.create?.workspaceSnapshot !== true) {
    throw new ConnectionError(
      'CONNECTION_UNSUPPORTED',
      'The selected provider cannot restore the accepted workspace snapshot',
      { connectionId },
    )
  }
  const resources = record.providerOptions.resources
  const model = requiredProfileModel(profile, connectionId)
  return { profile, provider, reported, workspace, resources, model }
}
