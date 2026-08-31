import type { AgentProfile, WorkspaceRequest } from '@tangle-network/agent-interface'
import type { EffectStoragePort, JournalPort } from '../ports/effect-storage.js'
import type { ExecutionPort } from '../ports/execution.js'
import type { IdSource } from '../ports/ids.js'
import type { StoragePort } from '../ports/storage.js'
import type { ApplicationJournal } from './application-support.js'
import type { SendReceipt } from './application-types.js'
import type { SerializedEffectCoordinator } from './effect-coordinator.js'
import type { IntelligenceActionsOptions } from './intelligence-actions.js'

export interface CancelInput {
  readonly operationId: string
  readonly runId?: string
  readonly reason?: string
}

export type CancelReceipt = Omit<SendReceipt, 'admission'> & { readonly replayed: boolean }

export interface BraidApplicationOptions {
  readonly profile: Readonly<AgentProfile>
  /** Provider-neutral remote workspace selected at startup. */
  readonly workspaceRequest?: Readonly<WorkspaceRequest>
  readonly execution: ExecutionPort
  readonly clock: import('../ports/clock.js').Clock
  readonly ids: IdSource
  readonly journal?: JournalPort | ApplicationJournal
  readonly effectStorage?: EffectStoragePort
  readonly effectCoordinator?: SerializedEffectCoordinator
  readonly conversationId?: import('../domain/ids.js').ConversationId
  readonly branchId?: import('../domain/ids.js').BranchId
  readonly cancelTimeoutMs?: number
  readonly interactionResponseTimeoutMs?: number
  readonly conversationStorage?: Pick<StoragePort, 'destroyConversation'>
  readonly intelligence?: IntelligenceActionsOptions
}
