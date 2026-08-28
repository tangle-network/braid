import { canonicalAgentProfileDigestHex } from '../adapters/agent-interface/profile-runtime.js'
import { canonicalDigest } from '../domain/canonical.js'
import type { BranchRecord, ConversationRecord, MessageRecord } from '../domain/entities.js'
import { graphEdge, graphNode } from '../domain/graph-records.js'
import {
  type BranchId,
  type ConversationId,
  type OperationId,
  parseBranchId,
  parseConversationId,
  parseEnvironmentId,
  parseMessageId,
  parseOperationId,
} from '../domain/ids.js'
import type { BraidState } from '../domain/state.js'
import type { ExecutionPort } from '../ports/execution.js'
import { cleanupWorkspaceFork, executeBranchEffect } from './conversation-branch-effects.js'
import {
  canonicalPortableContextPlanForState,
  messagesVisibleOnBranch,
  portablePlanForState,
} from './conversation-context.js'
import {
  conversationBundle,
  draftRecord,
  queueRecord,
  runOverrides,
} from './conversation-records.js'
import {
  acknowledgedOperation,
  coordinateConversationOperation,
  normalizedTitle,
  operationReplay,
  parseOperation,
  requestDigest,
  requireWorkspace,
  stableBranchIds,
  stableConversationIds,
} from './conversation-support.js'
import type {
  ConfidentialExecutionRequest,
  CloneConversationInput,
  ConversationHost,
  CreateBranchInput,
  ForkPlan,
  ForkPlanInput,
  SetRunOverridesInput,
} from './conversation-types.js'
import { AppError } from './errors.js'

interface ResolvedSource {
  readonly conversation: ConversationRecord
  readonly branch: BranchRecord
  readonly through?: MessageRecord
}

export class ConversationBranches {
  readonly #host: ConversationHost

  constructor(host: ConversationHost) {
    this.#host = host
  }

  async setRunOverrides(input: SetRunOverridesInput): Promise<BranchRecord> {
    return coordinateConversationOperation(this.#host, 'set_run_override', input, () =>
      this.#setRunOverrides(input),
    )
  }

  async #setRunOverrides(input: SetRunOverridesInput): Promise<BranchRecord> {
    const state = this.#host.state()
    const source = resolveBranch(state, input)
    const operationId = parseOperation(input.operationId, 'set_run_override')
    const hasOverride = [input.runner, input.model, input.effort, input.mode].some(
      (value) => value !== undefined,
    )
    if (input.clear === true && hasOverride)
      throw new AppError(
        'INVALID_RUN_OVERRIDE',
        'Clear cannot be combined with a run override value',
      )
    if (input.clear !== true && !hasOverride)
      throw new AppError('INVALID_RUN_OVERRIDE', 'Set at least one run override or clear all')
    const selected = runOverrides({
      ...(input.runner === undefined ? {} : { runner: input.runner }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      ...(input.mode === undefined ? {} : { mode: input.mode }),
    })
    const normalized = {
      conversationId: source.conversation.id,
      branchId: source.branch.id,
      clear: input.clear === true,
      runner: selected.runner ?? null,
      model: selected.model ?? null,
      effort: selected.effort ?? null,
      mode: selected.mode ?? null,
    }
    const digest = requestDigest('set_run_override', normalized)
    const replay = operationReplay(state, operationId, 'run-override', digest)
    if (replay) return branchForOperation(state, replay)
    const at = this.#host.now()
    const branch: BranchRecord = {
      ...source.branch,
      overrides: input.clear === true ? {} : { ...source.branch.overrides, ...selected },
      updatedAt: at,
    }
    await this.#host.commit({
      kind: 'branch.updated',
      branch,
      operation: acknowledgedOperation({
        id: operationId,
        kind: 'run-override',
        digest,
        at,
        target: { kind: 'branch', id: branch.id },
      }),
    })
    return branch
  }

  async create(input: CreateBranchInput): Promise<BranchRecord> {
    return coordinateConversationOperation(this.#host, 'branch', input, () => this.#create(input))
  }

  async #create(input: CreateBranchInput): Promise<BranchRecord> {
    const state = this.#host.state()
    const source = resolveSource(state, input)
    const operationId = parseOperation(input.operationId, 'branch')
    const normalized = branchRequest(source, input)
    const digest = requestDigest('branch', normalized)
    const replay = operationReplay(state, operationId, 'branch-create', digest)
    if (replay) return branchForOperation(state, replay)
    const ids =
      input.destinationBranchId === undefined
        ? stableBranchIds(operationId, digest)
        : {
            branchId: parseBranchId(input.destinationBranchId),
            draftId: stableBranchIds(operationId, digest).draftId,
            queueId: stableBranchIds(operationId, digest).queueId,
          }
    const at = this.#host.now()
    const draft = draftRecord(ids.draftId, ids.branchId, at, input.text)
    const queue = queueRecord(ids.queueId, ids.branchId, at)
    const branch: BranchRecord = {
      id: ids.branchId,
      conversationId: source.conversation.id,
      source: {
        conversationId: source.conversation.id,
        branchId: source.branch.id,
        ...(source.through === undefined ? {} : { throughMessageId: source.through.id }),
        ...(source.through?.turnId === undefined ? {} : { throughTurnId: source.through.turnId }),
      },
      ...(source.branch.profileId === undefined ? {} : { profileId: source.branch.profileId }),
      ...(source.branch.profileSnapshotId === undefined
        ? {}
        : { profileSnapshotId: source.branch.profileSnapshotId }),
      ...(source.branch.connectionId === undefined
        ? {}
        : { connectionId: source.branch.connectionId }),
      overrides: runOverrides({
        inherited: source.branch.overrides,
        ...(input.runner === undefined ? {} : { runner: input.runner }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.mode === undefined ? {} : { mode: input.mode }),
      }),
      ...(source.branch.environmentId === undefined
        ? input.environmentId === undefined
          ? {}
          : { environmentId: parseEnvironmentId(input.environmentId) }
        : input.environmentId === undefined
          ? { environmentId: source.branch.environmentId }
          : { environmentId: parseEnvironmentId(input.environmentId) }),
      draftId: draft.id,
      queueId: queue.id,
      ...(source.through === undefined ? {} : { tipMessageId: source.through.id }),
      status: 'active',
      createdAt: at,
      updatedAt: at,
    }
    const conversation = {
      ...source.conversation,
      activeBranchId: branch.id,
      updatedAt: at,
    }
    const sourceReference = source.through
      ? ({ kind: 'message', id: source.through.id } as const)
      : ({ kind: 'branch', id: source.branch.id } as const)
    const sourceNode = graphNode(sourceReference, at)
    const branchNode = graphNode({ kind: 'branch', id: branch.id }, at, 'Branch')
    await this.#host.commit({
      kind: 'branch.created',
      branch,
      conversation,
      draft,
      queue,
      graphNodes: [sourceNode, branchNode],
      graphEdges: [
        graphEdge({
          kind: 'branched_at',
          source: sourceNode.reference,
          destination: branchNode.reference,
          at,
          provenance: { operationId },
        }),
      ],
      operation: acknowledgedOperation({
        id: operationId,
        kind: 'branch-create',
        digest,
        at,
        target: { kind: 'branch', id: branch.id },
      }),
    })
    return branch
  }

  async clone(input: CloneConversationInput): Promise<ConversationRecord> {
    return coordinateConversationOperation(this.#host, 'clone', input, () => this.#clone(input))
  }

  async #clone(input: CloneConversationInput): Promise<ConversationRecord> {
    const state = this.#host.state()
    const workspaceId = requireWorkspace(state)
    const source = resolveSource(state, input)
    const operationId = parseOperation(input.operationId, 'clone')
    const title = normalizedTitle(input.title, `${source.conversation.title} copy`)
    const digest = requestDigest('clone', {
      conversationId: source.conversation.id,
      branchId: source.branch.id,
      throughMessageId: source.through?.id ?? null,
      title,
    })
    const replay = operationReplay(state, operationId, 'conversation-clone', digest)
    if (replay) return conversationForOperation(state, replay)
    const ids = stableConversationIds(operationId, digest, 'clone')
    const at = this.#host.now()
    const bundle = conversationBundle({
      workspaceId,
      ...ids,
      title,
      at,
      operationId,
      ...(source.branch.profileId === undefined ? {} : { profileId: source.branch.profileId }),
      ...(source.branch.connectionId === undefined
        ? {}
        : { connectionId: source.branch.connectionId }),
      source: {
        conversationId: source.conversation.id,
        branchId: source.branch.id,
        ...(source.through === undefined ? {} : { throughMessageId: source.through.id }),
        ...(source.through?.turnId === undefined ? {} : { throughTurnId: source.through.turnId }),
      },
      sourceNode: { kind: 'branch', id: source.branch.id },
      sourceEdgeKind: 'cloned_from',
      overrides: source.branch.overrides,
      ...(source.branch.environmentId === undefined
        ? {}
        : { environmentId: source.branch.environmentId }),
    })
    await this.#host.commit({
      kind: 'conversation.created',
      ...bundle,
      operation: acknowledgedOperation({
        id: operationId,
        kind: 'conversation-clone',
        digest,
        at,
        target: { kind: 'conversation', id: bundle.conversation.id },
      }),
    })
    return bundle.conversation
  }

  plan(input: ForkPlanInput): ForkPlan {
    const state = this.#host.state()
    const source = resolveSource(state, input)
    const operationId = parseOperation(input.operationId, 'plan_fork')
    const normalized = branchRequest(source, input)
    const branchDigest = requestDigest('branch', normalized)
    const destinationBranchId = stableBranchIds(operationId, branchDigest).branchId
    const sourceRunner = source.branch.overrides.runner ?? state.profile.harness
    const requestedRunner = input.runner ?? sourceRunner
    const sourceRun = sourceRunForBranch(state, source.branch.id, source.through?.runId)
    const sourceEnvironmentId = source.branch.environmentId ?? sourceRun?.environmentId
    const kind =
      input.kind ??
      (input.runner !== undefined && input.runner !== sourceRunner
        ? ('cross-runner' as const)
        : ('conversation' as const))
    const context = portablePlanForState(state, {
      branchId: source.branch.id,
      ...(source.through === undefined ? {} : { throughMessageId: source.through.id }),
      ...(input.runner === undefined ? {} : { destinationRunner: input.runner }),
    })
    const workspaceAvailable = workspaceForkReported(
      state,
      sourceRun,
      this.#host.execution,
      sourceEnvironmentId,
      input.confidential?.requested === true,
    )
    const portableContextPlan =
      kind === 'cross-runner'
        ? canonicalPortableContextPlanForState(state, {
            operationId,
            branchId: source.branch.id,
            ...(source.through === undefined ? {} : { throughMessageId: source.through.id }),
            destinationRunner: requestedRunner ?? 'unknown-runner',
            ...(input.destinationProvider === undefined
              ? {}
              : { destinationProvider: input.destinationProvider }),
            ...(input.model === undefined ? {} : { destinationModel: input.model }),
            profileDigest: canonicalAgentProfileDigestHex(state.profile),
          })
        : undefined
    const contextPort = contextTransferPort(this.#host.execution)
    const crossRunnerAvailable =
      kind === 'cross-runner' &&
      portableContextPlan !== undefined &&
      sourceEnvironmentId !== undefined &&
      state.environments.some(
        (environment) =>
          environment.id === sourceEnvironmentId &&
          environment.providerEnvironmentId === portableContextPlan.source.source.environmentId,
      ) &&
      contextPort?.transfer !== undefined
    const allowed =
      kind === 'conversation' || (kind === 'workspace' ? workspaceAvailable : crossRunnerAvailable)
    const plan = {
      kind,
      operationId,
      sourceConversationId: source.conversation.id,
      sourceBranchId: source.branch.id,
      ...(source.through === undefined ? {} : { throughMessageId: source.through.id }),
      destinationBranchId,
      context,
      ...(portableContextPlan === undefined ? {} : { portableContextPlan }),
      ...(sourceRun === undefined ? {} : { sourceRunId: sourceRun.id }),
      ...(sourceEnvironmentId === undefined ? {} : { sourceEnvironmentId }),
      ...(portableContextPlan === undefined
        ? {}
        : { destinationEnvironmentId: portableContextPlan.destination.environmentId }),
      ...(input.placement === undefined ? {} : { placement: input.placement }),
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.destinationProvider === undefined
        ? {}
        : { destinationProvider: input.destinationProvider }),
      ...(input.confidential === undefined ? {} : { confidential: input.confidential }),
      environment:
        kind === 'conversation'
          ? ('shared' as const)
          : kind === 'workspace'
            ? workspaceAvailable
              ? ('new' as const)
              : ('unavailable' as const)
            : crossRunnerAvailable
              ? ('new' as const)
              : ('unavailable' as const),
      providerSession: 'new' as const,
      checkpoint:
        kind !== 'workspace'
          ? ('none' as const)
          : workspaceAvailable
            ? ('required' as const)
            : ('unavailable' as const),
      allowed,
      ...(allowed
        ? {}
        : {
            reason:
              kind === 'workspace'
                ? workspaceAvailable
                  ? 'The current runtime does not expose retry-safe environment fork execution to Braid'
                  : input.confidential?.requested === true
                    ? 'The selected run does not expose confidential placement and attestation verification'
                    : 'The selected run does not report retry-safe checkpoint and environment fork support'
                : 'The selected connection does not expose canonical fresh-session context transfer',
          }),
    }
    return { ...plan, digest: canonicalDigest(plan) }
  }

  async execute(input: ForkPlanInput & { readonly planDigest: string }): Promise<BranchRecord> {
    return coordinateConversationOperation(this.#host, 'execute_fork', input, () =>
      this.#execute(input),
    )
  }

  async #execute(input: ForkPlanInput & { readonly planDigest: string }): Promise<BranchRecord> {
    const existing = this.#host
      .state()
      .operations.find((operation) => operation.id === parseOperationId(input.operationId))
    if (existing?.kind === 'conversation-fork' && existing.status === 'acknowledged') {
      if (existing.result?.planDigest !== input.planDigest)
        throw new AppError(
          'FORK_PLAN_CONFLICT',
          'The accepted fork plan no longer matches the operation',
        )
      return branchForOperation(this.#host.state(), existing)
    }
    const plan = this.plan(input)
    if (plan.digest !== input.planDigest) {
      throw new AppError(
        'FORK_PLAN_CONFLICT',
        'The accepted fork plan no longer matches the source',
      )
    }
    if (!plan.allowed) {
      throw new AppError('CAPABILITY_UNAVAILABLE', plan.reason ?? 'Workspace fork is unavailable')
    }
    const branch =
      plan.kind === 'conversation'
        ? await this.#create(input)
        : await executeBranchEffect(this.#host, input, plan, (branchInput) =>
            this.#create(branchInput),
          )
    if (branch.id !== plan.destinationBranchId) {
      throw new AppError('FORK_PLAN_CONFLICT', 'Fork execution produced an unexpected branch')
    }
    return branch
  }

  async cleanup(input: import('./conversation-types.js').WorkspaceForkCleanupInput) {
    return coordinateConversationOperation(this.#host, 'cleanup_fork', input, () =>
      cleanupWorkspaceFork(this.#host, input),
    )
  }
}

function resolveSource(
  state: BraidState,
  input: Pick<CreateBranchInput, 'conversationId' | 'branchId' | 'throughMessageId'>,
): ResolvedSource {
  const { conversation, branch } = resolveBranch(state, input)
  const visible = messagesVisibleOnBranch(state, branch.id)
  const boundaryId = input.throughMessageId ?? branch.tipMessageId ?? visible.at(-1)?.id
  const through =
    boundaryId === undefined
      ? undefined
      : visible.find((message) => message.id === parseMessageId(boundaryId))
  if (boundaryId !== undefined && through === undefined) {
    throw new AppError(
      'UNKNOWN_MESSAGE_BOUNDARY',
      `Message ${boundaryId} is not visible on ${branch.id}`,
    )
  }
  return { conversation, branch, ...(through === undefined ? {} : { through }) }
}

function resolveBranch(
  state: BraidState,
  input: Pick<CreateBranchInput, 'conversationId' | 'branchId'>,
): Pick<ResolvedSource, 'conversation' | 'branch'> {
  const conversationId = parseConversationId(input.conversationId ?? state.conversationId)
  const conversation = state.conversations.find(
    (candidate) => candidate.id === conversationId && candidate.deletedAt === undefined,
  )
  if (!conversation)
    throw new AppError('UNKNOWN_CONVERSATION', `Conversation ${conversationId} is unavailable`)
  const branchId = parseBranchId(input.branchId ?? conversation.activeBranchId)
  const branch = state.branches.find(
    (candidate) => candidate.id === branchId && candidate.conversationId === conversationId,
  )
  if (!branch)
    throw new AppError('UNKNOWN_BRANCH', `Branch ${branchId} does not belong to ${conversationId}`)
  return { conversation, branch }
}

function branchRequest(
  source: ResolvedSource,
  input: CreateBranchInput & { readonly confidential?: ConfidentialExecutionRequest },
) {
  const confidential = input.confidential
  return {
    conversationId: source.conversation.id,
    branchId: source.branch.id,
    throughMessageId: source.through?.id ?? null,
    text: input.text ?? '',
    runner: input.runner ?? source.branch.overrides.runner ?? null,
    model: input.model ?? source.branch.overrides.model ?? null,
    effort: input.effort ?? source.branch.overrides.effort ?? null,
    mode: input.mode ?? source.branch.overrides.mode ?? null,
    ...(confidential === undefined ? {} : { confidential }),
  }
}

function branchForOperation(
  state: BraidState,
  operation: {
    readonly id: OperationId
    readonly target?: { readonly kind: string; readonly id: string }
  },
): BranchRecord {
  if (operation.target?.kind !== 'branch') {
    throw new AppError('OPERATION_INCOMPLETE', `Operation ${operation.id} has no branch result`)
  }
  const branch = state.branches.find((candidate) => candidate.id === operation.target?.id)
  if (!branch)
    throw new AppError('OPERATION_INCOMPLETE', `Operation ${operation.id} has no durable result`)
  return branch
}

function conversationForOperation(
  state: BraidState,
  operation: {
    readonly id: OperationId
    readonly target?: { readonly kind: string; readonly id: string }
  },
): ConversationRecord {
  if (operation.target?.kind !== 'conversation') {
    throw new AppError(
      'OPERATION_INCOMPLETE',
      `Operation ${operation.id} has no conversation result`,
    )
  }
  const conversation = state.conversations.find(
    (candidate) => candidate.id === operation.target?.id,
  )
  if (!conversation)
    throw new AppError('OPERATION_INCOMPLETE', `Operation ${operation.id} has no durable result`)
  return conversation
}

function workspaceForkReported(
  state: BraidState,
  run: BraidState['runs'][number] | undefined,
  execution: ExecutionPort | undefined,
  sourceEnvironmentId: string | undefined,
  confidentialRequested: boolean,
): boolean {
  if (sourceEnvironmentId === undefined || run?.environmentId !== sourceEnvironmentId) return false
  const environment = state.environments.find((candidate) => candidate.id === sourceEnvironmentId)
  if (environment?.providerEnvironmentId === undefined) return false
  if (run?.controlRef?.environmentId !== environment.providerEnvironmentId) return false
  const branching = run?.capabilities.environment?.branching
  const supported = Boolean(
    hasWorkspaceBranchingMethods(execution) &&
      branching?.checkpoint &&
      branching.fork &&
      branching.retrySafe &&
      branching.lookup &&
      branching.cleanup,
  )
  if (!supported) return false
  return (
    !confidentialRequested ||
    (run?.capabilities.environment?.confidential === true &&
      typeof execution?.confidentialAttestationVerifier === 'function')
  )
}

function sourceRunForBranch(
  state: BraidState,
  branchId: BranchRecord['id'],
  preferredRunId: MessageRecord['runId'],
): BraidState['runs'][number] | undefined {
  if (preferredRunId !== undefined) {
    const preferred = state.runs.find(
      (candidate) => candidate.id === preferredRunId && candidate.branchId === branchId,
    )
    if (preferred !== undefined) return preferred
  }
  return state.runs.filter((candidate) => candidate.branchId === branchId).at(-1)
}

function contextTransferPort(
  execution: ExecutionPort | undefined,
): NonNullable<ExecutionPort['context']> | undefined {
  return execution?.context ?? execution?.contextTransfer
}

function hasWorkspaceBranchingMethods(execution: ExecutionPort | undefined): boolean {
  const branching = execution?.workspaceBranching
  if (typeof execution?.workspaceBranchingProvider?.forEnvironment === 'function') return true
  return Boolean(
    branching !== undefined &&
      typeof branching.checkpoint === 'function' &&
      typeof branching.lookupCheckpoint === 'function' &&
      typeof branching.deleteCheckpoint === 'function' &&
      typeof branching.fork === 'function' &&
      typeof branching.lookupFork === 'function' &&
      typeof branching.destroyFork === 'function',
  )
}

export type { BranchId, ConversationId }
