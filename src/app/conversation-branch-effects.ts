import {
  type ContextTransferRequest,
  type ContextTransferResult,
  contextTransferRequestDigest,
  contextTransferResultMatchesRequest,
  forkedEnvironmentConfidentialityVerified,
  type PlacementInfo,
  type PortableContextPlanRequest,
  type PortableContextPlanResult,
  portableContextPlanRequestDigest,
  portableContextPlanResultMatchesRequest,
  type WorkspaceCheckpointRequest,
  type WorkspaceCheckpointResult,
  type WorkspaceCleanupAcknowledgement,
  type WorkspaceCleanupRequest,
  type WorkspaceForkRequest,
  type WorkspaceForkResult,
  workspaceCheckpointRequestDigest,
  workspaceCheckpointResultMatchesRequest,
  workspaceCleanupAcknowledgementMatches,
  workspaceCleanupRequestDigest,
  workspaceForkRequestDigest,
  workspaceForkResultMatchesRequest,
} from '@tangle-network/agent-interface'
import { canonicalDigest } from '../domain/canonical.js'
import type {
  BranchRecord,
  CheckpointRecord,
  EnvironmentRecord,
  OperationRecord,
} from '../domain/entities.js'
import { graphEdge, graphNode } from '../domain/graph-records.js'
import {
  createCheckpointId,
  createEnvironmentId,
  type Digest,
  parseBranchId,
  parseCheckpointId,
  parseEnvironmentId,
  parseMessageId,
  parseOperationId,
  parseRunId,
} from '../domain/ids.js'
import { assertJsonValue, objectValue } from '../domain/invariants-base.js'
import { type BraidState, isActiveRunStatus } from '../domain/state.js'
import type { ExecutionPort } from '../ports/execution.js'
import type {
  ConversationHost,
  ForkPlan,
  ForkPlanInput,
  WorkspaceForkCleanupInput,
  WorkspaceForkCleanupResult,
} from './conversation-types.js'
import { AppError } from './errors.js'

type ForkExecutionInput = ForkPlanInput & { readonly planDigest: string }
type CreateBranch = (input: ForkPlanInput) => Promise<BranchRecord>

/** Execute provider-owned context transfer or workspace branching. */
export async function executeBranchEffect(
  host: ConversationHost,
  input: ForkExecutionInput,
  plan: ForkPlan,
  createBranch: CreateBranch,
): Promise<BranchRecord> {
  if (plan.kind === 'cross-runner') return executeCrossRunner(host, input, plan, createBranch)
  if (plan.kind === 'workspace') return executeWorkspace(host, input, plan, createBranch)
  throw new AppError('FORK_PLAN_CONFLICT', 'The provider effect does not match this fork plan')
}

/** Explicitly release provider checkpoint and fork resources. */
export async function cleanupWorkspaceFork(
  host: ConversationHost,
  input: WorkspaceForkCleanupInput,
): Promise<WorkspaceForkCleanupResult> {
  const execution = host.execution
  const state = host.state()
  const operationId = parseOperationId(input.operationId)
  const checkpoint =
    input.checkpointId === undefined
      ? undefined
      : state.checkpoints.find(
          (candidate) => candidate.id === parseCheckpointId(input.checkpointId),
        )
  const environment =
    input.environmentId === undefined
      ? undefined
      : state.environments.find(
          (candidate) => candidate.id === parseEnvironmentId(input.environmentId),
        )
  if (input.checkpointId !== undefined && checkpoint === undefined)
    throw new AppError('UNKNOWN_CHECKPOINT', `Checkpoint ${input.checkpointId} is unavailable`)
  if (input.environmentId !== undefined && environment === undefined)
    throw new AppError('UNKNOWN_ENVIRONMENT', `Environment ${input.environmentId} is unavailable`)
  if (checkpoint === undefined && environment === undefined)
    throw new AppError('INVALID_CLEANUP', 'Specify a checkpoint or destination environment')
  if (environment !== undefined && checkpoint !== undefined) {
    if (environment.id === checkpoint.sourceEnvironmentId)
      throw new AppError('INVALID_CLEANUP', 'The source environment cannot be cleaned up')
    const forked = state.graphEdges.some((edge) => {
      const source = graphReference(state, edge.source)
      const destination = graphReference(state, edge.destination)
      return (
        edge.kind === 'forked_environment' &&
        destination?.kind === 'environment' &&
        destination.id === environment.id &&
        source?.kind === 'checkpoint' &&
        source.id === checkpoint.id
      )
    })
    if (!forked)
      throw new AppError(
        'INVALID_CLEANUP',
        'The destination environment is not the fork created from this checkpoint',
      )
  }
  if (environment !== undefined && checkpoint === undefined) {
    const forked = state.graphEdges.some((edge) => {
      const destination = graphReference(state, edge.destination)
      return (
        edge.kind === 'forked_environment' &&
        destination?.kind === 'environment' &&
        destination.id === environment.id
      )
    })
    if (!forked)
      throw new AppError('INVALID_CLEANUP', 'Only a recorded forked environment can be cleaned up')
  }
  const providerCheckpointId =
    checkpoint === undefined ? undefined : providerCheckpointIdFor(state, checkpoint)
  if (checkpoint !== undefined && providerCheckpointId === undefined)
    throw new AppError('UNKNOWN_CHECKPOINT', 'The checkpoint has no provider reference')
  if (environment !== undefined && environment.providerEnvironmentId === undefined)
    throw new AppError('UNKNOWN_ENVIRONMENT', 'The environment has no provider reference')
  assertCleanupCapabilities(state, checkpoint, environment)
  const sourceEnvironment = sourceEnvironmentForCleanup(state, checkpoint, environment)
  const digest = canonicalDigest({
    command: 'cleanup_workspace_fork',
    operationId,
    checkpointId: checkpoint?.id ?? null,
    providerCheckpointId: providerCheckpointId ?? null,
    environmentId: environment?.id ?? null,
    providerEnvironmentId: environment?.providerEnvironmentId ?? null,
  })
  const reserved = await reserveOperation(host, operationId, digest)
  const existing = reserved.operations.find((candidate) => candidate.id === operationId)
  if (existing?.status === 'acknowledged') {
    const result = cleanupResultFromOperation(existing)
    if (result === undefined)
      throw new AppError('OPERATION_INCOMPLETE', `Operation ${operationId} has no cleanup result`)
    return result
  }
  const previous = cleanupResultFromOperation(existing)
  const branching = await workspaceBranchingForEnvironment(
    execution,
    sourceEnvironment?.providerEnvironmentId,
  )
  if (!hasWorkspaceBranching(branching))
    throw new AppError('CAPABILITY_UNAVAILABLE', 'Workspace cleanup is unavailable')

  const checkpointOutcome =
    checkpoint === undefined
      ? 'not_requested'
      : previous?.checkpoint === 'deleted' || previous?.checkpoint === 'already_absent'
        ? previous.checkpoint
        : await cleanupCheckpoint(
            host,
            branching,
            derivedOperationId(String(operationId), 'checkpoint-cleanup'),
            checkpoint,
          )
  await updateOperation(host, operationId, digest, {
    status: 'pending',
    result: { checkpoint: checkpointOutcome, environment: 'not_requested' },
  })
  const environmentOutcome =
    environment === undefined
      ? 'not_requested'
      : previous?.environment === 'deleted' || previous?.environment === 'already_absent'
        ? previous.environment
        : await cleanupEnvironment(
            host,
            branching,
            derivedOperationId(String(operationId), 'fork-cleanup'),
            environment,
          )
  const result: WorkspaceForkCleanupResult = {
    checkpoint: checkpointOutcome,
    environment: environmentOutcome,
  }
  await acknowledgeCleanupOperation(host, operationId, digest, result)
  return result
}

async function executeCrossRunner(
  host: ConversationHost,
  input: ForkExecutionInput,
  plan: ForkPlan,
  createBranch: CreateBranch,
): Promise<BranchRecord> {
  const portablePlan = plan.portableContextPlan
  const contextPort = contextTransferPort(host.execution)
  if (portablePlan === undefined || contextPort?.transfer === undefined)
    throw new AppError(
      'CAPABILITY_UNAVAILABLE',
      'Canonical fresh-session context transfer is unavailable',
    )
  const state = host.state()
  const sourceEnvironment =
    plan.sourceEnvironmentId === undefined
      ? undefined
      : state.environments.find((environment) => environment.id === plan.sourceEnvironmentId)
  if (sourceEnvironment === undefined || sourceEnvironment.providerEnvironmentId === undefined)
    throw new AppError(
      'CAPABILITY_UNAVAILABLE',
      'Canonical context transfer requires a recorded source environment',
    )
  if (sourceEnvironment.placement.provider !== portablePlan.source.source.provider)
    throw new AppError(
      'FORK_PLAN_CONFLICT',
      'The portable plan names a different source provider than the recorded environment',
    )
  if (sourceEnvironment.providerEnvironmentId !== portablePlan.source.source.environmentId)
    throw new AppError(
      'FORK_PLAN_CONFLICT',
      'The portable plan names a different source environment',
    )
  if (portablePlan.requiresAcceptance && input.acceptedDigest !== portablePlan.digest)
    throw new AppError(
      'CONTEXT_PLAN_ACCEPTANCE_REQUIRED',
      'The transformed portable context plan requires explicit acceptance',
    )

  const operationId = parseOperationId(input.operationId)
  const digest = canonicalDigest({
    command: 'execute_cross_runner_fork',
    operationId,
    planDigest: plan.digest,
    acceptedDigest: input.acceptedDigest ?? null,
  })
  const reserved = await reserveOperation(host, operationId, digest)
  const existing = reserved.operations.find((operation) => operation.id === operationId)
  if (existing?.status === 'acknowledged') return branchForOperation(state, existing)
  const acceptedAt = existing?.createdAt ?? host.now()

  const planRequestMaterial = {
    requestId: `${input.operationId}:plan`,
    source: portablePlan.source,
    destination: portablePlan.destination,
  }
  const planRequest: PortableContextPlanRequest = {
    ...planRequestMaterial,
    requestDigest: portableContextPlanRequestDigest(planRequestMaterial),
  }
  if (contextPort.plan !== undefined) {
    const planned = await contextPort.plan(planRequest)
    if (!portableContextPlanResultMatchesRequest(planRequest, planned))
      throw new AppError(
        'CONTEXT_PLAN_CONFLICT',
        'The provider context plan does not match its request',
      )
    assertReadyPlan(planned)
    if (planned.plan.digest !== portablePlan.digest)
      throw new AppError('CONTEXT_PLAN_CONFLICT', 'The provider changed the accepted context plan')
  }

  const transferMaterial = {
    operationId: `${input.operationId}:context`,
    plan: portablePlan,
    acceptance: {
      planDigest: portablePlan.digest,
      acceptedAt,
      acceptedBy: input.acceptedDigest === undefined ? ('policy' as const) : ('user' as const),
    },
  }
  const transferRequest: ContextTransferRequest = {
    ...transferMaterial,
    requestDigest: contextTransferRequestDigest(transferMaterial),
  }
  const transfer = await lookupOrTransfer(contextPort, transferRequest)
  if (!contextTransferResultMatchesRequest(transferRequest, transfer))
    throw new AppError(
      'CONTEXT_RECEIPT_CONFLICT',
      'The context transfer result does not match its request',
    )
  const receipt = assertAcceptedTransfer(transfer)
  const destinationEnvironment = await recordDestinationEnvironment(host, plan, receipt)
  const branch = await createBranch({
    ...input,
    operationId: derivedOperationId(input.operationId, 'branch'),
    destinationBranchId: plan.destinationBranchId,
    ...(destinationEnvironment === undefined ? {} : { environmentId: destinationEnvironment.id }),
  })
  await recordHandedOffEdge(host, plan, branch, receipt.contextDigest, operationId)

  if (input.text !== undefined && input.text.trim() !== '' && host.send !== undefined) {
    const sent = host.send({
      operationId: derivedOperationId(input.operationId, 'send'),
      conversationId: branch.conversationId,
      branchId: branch.id,
      text: input.text,
      sessionId: receipt.sessionId,
      portableContextPlan: portablePlan,
      portableContextTransferRequest: transferRequest,
      portableContextTransferReceipt: receipt,
    })
    await sent.admissionReady
  }
  await acknowledgeOperation(host, operationId, digest, branch, {
    kind: 'handoff',
    branchId: String(branch.id),
    planDigest: plan.digest,
    receipt,
  })
  return branch
}

async function executeWorkspace(
  host: ConversationHost,
  input: ForkExecutionInput,
  plan: ForkPlan,
  createBranch: CreateBranch,
): Promise<BranchRecord> {
  const state = host.state()
  const operationId = parseOperationId(input.operationId)
  const sourceRun = sourceRunForPlan(state, plan)
  const source = sourceRun?.controlRef
  if (sourceRun === undefined || source === undefined)
    throw new AppError(
      'CAPABILITY_UNAVAILABLE',
      'Workspace fork requires an exact source run reference',
    )
  const sourceEnvironment = plan.sourceEnvironmentId
  if (sourceEnvironment === undefined || sourceRun.environmentId === undefined)
    throw new AppError(
      'CAPABILITY_UNAVAILABLE',
      'Workspace fork requires a recorded source environment',
    )
  if (sourceRun.environmentId !== parseEnvironmentId(sourceEnvironment))
    throw new AppError('FORK_PLAN_CONFLICT', 'The source run and branch environment do not match')
  const sourceEnvironmentRecord = state.environments.find(
    (environment) => environment.id === parseEnvironmentId(sourceEnvironment),
  )
  if (
    sourceEnvironmentRecord === undefined ||
    sourceEnvironmentRecord.providerEnvironmentId !== source.environmentId
  )
    throw new AppError(
      'CAPABILITY_UNAVAILABLE',
      'Workspace fork requires an exact recorded source environment',
    )
  if (sourceEnvironmentRecord.placement.provider !== source.provider)
    throw new AppError(
      'FORK_PLAN_CONFLICT',
      'The source run and environment belong to different providers',
    )
  if (!sourceRun.complete || isActiveRunStatus(sourceRun.status) || sourceRun.status === 'unknown')
    throw new AppError(
      'CAPABILITY_UNAVAILABLE',
      'Workspace fork requires a completed source run boundary',
    )
  const capabilities = sourceRun.capabilities.environment?.branching
  if (
    capabilities?.checkpoint !== true ||
    capabilities.fork !== true ||
    capabilities.retrySafe !== true ||
    capabilities.lookup !== true ||
    capabilities.cleanup !== true
  )
    throw new AppError(
      'CAPABILITY_UNAVAILABLE',
      'The selected run does not report retry-safe checkpoint and environment fork support',
    )

  const digest = canonicalDigest({
    command: 'execute_workspace_fork',
    operationId,
    planDigest: plan.digest,
    sourceRunId: sourceRun.id,
    sourceEnvironment,
  })
  const reserved = await reserveOperation(host, operationId, digest)
  const existing = reserved.operations.find((operation) => operation.id === operationId)
  if (existing?.status === 'acknowledged') return branchForOperation(reserved, existing)
  const branching = await workspaceBranchingForEnvironment(
    host.execution,
    sourceEnvironmentRecord.providerEnvironmentId,
  )
  if (!hasWorkspaceBranching(branching))
    throw new AppError('CAPABILITY_UNAVAILABLE', plan.reason ?? 'Workspace fork is unavailable')

  const checkpointMaterial = {
    source,
    name: `braid checkpoint ${plan.sourceBranchId}`,
    metadata: {
      braidOperationId: input.operationId,
      sourceBranchId: String(plan.sourceBranchId),
      ...(plan.throughMessageId === undefined ? {} : { throughMessageId: plan.throughMessageId }),
    },
  }
  const checkpointRequest: WorkspaceCheckpointRequest = {
    ...checkpointMaterial,
    idempotencyKey: `${input.operationId}:checkpoint`,
    requestDigest: workspaceCheckpointRequestDigest(checkpointMaterial),
  }
  const checkpointResult = await lookupOrCheckpoint(branching, checkpointRequest)
  if (!workspaceCheckpointResultMatchesRequest(checkpointRequest, checkpointResult))
    throw new AppError('CHECKPOINT_CONFLICT', 'The checkpoint result does not match its request')
  const checkpoint = assertCheckpointResult(checkpointResult)
  const checkpointRecord = toCheckpointRecord(plan, operationId, checkpointRequest, checkpoint)
  if (!state.checkpoints.some((candidate) => candidate.id === checkpointRecord.id)) {
    await host.commit({ kind: 'checkpoint.upserted', checkpoint: checkpointRecord })
    await host.commit({
      kind: 'graph.node.upserted',
      node: graphNode(
        { kind: 'checkpoint', id: checkpointRecord.id },
        checkpointRecord.createdAt,
        'Workspace checkpoint',
      ),
    })
    await host.commit({
      kind: 'graph.edge.upserted',
      edge: graphEdge({
        kind: 'checkpointed',
        source: { kind: 'environment', id: parseEnvironmentId(sourceEnvironment) },
        destination: { kind: 'checkpoint', id: checkpointRecord.id },
        at: checkpointRecord.createdAt,
        provenance: { operationId, sourceDigest: stripSha(checkpointRequest.requestDigest) },
      }),
    })
  }
  await updateOperation(host, operationId, digest, {
    status: 'pending',
    result: {
      checkpointId: String(checkpointRecord.id),
      providerCheckpointId: checkpoint.checkpoint.checkpointId,
    },
  })

  const placement: PlacementInfo = input.placement ?? { kind: 'provider' }
  const forkMaterial = {
    checkpoint: checkpoint.checkpoint,
    name: `braid fork ${plan.destinationBranchId}`,
    placement,
    ...(plan.confidential === undefined ? {} : { confidential: plan.confidential }),
    metadata: {
      braidOperationId: input.operationId,
      destinationBranchId: String(plan.destinationBranchId),
    },
  }
  const forkRequest: WorkspaceForkRequest = {
    ...forkMaterial,
    idempotencyKey: `${input.operationId}:fork`,
    requestDigest: workspaceForkRequestDigest(forkMaterial),
  }
  const forkResult = await lookupOrFork(branching, forkRequest)
  if (!workspaceForkResultMatchesRequest(forkRequest, forkResult))
    throw new AppError('FORK_CONFLICT', 'The environment fork result does not match its request')
  const fork = assertForkResult(forkResult)
  if (fork.environment.sourceEnvironmentId !== source.environmentId)
    throw new AppError(
      'FORK_PLAN_CONFLICT',
      'The provider fork names a different source environment',
    )
  if (fork.environment.environmentId === source.environmentId)
    throw new AppError('FORK_PLAN_CONFLICT', 'The provider fork reused the source environment')
  const destination = await recordForkedEnvironment(host, plan, fork.environment, forkRequest)
  const branch = await createBranch({
    ...input,
    operationId: derivedOperationId(input.operationId, 'branch'),
    destinationBranchId: plan.destinationBranchId,
    environmentId: destination.id,
  })
  await host.commit({
    kind: 'graph.edge.upserted',
    edge: graphEdge({
      kind: 'forked_environment',
      source: { kind: 'checkpoint', id: checkpointRecord.id },
      destination: { kind: 'environment', id: destination.id },
      at: destination.createdAt,
      provenance: { operationId, sourceDigest: stripSha(forkRequest.requestDigest) },
    }),
  })
  await acknowledgeOperation(host, operationId, digest, branch, {
    kind: 'workspace-fork',
    branchId: String(branch.id),
    planDigest: plan.digest,
    checkpointId: String(checkpointRecord.id),
    providerCheckpointId: checkpoint.checkpoint.checkpointId,
    providerEnvironmentId: fork.environment.environmentId,
  })
  return branch
}

async function lookupOrTransfer(
  port: NonNullable<ReturnType<typeof contextTransferPort>>,
  request: ContextTransferRequest,
): Promise<ContextTransferResult> {
  const found = port.lookup === undefined ? undefined : await port.lookup(request)
  if (found !== undefined) return found
  return (
    (await port.transfer?.(request)) ?? {
      status: 'unknown',
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      message: 'The provider did not expose context transfer',
      retryable: false,
    }
  )
}

async function lookupOrCheckpoint(
  branching: NonNullable<ExecutionPort['workspaceBranching']>,
  request: WorkspaceCheckpointRequest,
): Promise<WorkspaceCheckpointResult> {
  const lookup = await branching.lookupCheckpoint({
    idempotencyKey: request.idempotencyKey,
    requestDigest: request.requestDigest,
  })
  if (lookup.status === 'found') return { ...lookup, status: 'replayed' }
  if (lookup.status === 'conflict')
    throw new AppError('CHECKPOINT_CONFLICT', 'Checkpoint idempotency key has a different request')
  if (lookup.status === 'unknown') throw new AppError('CHECKPOINT_UNKNOWN', lookup.message)
  const result = await branching.checkpoint(request)
  if (result.status === 'unknown' || result.status === 'conflict') assertCheckpointResult(result)
  return result
}

async function lookupOrFork(
  branching: NonNullable<ExecutionPort['workspaceBranching']>,
  request: WorkspaceForkRequest,
): Promise<WorkspaceForkResult> {
  const lookup = await branching.lookupFork({
    idempotencyKey: request.idempotencyKey,
    requestDigest: request.requestDigest,
  })
  if (lookup.status === 'found') return { ...lookup, status: 'replayed' }
  if (lookup.status === 'conflict')
    throw new AppError('FORK_CONFLICT', 'Fork idempotency key has a different request')
  if (lookup.status === 'unknown') throw new AppError('FORK_UNKNOWN', lookup.message)
  const result = await branching.fork(request)
  if (result.status === 'unknown' || result.status === 'conflict') assertForkResult(result)
  return result
}

async function cleanupCheckpoint(
  host: ConversationHost,
  branching: NonNullable<ExecutionPort['workspaceBranching']>,
  operationId: ReturnType<typeof parseOperationId>,
  checkpoint: CheckpointRecord,
): Promise<'deleted' | 'already_absent'> {
  const providerCheckpointId = providerCheckpointIdFor(host.state(), checkpoint)
  if (providerCheckpointId === undefined)
    throw new AppError('UNKNOWN_CHECKPOINT', 'The checkpoint has no provider reference')
  const provider = providerForCheckpoint(host.state(), checkpoint)
  const material = { kind: 'checkpoint' as const, targetId: providerCheckpointId, provider }
  const request: WorkspaceCleanupRequest = {
    operationId,
    ...material,
    requestDigest: workspaceCleanupRequestDigest(material),
  }
  const ack = await branching.deleteCheckpoint({ ...request, kind: 'checkpoint' })
  assertCleanupAcknowledgement(request, ack)
  if (ack.status === 'deleted' || ack.status === 'already_absent') {
    await host.commit({
      kind: 'checkpoint.upserted',
      checkpoint: { ...checkpoint, status: 'deleted' },
    })
    return ack.status
  }
  throw new AppError('CLEANUP_UNKNOWN', ack.message ?? 'Checkpoint cleanup is unresolved')
}

async function cleanupEnvironment(
  host: ConversationHost,
  branching: NonNullable<ExecutionPort['workspaceBranching']>,
  operationId: ReturnType<typeof parseOperationId>,
  environment: EnvironmentRecord,
): Promise<'deleted' | 'already_absent'> {
  const targetId = environment.providerEnvironmentId
  if (targetId === undefined)
    throw new AppError('UNKNOWN_ENVIRONMENT', 'The environment has no provider reference')
  const material = {
    kind: 'fork' as const,
    targetId,
    provider: environment.placement.provider,
  }
  const request: WorkspaceCleanupRequest = {
    operationId,
    ...material,
    requestDigest: workspaceCleanupRequestDigest(material),
  }
  const ack = await branching.destroyFork({ ...request, kind: 'fork' })
  assertCleanupAcknowledgement(request, ack)
  if (ack.status === 'deleted' || ack.status === 'already_absent') {
    await host.commit({
      kind: 'environment.upserted',
      environment: { ...environment, lifecycle: 'destroyed', updatedAt: host.now() },
    })
    return ack.status
  }
  throw new AppError('CLEANUP_UNKNOWN', ack.message ?? 'Environment cleanup is unresolved')
}

function assertCleanupAcknowledgement(
  request: WorkspaceCleanupRequest,
  acknowledgement: WorkspaceCleanupAcknowledgement,
): void {
  if (!workspaceCleanupAcknowledgementMatches(request, acknowledgement))
    throw new AppError('CLEANUP_CONFLICT', 'The cleanup acknowledgement does not match its request')
}

function assertCleanupCapabilities(
  state: BraidState,
  checkpoint: CheckpointRecord | undefined,
  environment: EnvironmentRecord | undefined,
): void {
  const sourceCheckpoint =
    checkpoint ??
    (environment === undefined
      ? undefined
      : (() => {
          const edge = state.graphEdges.find((candidate) => {
            const source = graphReference(state, candidate.source)
            const destination = graphReference(state, candidate.destination)
            return (
              candidate.kind === 'forked_environment' &&
              destination?.kind === 'environment' &&
              destination.id === environment.id &&
              source?.kind === 'checkpoint'
            )
          })
          const source = edge === undefined ? undefined : graphReference(state, edge.source)
          return source?.kind === 'checkpoint'
            ? state.checkpoints.find((candidate) => candidate.id === source.id)
            : undefined
        })())
  const sourceRun =
    sourceCheckpoint?.sourceRunId === undefined
      ? undefined
      : state.runs.find((candidate) => candidate.id === sourceCheckpoint.sourceRunId)
  const branching = sourceRun?.capabilities.environment?.branching
  if (
    sourceRun === undefined ||
    branching?.checkpoint !== true ||
    branching.fork !== true ||
    branching.retrySafe !== true ||
    branching.lookup !== true ||
    branching.cleanup !== true
  )
    throw new AppError(
      'CAPABILITY_UNAVAILABLE',
      'The selected run does not report retry-safe workspace cleanup support',
    )
}

function sourceEnvironmentForCleanup(
  state: BraidState,
  checkpoint: CheckpointRecord | undefined,
  environment: EnvironmentRecord | undefined,
): EnvironmentRecord | undefined {
  const sourceCheckpoint =
    checkpoint ??
    (environment === undefined
      ? undefined
      : (() => {
          const edge = state.graphEdges.find((candidate) => {
            const source = graphReference(state, candidate.source)
            const destination = graphReference(state, candidate.destination)
            return (
              candidate.kind === 'forked_environment' &&
              destination?.kind === 'environment' &&
              destination.id === environment.id &&
              source?.kind === 'checkpoint'
            )
          })
          const source = edge === undefined ? undefined : graphReference(state, edge.source)
          return source?.kind === 'checkpoint'
            ? state.checkpoints.find((candidate) => candidate.id === source.id)
            : undefined
        })())
  if (sourceCheckpoint === undefined) return undefined
  return state.environments.find(
    (candidate) => candidate.id === sourceCheckpoint.sourceEnvironmentId,
  )
}

function cleanupResultFromOperation(
  operation: OperationRecord | undefined,
): WorkspaceForkCleanupResult | undefined {
  if (operation?.result === undefined) return undefined
  const checkpoint = operation.result.checkpoint
  const environment = operation.result.environment
  if (!isCleanupStatus(checkpoint) || !isCleanupStatus(environment))
    throw new AppError(
      'OPERATION_INCOMPLETE',
      `Operation ${operation.id} has an invalid cleanup result`,
    )
  return { checkpoint, environment }
}

function isCleanupStatus(value: unknown): value is WorkspaceForkCleanupResult['checkpoint'] {
  return value === 'deleted' || value === 'already_absent' || value === 'not_requested'
}

function assertReadyPlan(
  result: PortableContextPlanResult,
): asserts result is Extract<PortableContextPlanResult, { status: 'ready' }> {
  if (result.status !== 'ready') throw new AppError('CONTEXT_PLAN_UNAVAILABLE', result.message)
}

function assertAcceptedTransfer(
  result: ContextTransferResult,
): Extract<ContextTransferResult, { status: 'accepted' | 'replayed' }> {
  if (result.status === 'accepted' || result.status === 'replayed') return result
  if (result.status === 'conflict')
    throw new AppError(
      'CONTEXT_RECEIPT_CONFLICT',
      'The provider rejected a changed context transfer request',
    )
  if (result.status === 'unknown' || result.status === 'transport_failure')
    throw new AppError('CONTEXT_TRANSFER_UNKNOWN', result.message)
  throw new AppError('CONTEXT_TRANSFER_UNKNOWN', 'The provider did not accept context transfer')
}

function assertCheckpointResult(
  result: WorkspaceCheckpointResult,
): Extract<WorkspaceCheckpointResult, { status: 'created' | 'replayed' }> {
  if (result.status === 'created' || result.status === 'replayed') return result
  if (result.status === 'conflict')
    throw new AppError('CHECKPOINT_CONFLICT', 'The provider rejected a changed checkpoint request')
  if (result.status === 'unknown') throw new AppError('CHECKPOINT_UNKNOWN', result.message)
  throw new AppError('CHECKPOINT_UNKNOWN', 'The provider did not create the checkpoint')
}

function assertForkResult(
  result: WorkspaceForkResult,
): Extract<WorkspaceForkResult, { status: 'created' | 'replayed' }> {
  if (result.status === 'created' || result.status === 'replayed') return result
  if (result.status === 'conflict')
    throw new AppError('FORK_CONFLICT', 'The provider rejected a changed fork request')
  if (result.status === 'unknown') throw new AppError('FORK_UNKNOWN', result.message)
  throw new AppError('FORK_UNKNOWN', 'The provider did not create the environment fork')
}

function sourceRunForPlan(
  state: BraidState,
  plan: ForkPlan,
): BraidState['runs'][number] | undefined {
  if (plan.sourceRunId !== undefined) {
    const run = state.runs.find((candidate) => candidate.id === plan.sourceRunId)
    if (run !== undefined) return run
  }
  return state.runs
    .filter((run) => run.branchId === plan.sourceBranchId && run.controlRef !== undefined)
    .at(-1)
}

function toCheckpointRecord(
  plan: ForkPlan,
  operationId: ReturnType<typeof parseOperationId>,
  request: WorkspaceCheckpointRequest,
  result: Extract<WorkspaceCheckpointResult, { status: 'created' | 'replayed' }>,
): CheckpointRecord {
  return {
    id: createCheckpointId(
      `checkpoint-${canonicalDigest({ provider: result.checkpoint.provider, id: result.checkpoint.checkpointId }).slice(0, 32)}`,
    ),
    sourceEnvironmentId: parseEnvironmentId(
      plan.sourceEnvironmentId ?? result.checkpoint.source.environmentId,
    ),
    sourceBranchId: parseBranchId(plan.sourceBranchId),
    ...(plan.sourceRunId === undefined ? {} : { sourceRunId: parseRunId(plan.sourceRunId) }),
    ...(plan.throughMessageId === undefined
      ? {}
      : { throughMessageId: parseMessageId(plan.throughMessageId) }),
    requestDigest: stripSha(request.requestDigest),
    operationId,
    createdAt: result.checkpoint.createdAt,
    status: 'ready',
  }
}

async function recordDestinationEnvironment(
  host: ConversationHost,
  plan: ForkPlan,
  receipt: Extract<ContextTransferResult, { status: 'accepted' | 'replayed' }>,
): Promise<EnvironmentRecord | undefined> {
  const source = host
    .state()
    .environments.find((environment) => environment.id === plan.sourceEnvironmentId)
  if (source === undefined) return undefined
  const id = createEnvironmentId(
    `environment-handoff-${canonicalDigest({ provider: receipt.provider, environmentId: receipt.environmentId, operationId: receipt.operationId }).slice(0, 32)}`,
  )
  if (id === source.id)
    throw new AppError('FORK_PLAN_CONFLICT', 'The destination environment matches the source')
  const at = receipt.admittedAt
  const environment: EnvironmentRecord = {
    id,
    workspaceId: source.workspaceId,
    connectionId: source.connectionId,
    lifecycle: 'ready',
    placement: {
      provider: receipt.provider,
      confidentialRequested: false,
      confidentialVerified: false,
    },
    providerEnvironmentId: receipt.environmentId,
    continuity: 'session',
    location: 'remote',
    secretNames: [],
    createdAt: at,
    startedAt: at,
    lastActivityAt: at,
    updatedAt: at,
  }
  const existing = host.state().environments.find((candidate) => candidate.id === id)
  if (existing === undefined) {
    await host.commit({ kind: 'environment.upserted', environment })
    await host.commit({
      kind: 'graph.node.upserted',
      node: graphNode({ kind: 'environment', id }, at, 'Handoff environment'),
    })
  }
  return existing ?? environment
}

async function recordForkedEnvironment(
  host: ConversationHost,
  plan: ForkPlan,
  ref: Extract<WorkspaceForkResult, { status: 'created' | 'replayed' }>['environment'],
  request: WorkspaceForkRequest,
): Promise<EnvironmentRecord> {
  const source = host
    .state()
    .environments.find((environment) => environment.id === plan.sourceEnvironmentId)
  if (source === undefined)
    throw new AppError('UNKNOWN_ENVIRONMENT', 'The source environment record is unavailable')
  const id = createEnvironmentId(
    `environment-fork-${canonicalDigest({ provider: ref.provider, environmentId: ref.environmentId, operationId: ref.idempotencyKey }).slice(0, 32)}`,
  )
  const at = ref.createdAt
  const environment: EnvironmentRecord = {
    id,
    workspaceId: source.workspaceId,
    connectionId: source.connectionId,
    lifecycle: 'ready',
    placement: {
      provider: ref.provider,
      ...(ref.placement.region === undefined ? {} : { region: ref.placement.region }),
      confidentialRequested: ref.confidentialRequested,
      confidentialVerified:
        ref.confidentialRequested && host.execution?.confidentialAttestationVerifier !== undefined
          ? verifiedForkConfidentiality(
              request,
              ref,
              host.execution.confidentialAttestationVerifier,
            )
          : false,
    },
    providerEnvironmentId: ref.environmentId,
    continuity: 'session',
    location: 'remote',
    secretNames: [],
    createdAt: at,
    startedAt: at,
    lastActivityAt: at,
    updatedAt: at,
  }
  const existing = host.state().environments.find((candidate) => candidate.id === id)
  if (existing === undefined) {
    await host.commit({ kind: 'environment.upserted', environment })
    await host.commit({
      kind: 'graph.node.upserted',
      node: graphNode({ kind: 'environment', id }, at, 'Workspace fork environment'),
    })
  }
  return existing ?? environment
}

function verifiedForkConfidentiality(
  request: WorkspaceForkRequest,
  environment: Extract<WorkspaceForkResult, { status: 'created' | 'replayed' }>['environment'],
  verifier: NonNullable<ExecutionPort['confidentialAttestationVerifier']>,
): boolean {
  try {
    return forkedEnvironmentConfidentialityVerified(
      request,
      environment,
      (attestation, expected) => {
        if (
          attestation.providerKeyId === 'unverified' ||
          attestation.providerSignature === 'unverified' ||
          attestation.providerSignature === attestation.quote
        )
          return false
        try {
          return verifier(attestation, expected) === true
        } catch {
          return false
        }
      },
    )
  } catch {
    return false
  }
}

async function recordHandedOffEdge(
  host: ConversationHost,
  plan: ForkPlan,
  branch: BranchRecord,
  sourceDigest: string,
  operationId: ReturnType<typeof parseOperationId>,
): Promise<void> {
  const edge = graphEdge({
    kind: 'handed_off',
    source: { kind: 'branch', id: parseBranchId(plan.sourceBranchId) },
    destination: { kind: 'branch', id: branch.id },
    at: host.now(),
    provenance: { operationId, sourceDigest: stripSha(sourceDigest) },
  })
  if (!host.state().graphEdges.some((candidate) => candidate.id === edge.id))
    await host.commit({ kind: 'graph.edge.upserted', edge })
}

async function reserveOperation(
  host: ConversationHost,
  operationId: ReturnType<typeof parseOperationId>,
  digest: string,
): Promise<BraidState> {
  const state = host.state()
  const existing = state.operations.find((operation) => operation.id === operationId)
  if (existing !== undefined && existing.kind !== 'conversation-fork')
    throw new AppError(
      'OPERATION_ID_CONFLICT',
      `Operation ${operationId} was already used by another command`,
    )
  if (existing !== undefined && existing.requestDigest !== digest)
    throw new AppError(
      'OPERATION_ID_CONFLICT',
      `Operation ${operationId} was already used with different input`,
    )
  if (existing !== undefined) return state
  const at = host.now()
  const operation: OperationRecord = {
    id: operationId,
    kind: 'conversation-fork',
    requestDigest: digest as Digest,
    status: 'pending',
    createdAt: at,
    updatedAt: at,
  }
  await host.commit({ kind: 'operation.requested', operation })
  return host.state()
}

async function updateOperation(
  host: ConversationHost,
  operationId: ReturnType<typeof parseOperationId>,
  digest: string,
  input: Pick<OperationRecord, 'status' | 'result'>,
): Promise<void> {
  const current = host.state().operations.find((operation) => operation.id === operationId)
  if (current === undefined)
    throw new AppError('OPERATION_INCOMPLETE', `Operation ${operationId} is missing`)
  const operation =
    input.result === undefined
      ? {
          ...current,
          requestDigest: digest as Digest,
          status: input.status,
          updatedAt: host.now(),
        }
      : {
          ...current,
          requestDigest: digest as Digest,
          status: input.status,
          result: input.result,
          updatedAt: host.now(),
        }
  await host.commit({
    kind: 'operation.updated',
    operation,
  })
}

async function acknowledgeOperation(
  host: ConversationHost,
  operationId: ReturnType<typeof parseOperationId>,
  digest: string,
  branch: BranchRecord,
  result: unknown,
): Promise<void> {
  const current = host.state().operations.find((operation) => operation.id === operationId)
  if (current === undefined)
    throw new AppError('OPERATION_INCOMPLETE', `Operation ${operationId} is missing`)
  await host.commit({
    kind: 'operation.updated',
    operation: {
      ...current,
      requestDigest: digest as Digest,
      status: 'acknowledged',
      target: { kind: 'branch', id: branch.id },
      result: operationResult(result),
      updatedAt: host.now(),
      acknowledgedAt: host.now(),
    },
  })
}

async function acknowledgeCleanupOperation(
  host: ConversationHost,
  operationId: ReturnType<typeof parseOperationId>,
  digest: string,
  result: WorkspaceForkCleanupResult,
): Promise<void> {
  const current = host.state().operations.find((operation) => operation.id === operationId)
  if (current === undefined)
    throw new AppError('OPERATION_INCOMPLETE', `Operation ${operationId} is missing`)
  await host.commit({
    kind: 'operation.updated',
    operation: {
      ...current,
      requestDigest: digest as Digest,
      status: 'acknowledged',
      result: operationResult(result),
      updatedAt: host.now(),
      acknowledgedAt: host.now(),
    },
  })
}

function operationResult(value: unknown): NonNullable<OperationRecord['result']> {
  objectValue(value, 'operation.result')
  assertJsonValue(value, 'operation.result')
  return value
}

function branchForOperation(state: BraidState, operation: OperationRecord): BranchRecord {
  if (operation.target?.kind !== 'branch')
    throw new AppError('OPERATION_INCOMPLETE', `Operation ${operation.id} has no branch result`)
  const branch = state.branches.find((candidate) => candidate.id === operation.target?.id)
  if (branch === undefined)
    throw new AppError(
      'OPERATION_INCOMPLETE',
      `Operation ${operation.id} has no durable branch result`,
    )
  return branch
}

function derivedOperationId(operationId: string, label: string): string {
  return `operation-${canonicalDigest({ operationId, label }).slice(0, 48)}`
}

function contextTransferPort(
  execution: ExecutionPort | undefined,
): NonNullable<ExecutionPort['context']> | undefined {
  return execution?.context ?? execution?.contextTransfer
}

function hasWorkspaceBranching(
  branching: ExecutionPort['workspaceBranching'],
): branching is NonNullable<ExecutionPort['workspaceBranching']> {
  return (
    branching !== undefined &&
    typeof branching.checkpoint === 'function' &&
    typeof branching.lookupCheckpoint === 'function' &&
    typeof branching.deleteCheckpoint === 'function' &&
    typeof branching.fork === 'function' &&
    typeof branching.lookupFork === 'function' &&
    typeof branching.destroyFork === 'function'
  )
}

/** Resolve a fresh source handle when the provider exposes restart-safe lookup. */
async function workspaceBranchingForEnvironment(
  execution: ExecutionPort | undefined,
  providerEnvironmentId: string | undefined,
): Promise<ExecutionPort['workspaceBranching']> {
  const provider = execution?.workspaceBranchingProvider
  if (provider !== undefined) {
    if (providerEnvironmentId === undefined) return undefined
    return (await provider.forEnvironment(providerEnvironmentId)) ?? undefined
  }
  return execution?.workspaceBranching
}

function graphReference(state: BraidState, id: string) {
  return state.graphNodes.find((node) => node.id === id)?.reference
}

function providerCheckpointIdFor(
  state: BraidState,
  checkpoint: CheckpointRecord,
): string | undefined {
  const operation = state.operations.find((candidate) => candidate.id === checkpoint.operationId)
  const value = operation?.result?.providerCheckpointId
  return typeof value === 'string' ? value : undefined
}

function providerForCheckpoint(state: BraidState, checkpoint: CheckpointRecord): string {
  const environment = state.environments.find(
    (candidate) => candidate.id === checkpoint.sourceEnvironmentId,
  )
  return environment?.placement.provider ?? 'unknown-provider'
}

function stripSha(value: string): Digest {
  const digest = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value
  return digest as Digest
}
