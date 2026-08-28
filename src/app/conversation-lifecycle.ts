import type { ConversationRecord, OperationRecord } from '../domain/entities.js'
import { graphNode } from '../domain/graph-records.js'
import {
  type ConversationId,
  type OperationId,
  parseBranchId,
  parseConversationId,
} from '../domain/ids.js'
import type { BraidState } from '../domain/state.js'
import { conversationBundle } from './conversation-records.js'
import {
  acknowledgedOperation,
  coordinateConversationOperation,
  normalizedTitle,
  operationReplay,
  parseOperation,
  requestDigest,
  requireWorkspace,
  selectedConnection,
  selectedProfile,
  stableConversationIds,
} from './conversation-support.js'
import type {
  ConversationHost,
  ConversationListQuery,
  CreateConversationInput,
  OpenConversationInput,
  UpdateConversationInput,
} from './conversation-types.js'
import { AppError } from './errors.js'

export class ConversationLifecycle {
  readonly #host: ConversationHost

  constructor(host: ConversationHost) {
    this.#host = host
  }

  list(query: ConversationListQuery = {}): readonly ConversationRecord[] {
    const state = this.#host.state()
    const text = query.query?.trim().toLocaleLowerCase()
    return state.conversations.filter((conversation) => {
      if (conversation.deletedAt !== undefined) return false
      if (query.workspace !== undefined) {
        const workspace = state.workspaces.find((record) => record.id === conversation.workspaceId)
        if (workspace?.root !== query.workspace) return false
      }
      if (query.status === 'active' && conversation.archived) return false
      if (query.status === 'archived' && !conversation.archived) return false
      if (!text) return true
      if (conversation.id.toLocaleLowerCase().includes(text)) return true
      if (conversation.title.toLocaleLowerCase().includes(text)) return true
      return state.branches.some(
        (branch) =>
          branch.conversationId === conversation.id &&
          [branch.id, branch.overrides.runner, branch.overrides.model].some((value) =>
            value?.toLocaleLowerCase().includes(text),
          ),
      )
    })
  }

  async create(input: CreateConversationInput): Promise<ConversationRecord> {
    return coordinateConversationOperation(this.#host, 'new_conversation', input, () =>
      this.#create(input),
    )
  }

  async #create(input: CreateConversationInput): Promise<ConversationRecord> {
    const state = this.#host.state()
    const workspaceId = requireWorkspace(state)
    const title = normalizedTitle(input.title)
    const profileId = selectedProfile(state, input.profileId)
    const connectionId = selectedConnection(state, input.connectionId)
    const operationId = parseOperation(input.operationId, 'new_conversation')
    const digest = requestDigest('new_conversation', {
      title,
      profileId: profileId ?? null,
      connectionId: connectionId ?? null,
      workspaceId,
    })
    const replay = operationReplay(state, operationId, 'conversation-create', digest)
    if (replay) return conversationForOperation(state, replay)
    const ids = stableConversationIds(operationId, digest)
    const at = this.#host.now()
    const bundle = conversationBundle({
      workspaceId,
      ...ids,
      title,
      at,
      operationId,
      ...(profileId === undefined ? {} : { profileId }),
      ...(connectionId === undefined ? {} : { connectionId }),
    })
    const operation = acknowledgedOperation({
      id: operationId,
      kind: 'conversation-create',
      digest,
      at,
      target: { kind: 'conversation', id: bundle.conversation.id },
    })
    await this.#host.commit({ kind: 'conversation.created', ...bundle, operation })
    return bundle.conversation
  }

  async open(input: OpenConversationInput): Promise<ConversationRecord> {
    return coordinateConversationOperation(this.#host, 'open_conversation', input, () =>
      this.#open(input),
    )
  }

  async #open(input: OpenConversationInput): Promise<ConversationRecord> {
    const state = this.#host.state()
    const conversationId = parseConversationId(input.conversationId)
    const conversation = availableConversation(state, conversationId)
    const branchId =
      input.branchId === undefined ? conversation.activeBranchId : parseBranchId(input.branchId)
    const branch = state.branches.find(
      (candidate) => candidate.id === branchId && candidate.conversationId === conversationId,
    )
    if (!branch)
      throw new AppError(
        'UNKNOWN_BRANCH',
        `Branch ${branchId} does not belong to ${conversationId}`,
      )
    const operationId = parseOperation(input.operationId, 'open_conversation')
    const digest = requestDigest('open_conversation', { conversationId, branchId })
    const replay = operationReplay(state, operationId, 'conversation-open', digest)
    if (replay) return conversationForOperation(state, replay)
    const at = this.#host.now()
    const selected = { ...conversation, activeBranchId: branchId, updatedAt: at }
    await this.#host.commit({
      kind: 'conversation.selected',
      conversationId,
      branchId,
      conversation: selected,
      operation: acknowledgedOperation({
        id: operationId,
        kind: 'conversation-open',
        digest,
        at,
        target: { kind: 'conversation', id: conversationId },
      }),
    })
    return selected
  }

  async rename(
    input: UpdateConversationInput & { readonly title: string },
  ): Promise<ConversationRecord> {
    return coordinateConversationOperation(this.#host, 'rename_conversation', input, () =>
      this.#rename(input),
    )
  }

  async #rename(
    input: UpdateConversationInput & { readonly title: string },
  ): Promise<ConversationRecord> {
    const title = normalizedTitle(input.title)
    return this.#update(
      input,
      'conversation-update',
      'rename_conversation',
      { title },
      (conversation, at) => ({
        ...conversation,
        title,
        updatedAt: at,
      }),
    )
  }

  async archive(
    input: UpdateConversationInput & { readonly archived: boolean },
  ): Promise<ConversationRecord> {
    return coordinateConversationOperation(this.#host, 'archive_conversation', input, () =>
      this.#archive(input),
    )
  }

  async #archive(
    input: UpdateConversationInput & { readonly archived: boolean },
  ): Promise<ConversationRecord> {
    return this.#update(
      input,
      'conversation-archive',
      'archive_conversation',
      { archived: input.archived },
      (conversation, at) => ({
        ...conversation,
        archived: input.archived,
        updatedAt: at,
      }),
    )
  }

  async delete(input: UpdateConversationInput): Promise<ConversationRecord> {
    return coordinateConversationOperation(this.#host, 'delete_conversation', input, () =>
      this.#delete(input),
    )
  }

  async #delete(input: UpdateConversationInput): Promise<ConversationRecord> {
    const state = this.#host.state()
    const workspaceId = requireWorkspace(state)
    const conversationId = parseConversationId(input.conversationId)
    const operationId = parseOperation(input.operationId, 'delete_conversation')
    const digest = requestDigest('delete_conversation', { conversationId })
    const replay = operationReplay(state, operationId, 'conversation-delete', digest)
    if (replay) {
      const deleted = state.conversations.find((conversation) => conversation.id === conversationId)
      if (!deleted)
        throw new AppError('DELETE_INCOMPLETE', `Conversation ${conversationId} is unavailable`)
      if (replay.status === 'pending') await this.#finishDelete(operationId, digest, deleted)
      return deleted
    }
    const target = availableConversation(state, conversationId)
    deleteBlockers(state, conversationId)
    const at = this.#host.now()
    const tombstone: ConversationRecord = {
      ...target,
      title: 'Deleted conversation',
      archived: true,
      deletedAt: at,
      updatedAt: at,
      retention: {},
    }
    const current = state.conversations.find(
      (conversation) =>
        conversation.id === state.conversationId &&
        conversation.id !== conversationId &&
        conversation.deletedAt === undefined,
    )
    const fallback =
      current ??
      state.conversations.find(
        (conversation) =>
          conversation.id !== conversationId && conversation.deletedAt === undefined,
      )
    const replacementIds = stableConversationIds(operationId, digest, 'replacement')
    const replacement =
      fallback === undefined
        ? conversationBundle({
            workspaceId,
            ...replacementIds,
            title: 'New conversation',
            at,
            operationId,
            ...(state.selectedProfileId === null ? {} : { profileId: state.selectedProfileId }),
            ...(state.selectedConnectionId === null
              ? {}
              : { connectionId: state.selectedConnectionId }),
          })
        : undefined
    const selectedConversation = fallback ?? replacement?.conversation
    if (!selectedConversation)
      throw new AppError('DELETE_INCOMPLETE', 'No replacement conversation was created')
    const operation: OperationRecord = {
      id: operationId,
      kind: 'conversation-delete',
      requestDigest: digest,
      status: this.#host.destroy === undefined ? 'acknowledged' : 'pending',
      target: { kind: 'conversation', id: conversationId },
      createdAt: at,
      updatedAt: at,
      ...(this.#host.destroy === undefined ? { acknowledgedAt: at } : {}),
    }
    await this.#host.commit({
      kind: 'conversation.deleted',
      conversation: tombstone,
      selectedConversation,
      ...(replacement === undefined
        ? {
            graphNodes: [
              graphNode({ kind: 'conversation', id: conversationId }, at, 'Deleted conversation'),
            ],
          }
        : {
            replacementBranch: replacement.branch,
            replacementDraft: replacement.draft,
            replacementQueue: replacement.queue,
            graphNodes: [
              ...replacement.graphNodes,
              graphNode({ kind: 'conversation', id: conversationId }, at, 'Deleted conversation'),
            ],
            graphEdges: replacement.graphEdges,
          }),
      operation,
    })
    if (this.#host.destroy !== undefined) await this.#finishDelete(operationId, digest, tombstone)
    return tombstone
  }

  async reconcilePendingDeletes(): Promise<void> {
    if (this.#host.destroy === undefined) return
    const pending = this.#host
      .state()
      .operations.filter(
        (operation) => operation.kind === 'conversation-delete' && operation.status === 'pending',
      )
    for (const operation of pending) {
      if (operation.target?.kind !== 'conversation') {
        throw new AppError(
          'DELETE_INCOMPLETE',
          `Operation ${operation.id} has no conversation target`,
        )
      }
      const conversation = this.#host
        .state()
        .conversations.find((candidate) => candidate.id === operation.target?.id)
      if (conversation?.deletedAt === undefined) {
        throw new AppError('DELETE_INCOMPLETE', `Operation ${operation.id} has no tombstone`)
      }
      await this.#finishDelete(operation.id, operation.requestDigest, conversation)
    }
  }

  async #update(
    input: UpdateConversationInput,
    kind: 'conversation-update' | 'conversation-archive',
    command: string,
    request: Readonly<Record<string, unknown>>,
    update: (conversation: ConversationRecord, at: string) => ConversationRecord,
  ): Promise<ConversationRecord> {
    const state = this.#host.state()
    const conversationId = parseConversationId(input.conversationId)
    const current = availableConversation(state, conversationId)
    const operationId = parseOperation(input.operationId, command)
    const digest = requestDigest(command, { conversationId, ...request })
    const replay = operationReplay(state, operationId, kind, digest)
    if (replay) return conversationForOperation(state, replay)
    const proposed = update(current, this.#host.now())
    const at = proposed.updatedAt
    await this.#host.commit({
      kind: 'conversation.updated',
      conversation: proposed,
      operation: acknowledgedOperation({
        id: operationId,
        kind,
        digest,
        at,
        target: { kind: 'conversation', id: conversationId },
      }),
    })
    return proposed
  }

  async #finishDelete(
    operationId: OperationId,
    digest: ReturnType<typeof requestDigest>,
    conversation: ConversationRecord,
  ): Promise<void> {
    await this.#host.destroy?.({ conversationId: conversation.id, operationId })
    const at = this.#host.now()
    await this.#host.commit({
      kind: 'operation.updated',
      operation: acknowledgedOperation({
        id: operationId,
        kind: 'conversation-delete',
        digest,
        at,
        target: { kind: 'conversation', id: conversation.id },
      }),
    })
  }
}

function availableConversation(state: BraidState, id: ConversationId): ConversationRecord {
  const conversation = state.conversations.find((candidate) => candidate.id === id)
  if (!conversation || conversation.deletedAt !== undefined) {
    throw new AppError('UNKNOWN_CONVERSATION', `Conversation ${id} is not available`)
  }
  return conversation
}

function conversationForOperation(
  state: BraidState,
  operation: OperationRecord,
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
  if (!conversation) {
    throw new AppError('OPERATION_INCOMPLETE', `Operation ${operation.id} has no durable result`)
  }
  return conversation
}

function deleteBlockers(state: BraidState, conversationId: ConversationId): void {
  for (const run of state.runs.filter((candidate) => candidate.conversationId === conversationId)) {
    if (run.interactionsTruncated && run.pendingInteractionIds === undefined) {
      throw new AppError(
        'DELETE_BLOCKED',
        `Interaction history for run ${run.id} is truncated; pending state is not provable`,
      )
    }
    const pendingId =
      run.pendingInteractionIds?.[0] ??
      run.interactions.find((interaction) => interaction.status === 'pending')?.request.id
    if (pendingId !== undefined)
      throw new AppError('DELETE_BLOCKED', `Interaction ${pendingId} is still pending`)
  }
  const active = state.runs.find((run) => run.conversationId === conversationId && !run.complete)
  if (active) throw new AppError('DELETE_BLOCKED', `Run ${active.id} is not terminal`)
  const descendant = state.branches.find(
    (branch) =>
      branch.conversationId !== conversationId && branch.source?.conversationId === conversationId,
  )
  if (descendant) {
    throw new AppError(
      'DELETE_BLOCKED',
      `Branch ${descendant.id} still references this conversation`,
    )
  }
}
