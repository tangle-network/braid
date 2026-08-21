import { canonicalDigest } from './canonical.js'
import type { BraidEvent } from './events.js'
import { graphEdge, graphNode } from './graph-records.js'
import { type ConnectionId, createConnectionId, createEnvironmentId } from './ids.js'
import { upsert } from './reducer-helpers.js'
import { withProviderProgress } from './reducer-support.js'
import type { BraidState } from './state.js'

type ObservationEvent = Extract<BraidEvent, { readonly kind: 'run.environment.observed' }>

export function applyExecutionObservation(
  state: BraidState,
  event: ObservationEvent,
  at: string,
): BraidState {
  const run = state.runs.find((candidate) => candidate.id === event.runId)
  if (run === undefined) return state
  const progressedRun = {
    ...withProviderProgress(run, event.provider),
    ...(event.controlRef === undefined ? {} : { controlRef: structuredClone(event.controlRef) }),
  }
  const workspaceId =
    state.conversations.find((candidate) => candidate.id === run.conversationId)?.workspaceId ??
    state.workspaceId
  const receiptConnectionId = state.connections.find(
    (candidate) => candidate.id === progressedRun.receipt.requested.connectionId,
  )?.id
  const materializedConnectionId = connectionIdFromMaterialization(
    progressedRun.receipt.materializationReceipt,
  )
  const connectionId =
    progressedRun.connectionId ??
    receiptConnectionId ??
    materializedConnectionId ??
    state.selectedConnectionId
  if (workspaceId == null || connectionId == null) {
    return {
      ...state,
      runs: upsert(state.runs, {
        ...progressedRun,
        activity: [
          ...progressedRun.activity,
          {
            id: `${run.id}:environment-unlinked`,
            runId: run.id,
            type: 'environment-observation-unlinked',
            label: 'Execution location could not be linked',
            detail: 'The run has no workspace or connection identity',
            source: {
              eventId: event.provider.eventId,
              sequence: event.provider.providerSequence,
              ...(event.provider.occurredAt === undefined
                ? {}
                : { occurredAt: event.provider.occurredAt }),
            },
          },
        ],
        updatedAt: at,
      }),
    }
  }

  const observation = event.observation
  const providerIdentity =
    observation.providerEnvironmentId ?? progressedRun.providerSessionId ?? String(progressedRun.id)
  const environmentId = createEnvironmentId(
    `environment-${canonicalDigest({
      provider: observation.provider,
      providerIdentity,
      connectionId,
    }).slice(0, 32)}`,
  )
  const existing = state.environments.find((candidate) => candidate.id === environmentId)
  const environment = {
    id: environmentId,
    workspaceId,
    connectionId,
    lifecycle: observation.lifecycle,
    placement: {
      provider: observation.provider,
      ...(observation.region === undefined ? {} : { region: observation.region }),
      ...(observation.account?.billingOwnerId === undefined
        ? {}
        : { account: observation.account.billingOwnerId }),
      confidentialRequested: false,
      confidentialVerified: false,
    },
    kind: observation.kind,
    ...(observation.providerEnvironmentId === undefined
      ? {}
      : { providerEnvironmentId: observation.providerEnvironmentId }),
    lifecycleMode: observation.lifecycleMode,
    cleanup: observation.cleanup,
    continuity: observation.continuity,
    location: observation.location,
    ...(observation.runtimeEndpointHost === undefined
      ? {}
      : { runtimeEndpointHost: observation.runtimeEndpointHost }),
    ...(observation.machineId === undefined ? {} : { machineId: observation.machineId }),
    ...(observation.requestedRegion === undefined
      ? {}
      : { requestedRegion: observation.requestedRegion }),
    ...(observation.storagePersistence === undefined
      ? {}
      : { storagePersistence: observation.storagePersistence }),
    ...(observation.requestedResources === undefined
      ? {}
      : { requestedResources: observation.requestedResources }),
    ...(observation.resourceSample === undefined
      ? {}
      : { resourceSample: observation.resourceSample }),
    ...(observation.gpu === undefined ? {} : { gpu: observation.gpu }),
    ...(observation.account === undefined ? {} : { accountUsage: observation.account }),
    unavailableTelemetry: observation.unavailable,
    secretNames: existing?.secretNames ?? [],
    createdAt: existing?.createdAt ?? observation.createdAt,
    ...(observation.startedAt === undefined ? {} : { startedAt: observation.startedAt }),
    ...(observation.lastActivityAt === undefined
      ? {}
      : { lastActivityAt: observation.lastActivityAt }),
    ...(observation.expiresAt === undefined ? {} : { expiresAt: observation.expiresAt }),
    updatedAt: observation.observedAt,
  } as const
  const environmentReference = { kind: 'environment' as const, id: environmentId }
  const runReference = { kind: 'run' as const, id: progressedRun.id }
  const existingNode = state.graphNodes.find(
    (node) => node.reference.kind === 'environment' && node.reference.id === environmentId,
  )
  const environmentNode = {
    ...graphNode(
      environmentReference,
      existingNode?.createdAt ?? environment.createdAt,
      `${observation.provider} execution`,
    ),
    status: observation.lifecycle,
    updatedAt: observation.observedAt,
  }
  const runNode =
    state.graphNodes.find(
      (node) => node.reference.kind === 'run' && node.reference.id === progressedRun.id,
    ) ?? graphNode(runReference, progressedRun.startedAt, 'Run')
  const edge = graphEdge({
    kind: 'attached',
    source: runReference,
    destination: environmentReference,
    at: environment.createdAt,
  })

  return {
    ...state,
    runs: upsert(state.runs, { ...progressedRun, environmentId, updatedAt: at }),
    environments: upsert(state.environments, environment),
    graphNodes: upsert(upsert(state.graphNodes, runNode), environmentNode),
    graphEdges: upsert(state.graphEdges, edge),
  }
}

function connectionIdFromMaterialization(
  receipt: Readonly<Record<string, unknown>> | undefined,
): ConnectionId | undefined {
  const value = receipt?.connectionId
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  try {
    return createConnectionId(value)
  } catch {
    return undefined
  }
}
