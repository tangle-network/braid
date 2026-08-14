import { canonicalDigest } from '../domain/canonical.js'
import type { BranchRecord, ConversationRecord, MessageRecord } from '../domain/entities.js'
import { graphEdge, graphNode } from '../domain/graph-records.js'
import {
  parseBranchId,
  parseConversationId,
  parseMessageId,
  type BranchId,
  type ConversationId,
  type OperationId,
} from '../domain/ids.js'
import type { BraidState } from '../domain/state.js'
import { messagesVisibleOnBranch, portablePlanForState } from './conversation-context.js'
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
  requireIdle,
  requireWorkspace,
  stableBranchIds,
  stableConversationIds,
} from './conversation-support.js'
import type {
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
    requireIdle(state, 'Changing run configuration')
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
    requireIdle(state, 'Creating a branch')
    const source = resolveSource(state, input)
    const operationId = parseOperation(input.operationId, 'branch')
    const normalized = branchRequest(source, input)
    const digest = requestDigest('branch', normalized)
    const replay = operationReplay(state, operationId, 'branch-create', digest)
    if (replay) return branchForOperation(state, replay)
    const ids = stableBranchIds(operationId, digest)
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
        ? {}
        : { environmentId: source.branch.environmentId }),
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
    requireIdle(state, 'Cloning a conversation')
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
    const kind = input.kind ?? 'conversation'
    const context = portablePlanForState(state, {
      branchId: source.branch.id,
      ...(source.through === undefined ? {} : { throughMessageId: source.through.id }),
      ...(input.runner === undefined ? {} : { destinationRunner: input.runner }),
    })
    const workspaceAvailable = workspaceForkReported(state, source.branch)
    const allowed = kind === 'conversation'
    const plan = {
      kind,
      operationId,
      sourceConversationId: source.conversation.id,
      sourceBranchId: source.branch.id,
      ...(source.through === undefined ? {} : { throughMessageId: source.through.id }),
      destinationBranchId,
      context,
      environment:
        kind === 'conversation'
          ? ('shared' as const)
          : workspaceAvailable
            ? ('new' as const)
            : ('unavailable' as const),
      providerSession: 'new' as const,
      checkpoint:
        kind === 'conversation'
          ? ('none' as const)
          : workspaceAvailable
            ? ('required' as const)
            : ('unavailable' as const),
      allowed,
      ...(allowed
        ? {}
        : {
            reason: workspaceAvailable
              ? 'The current runtime does not expose retry-safe environment fork execution to Braid'
              : 'The selected run does not report retry-safe checkpoint and environment fork support',
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
    const branch = await this.#create(input)
    if (branch.id !== plan.destinationBranchId) {
      throw new AppError('FORK_PLAN_CONFLICT', 'Fork execution produced an unexpected branch')
    }
    return branch
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

function branchRequest(source: ResolvedSource, input: CreateBranchInput) {
  return {
    conversationId: source.conversation.id,
    branchId: source.branch.id,
    throughMessageId: source.through?.id ?? null,
    text: input.text ?? '',
    runner: input.runner ?? source.branch.overrides.runner ?? null,
    model: input.model ?? source.branch.overrides.model ?? null,
    effort: input.effort ?? source.branch.overrides.effort ?? null,
    mode: input.mode ?? source.branch.overrides.mode ?? null,
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

function workspaceForkReported(state: BraidState, branch: BranchRecord): boolean {
  if (branch.environmentId === undefined) return false
  const run = state.runs.filter((candidate) => candidate.branchId === branch.id).at(-1)
  const branching = run?.capabilities.environment?.branching
  return Boolean(
    branching?.checkpoint &&
      branching.fork &&
      branching.retrySafe &&
      branching.lookup &&
      branching.cleanup,
  )
}

export type { BranchId, ConversationId }
