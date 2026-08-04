import type { DraftRecord } from '../domain/entities.js'
import { parseBranchId, parseConversationId } from '../domain/ids.js'
import { redactSensitiveText } from '../domain/redaction.js'
import {
  acknowledgedOperation,
  coordinateConversationOperation,
  operationReplay,
  parseOperation,
  requestDigest,
} from './conversation-support.js'
import type { ConversationHost } from './conversation-types.js'
import { AppError } from './errors.js'

const MAX_DRAFT_BYTES = 1024 * 1024

export interface SetConversationDraftInput {
  readonly operationId: string
  readonly text: string
  readonly conversationId?: string
  readonly branchId?: string
}

export interface SetConversationDraftResult {
  readonly draft: DraftRecord
  readonly replayed: boolean
}

export class ConversationDrafts {
  readonly #host: ConversationHost

  constructor(host: ConversationHost) {
    this.#host = host
  }

  async set(input: SetConversationDraftInput): Promise<SetConversationDraftResult> {
    return coordinateConversationOperation(this.#host, 'set-draft', input, () => this.#set(input))
  }

  async #set(input: SetConversationDraftInput): Promise<SetConversationDraftResult> {
    if (Buffer.byteLength(input.text, 'utf8') > MAX_DRAFT_BYTES) {
      throw new AppError('DRAFT_TOO_LARGE', 'Draft exceeds 1 MiB')
    }
    const state = this.#host.state()
    const conversationId = parseConversationId(input.conversationId ?? state.conversationId)
    const conversation = state.conversations.find(
      (candidate) => candidate.id === conversationId && candidate.deletedAt === undefined,
    )
    if (!conversation) {
      throw new AppError('UNKNOWN_CONVERSATION', `Conversation ${conversationId} is unavailable`)
    }
    const branchId = parseBranchId(input.branchId ?? conversation.activeBranchId)
    const branch = state.branches.find(
      (candidate) => candidate.id === branchId && candidate.conversationId === conversationId,
    )
    if (!branch) throw new AppError('UNKNOWN_BRANCH', `Branch ${branchId} is unavailable`)
    const existing = state.drafts.find((candidate) => candidate.id === branch.draftId)
    if (!existing) throw new AppError('DRAFT_MISSING', `Branch ${branchId} has no draft record`)

    const text = redactSensitiveText(input.text, MAX_DRAFT_BYTES)
    const operationId = parseOperation(input.operationId, 'set-draft')
    const digest = requestDigest('set-draft', { conversationId, branchId, text })
    const replay = operationReplay(state, operationId, 'draft-update', digest)
    if (replay) return { draft: existing, replayed: true }

    const at = this.#host.now()
    const draft: DraftRecord = { ...existing, text, updatedAt: at }
    await this.#host.commit({
      kind: 'draft.recorded',
      draft,
      operation: acknowledgedOperation({
        id: operationId,
        kind: 'draft-update',
        digest,
        at,
        target: { kind: 'branch', id: branchId },
      }),
    })
    return { draft, replayed: false }
  }
}
