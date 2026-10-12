import { AgentEnvironmentCapabilitiesSchema, canonicalAgentProfileDigest, contextTransferResultMatchesRequest, workspaceCwdPathForBase } from '@tangle-network/agent-interface'
import type { AgentEnvironmentProvider } from '@tangle-network/agent-interface/environment-provider'
import { createExecutor, type ExecutorFactory } from '@tangle-network/agent-runtime/kernel'
import { validateProfile } from '../../app/profile-validation.js'
import { ConnectionError } from '../../app/connection-errors.js'
import { snapshotWorkspaceRequest, workspaceRequestDigest } from '../../app/workspace-request.js'
import type { ConnectionId } from '../../domain/ids.js'
import type { ExecuteTurnInput } from '../../ports/execution.js'
import { createRegisteredEnvironmentProvider } from '../connections/registered-provider.js'
import type { PreparedRetainedProviderConnection } from './provider-retained-run.js'
import type { PreparedExecution } from './prepared-execution.js'
import { connectionRecord, exactExecutionProfile, freezeExecution, type ProductionBackendResolverOptions, type ProductionExecutionSelection, stableProviderId } from './production-backend-common.js'

/** Prepare the complete canonical profile without allocating an environment. */
export async function resolveRegisteredProviderBackend(
  options: ProductionBackendResolverOptions,
  input: ExecuteTurnInput,
  selection: ProductionExecutionSelection,
  connectionId: ConnectionId,
): Promise<PreparedExecution> {
  const record = connectionRecord(connectionId, options)
  if (input.contextTransfer !== undefined || input.sessionId !== undefined || record.providerOptions.lifecycle === 'retained') {
    throw new ConnectionError('CONNECTION_UNSUPPORTED', 'This provider requires exact retained admission for context transfer or session continuity', { connectionId })
  }
  const { profile, provider, reported, workspace, resources, model } = await prepareRegisteredProvider(options, input, selection, connectionId)
  const capabilities = { ...reported, streaming: { ...reported.streaming, replay: false, detach: false }, sessions: { continue: false, list: false, messages: false } }
  const backend = {
    kind: 'executor' as const,
    factory: ((spec, context) => createExecutor({
      backend: 'provider', provider,
      defaults: { profile, backend: profile.harness, name: record.name, idempotencyKey: stableProviderId('env-braid-', input.runId), ...(workspace === undefined ? {} : { workspace }), ...(resources === undefined ? {} : { resources }), signal: context.signal },
      destroyOnSettle: true, requireTerminalEvent: true,
    })(spec, context)) satisfies ExecutorFactory<unknown>,
    profile,
    ...(model === undefined ? {} : { agentRunName: model }),
  }
  return freezeExecution({ kind: 'prepared-execution' as const, backend, capabilities,
    cancellation: { kind: 'runtime-executor-cancel' as const },
    materializationReceipt: { provider: provider.name, backend: 'executor', connectionId, lifecycle: 'ephemeral', cleanup: 'delete-after-turn', continuity: 'unavailable', portableContext: 'unavailable', model, runner: profile.harness, ...(workspace === undefined ? {} : { workspaceRequestDigest: workspaceRequestDigest(workspace) }) },
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
  const { profile, provider, reported, workspace, resources, model } = await prepareRegisteredProvider(options, input, selection, connectionId)
  const retained = reported.retainedControl
  if (provider.get === undefined || retained?.exactRunIdentity !== true || retained.resultIdentity !== true || retained.eventIdentity !== true || retained.cancellationIdempotency !== true || !reported.streaming.replay || !reported.streaming.detach || !reported.streaming.turnIdempotency) {
    throw new ConnectionError('CONNECTION_UNSUPPORTED', 'The selected provider cannot reconstruct and control an exact retained run', { connectionId })
  }
  const receipt = input.contextTransferReceipt
  if (input.contextTransfer !== undefined && (receipt === undefined || !contextTransferResultMatchesRequest(input.contextTransfer, receipt) || reported.contextTransfer?.attach !== true)) {
    throw new ConnectionError('CONNECTION_UNSUPPORTED', 'The selected provider cannot attach the accepted context transfer receipt', { connectionId })
  }
  if (receipt !== undefined && input.contextTransfer === undefined) throw new Error('A context transfer receipt requires its accepted request')
  return {
    profile, model, runner: profile.harness!, provider, capabilities: reported,
    providerSessionId: receipt?.sessionId ?? input.sessionId ?? stableProviderId('session-braid-', input.runId),
    ...(receipt === undefined ? {} : { executionId: receipt.executionId }),
    ...(workspace === undefined ? {} : { workspaceRequest: workspace }),
    ...(resources === undefined ? {} : { resourceRequest: resources }),
    environmentIdempotencyKey: stableProviderId('env-braid-', input.runId),
    environmentName: record.name,
    environmentMetadata: { braidRunId: input.runId },
    materializationReceipt: { provider: provider.name, connectionId, backend: 'environment-provider', lifecycle: 'retained', cleanup: 'explicit', continuity: 'session', portableContext: receipt === undefined ? 'unavailable' : 'accepted', model, runner: profile.harness, ...(workspace === undefined ? {} : { workspaceRequestDigest: workspaceRequestDigest(workspace) }) },
  }
}

async function prepareRegisteredProvider(options: ProductionBackendResolverOptions, input: ExecuteTurnInput, selection: ProductionExecutionSelection, connectionId: ConnectionId) {
  const record = connectionRecord(connectionId, options)
  const profile = await exactExecutionProfile(input.profile, selection, connectionId)
  const provider: AgentEnvironmentProvider = await (options.resolveConnectionProvider?.(record, input.signal) ?? createRegisteredEnvironmentProvider(record, options, input.signal))
  const reported = AgentEnvironmentCapabilitiesSchema.parse(await provider.capabilities())
  if (!reported.streaming.live || reported.create?.durableIdempotency !== true) {
    throw new ConnectionError('CONNECTION_UNSUPPORTED', 'The selected provider cannot validate and execute the complete AgentProfile', { connectionId })
  }
  const validation = await validateProfile(profile, { provider, signal: input.signal })
  if (!validation.ok || validation.issues.some((issue) => issue.level === 'error')) {
    throw new ConnectionError('CONNECTION_UNSUPPORTED', 'The selected provider cannot materialize this AgentProfile; review its profile validation', { connectionId })
  }
  if (validation.profile !== undefined && canonicalAgentProfileDigest(validation.profile) !== canonicalAgentProfileDigest(profile)) {
    throw new ConnectionError('CONNECTION_UNSUPPORTED', 'The selected provider would change the accepted AgentProfile', { connectionId })
  }
  const workspace = snapshotWorkspaceRequest(input.workspaceRequest)
  if (workspace?.cwd !== undefined && (workspaceCwdPathForBase(workspace.cwd, 'repository') === undefined || reported.workspace.cwdBases?.repository !== true)) {
    throw new ConnectionError('CONNECTION_UNSUPPORTED', 'The selected provider cannot honor this repository workspace start path', { connectionId })
  }
  if ((workspace?.repoUrl !== undefined || workspace?.gitRef !== undefined) && !reported.workspace.git) {
    throw new ConnectionError('CONNECTION_UNSUPPORTED', 'The selected provider cannot restore a Git workspace', { connectionId })
  }
  if (workspace?.snapshot !== undefined && reported.create?.workspaceSnapshot !== true) {
    throw new ConnectionError('CONNECTION_UNSUPPORTED', 'The selected provider cannot restore the accepted workspace snapshot', { connectionId })
  }
  const resources = record.providerOptions.resources
  const model = profile.model!.default!
  return { profile, provider, reported, workspace, resources, model }
}
