import type { HarnessType } from '@tangle-network/agent-interface'
import type {
  BranchRecord,
  ConversationRecord,
  DraftRecord,
  GraphEdgeRecord,
  GraphNodeRecord,
  OperationKind,
  OperationRecord,
  QueueRecord,
} from '../domain/entities.js'
import type { BraidEvent } from '../domain/events.js'
import type { PortableContextPlan } from '../domain/receipts.js'
import type { BraidState } from '../domain/state.js'

export interface ConversationHost {
  state(): BraidState
  now(): string
  commit(event: BraidEvent): Promise<void>
  destroy?(input: { readonly conversationId: string; readonly operationId: string }): Promise<void>
  coordinate?<T>(
    input: { readonly operationId: string; readonly digest: string },
    action: () => Promise<T>,
  ): Promise<T>
}

export interface CreateConversationInput {
  readonly operationId: string
  readonly title?: string
  readonly profileId?: string
  readonly connectionId?: string
}

export interface OpenConversationInput {
  readonly operationId: string
  readonly conversationId: string
  readonly branchId?: string
}

export interface UpdateConversationInput {
  readonly operationId: string
  readonly conversationId: string
}

export interface CreateBranchInput {
  readonly operationId: string
  readonly conversationId?: string
  readonly branchId?: string
  readonly throughMessageId?: string
  readonly text?: string
  readonly runner?: string
  readonly model?: string
  readonly effort?: string
}

export interface CloneConversationInput {
  readonly operationId: string
  readonly conversationId?: string
  readonly branchId?: string
  readonly title?: string
}

export interface PlanContextInput {
  readonly branchId?: string
  readonly throughMessageId?: string
  readonly destinationRunner?: HarnessType | string
}

export interface ForkPlanInput extends CreateBranchInput {
  readonly kind?: 'conversation' | 'workspace'
}

export interface ForkPlan {
  readonly kind: 'conversation' | 'workspace'
  readonly operationId: string
  readonly sourceConversationId: string
  readonly sourceBranchId: string
  readonly throughMessageId?: string
  readonly destinationBranchId: string
  readonly context: PortableContextPlan
  readonly environment: 'shared' | 'new' | 'unavailable'
  readonly providerSession: 'new'
  readonly checkpoint: 'none' | 'required' | 'unavailable'
  readonly allowed: boolean
  readonly reason?: string
  readonly digest: string
}

export interface ConversationListQuery {
  readonly query?: string
  readonly workspace?: string
  readonly status?: 'active' | 'archived' | 'all'
}

export interface BuiltConversation {
  readonly conversation: ConversationRecord
  readonly branch: BranchRecord
  readonly draft: DraftRecord
  readonly queue: QueueRecord
  readonly graphNodes: readonly GraphNodeRecord[]
  readonly graphEdges: readonly GraphEdgeRecord[]
}

export interface OperationInput {
  readonly operationId: string
  readonly kind: OperationKind
  readonly request: Readonly<Record<string, unknown>>
  readonly target?: OperationRecord['target']
}
