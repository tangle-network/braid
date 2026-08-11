import { resolve } from 'node:path'
import { readNoFollow, writePrivateFile } from '../adapters/persistence/safe-file.js'
import { canonicalDigest, canonicalJson } from '../domain/canonical.js'
import type { ConversationRecord, MessageRecord } from '../domain/entities.js'
import { parseConversationId } from '../domain/ids.js'
import {
  redactStructuredValue,
  redactStructuredValueWithNumericTelemetry,
} from '../domain/redaction.js'
import type { BraidState } from '../domain/state.js'
import { messagesVisibleOnBranch } from './conversation-context.js'
import {
  acknowledgedOperation,
  coordinateConversationOperation,
  operationReplay,
  parseOperation,
  requestDigest,
} from './conversation-support.js'
import type { ConversationHost } from './conversation-types.js'
import { AppError } from './errors.js'

export const MAX_CONVERSATION_DOCUMENT_BYTES = 2 * 1024 * 1024
export const MAX_CONVERSATION_DOCUMENT_ITEMS = 100_000

export interface ConversationExportDocument {
  readonly schemaVersion: 2
  readonly format: 'braid-conversation'
  readonly exportedAt: string
  readonly conversationId: string
  readonly content: Readonly<Record<string, unknown>>
  readonly contentDigest: string
  readonly redacted: true
  readonly externalControlsDisabled: true
}

export interface ExportConversationInput {
  readonly operationId: string
  readonly conversationId?: string
  readonly format?: 'json' | 'markdown'
  readonly destination?: string
}

export interface ExportConversationResult {
  readonly format: 'json' | 'markdown'
  readonly conversationId: string
  readonly contentDigest: string
  readonly bytes: number
  readonly content?: string
  readonly destination?: string
  readonly replayed: boolean
}

export class ConversationExports {
  readonly #host: ConversationHost

  constructor(host: ConversationHost) {
    this.#host = host
  }

  async export(input: ExportConversationInput): Promise<ExportConversationResult> {
    return coordinateConversationOperation(this.#host, 'export', input, () => this.#export(input))
  }

  async #export(input: ExportConversationInput): Promise<ExportConversationResult> {
    const state = this.#host.state()
    const conversation = selectConversation(state, input.conversationId)
    const format = input.format ?? 'json'
    const document = conversationDocument(state, conversation, this.#host.now())
    const content =
      format === 'json' ? canonicalJson(document) : conversationMarkdown(state, document)
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_CONVERSATION_DOCUMENT_BYTES) {
      throw new AppError('EXPORT_TOO_LARGE', 'Conversation export exceeds 2 MiB')
    }
    const destination = input.destination === undefined ? undefined : resolve(input.destination)
    const operationId = parseOperation(input.operationId, 'export')
    const digest = requestDigest('export', {
      conversationId: conversation.id,
      format,
      contentDigest: document.contentDigest,
      destination: destination ?? null,
    })
    const replay = operationReplay(state, operationId, 'export', digest)
    if (replay) {
      if (destination !== undefined) assertExistingExport(destination, content)
      return resultForExport(
        format,
        conversation.id,
        document.contentDigest,
        bytes,
        content,
        destination,
        true,
      )
    }
    if (destination !== undefined) writePrivateFile(destination, `${content}\n`)
    const at = this.#host.now()
    await this.#host.commit({
      kind: 'operation.updated',
      operation: acknowledgedOperation({
        id: operationId,
        kind: 'export',
        digest,
        at,
        target: { kind: 'conversation', id: conversation.id },
      }),
    })
    return resultForExport(
      format,
      conversation.id,
      document.contentDigest,
      bytes,
      content,
      destination,
      false,
    )
  }
}

function selectConversation(state: BraidState, value: string | undefined): ConversationRecord {
  const id = parseConversationId(value ?? state.conversationId)
  const conversation = state.conversations.find(
    (candidate) => candidate.id === id && candidate.deletedAt === undefined,
  )
  if (!conversation) throw new AppError('UNKNOWN_CONVERSATION', `Conversation ${id} is unavailable`)
  return conversation
}

function conversationDocument(
  state: BraidState,
  conversation: ConversationRecord,
  exportedAt: string,
): ConversationExportDocument {
  const branches = state.branches.filter((branch) => branch.conversationId === conversation.id)
  const branchIds = new Set(branches.map((branch) => branch.id))
  const messages = uniqueMessages(
    branches.flatMap((branch) => messagesVisibleOnBranch(state, branch.id)),
  )
  const messageIds = new Set(messages.map((message) => message.id))
  const turns = state.turns.filter(
    (turn) => turn.conversationId === conversation.id || branchIds.has(turn.branchId),
  )
  const runIds = new Set(turns.flatMap((turn) => turn.runIds))
  const runs = state.runs.filter((run) => runIds.has(run.id))
  const analyses = state.analyses.filter(
    (analysis) => analysis.source.conversationId === conversation.id,
  )
  const analysisIds = new Set(analyses.map((analysis) => analysis.id))
  const nodeIds = new Set(
    state.graphNodes
      .filter((node) =>
        node.reference.kind === 'conversation'
          ? node.reference.id === conversation.id
          : node.reference.kind === 'branch'
            ? branchIds.has(node.reference.id)
            : node.reference.kind === 'message'
              ? messageIds.has(node.reference.id)
              : node.reference.kind === 'turn'
                ? turns.some((turn) => turn.id === node.reference.id)
                : node.reference.kind === 'run'
                  ? runIds.has(node.reference.id)
                  : node.reference.kind === 'analysis'
                    ? analysisIds.has(node.reference.id)
                    : false,
      )
      .map((node) => node.id),
  )
  const content = redactStructuredValueWithNumericTelemetry(
    {
      conversation,
      branches,
      messages,
      messageParts: state.messageParts.filter((part) => messageIds.has(part.messageId)),
      turns,
      runs,
      analyses,
      graphNodes: state.graphNodes.filter((node) => nodeIds.has(node.id)),
      graphEdges: state.graphEdges.filter(
        (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.destination),
      ),
      feedbackDecisions: state.feedbackDecisions.filter(
        (decision) => decision.conversationId === conversation.id,
      ),
    },
    undefined,
    {
      maxDepth: 24,
      maxItems: MAX_CONVERSATION_DOCUMENT_ITEMS,
      maxBytes: MAX_CONVERSATION_DOCUMENT_BYTES,
    },
  ) as Readonly<Record<string, unknown>>
  return {
    schemaVersion: 2,
    format: 'braid-conversation',
    exportedAt,
    conversationId: conversation.id,
    content,
    contentDigest: canonicalDigest(content),
    redacted: true,
    externalControlsDisabled: true,
  }
}

function conversationMarkdown(state: BraidState, document: ConversationExportDocument): string {
  const content = document.content as { readonly conversation?: ConversationRecord }
  const conversation = content.conversation
  const source = selectConversation(state, document.conversationId)
  const branch = state.branches.find((candidate) => candidate.id === source.activeBranchId)
  const messages = branch ? messagesVisibleOnBranch(state, branch.id) : []
  const lines = [
    `# ${conversation?.title ?? 'Braid conversation'}`,
    '',
    `<!-- braid-content-digest: ${document.contentDigest} -->`,
    `<!-- braid-conversation: ${document.conversationId} -->`,
    '',
  ]
  for (const message of messages) {
    const text = redactStructuredValue(message.text) as string
    lines.push(`## ${message.role}`, '', text || '[non-text message]', '')
  }
  return lines.join('\n')
}

function uniqueMessages(messages: readonly MessageRecord[]): readonly MessageRecord[] {
  const seen = new Set<string>()
  return messages.filter((message) => {
    if (seen.has(message.id)) return false
    seen.add(message.id)
    return true
  })
}

function resultForExport(
  format: 'json' | 'markdown',
  conversationId: string,
  contentDigest: string,
  bytes: number,
  content: string,
  destination: string | undefined,
  replayed: boolean,
): ExportConversationResult {
  return {
    format,
    conversationId,
    contentDigest,
    bytes,
    ...(destination === undefined ? { content } : { destination }),
    replayed,
  }
}

function assertExistingExport(path: string, expected: string): void {
  const existing = readNoFollow(path, MAX_CONVERSATION_DOCUMENT_BYTES + 1)
  if (existing === undefined) {
    throw new AppError('EXPORT_REPLAY_MISSING', 'The previously exported file is missing')
  }
  if (existing.toString('utf8').replace(/\n$/u, '') !== expected) {
    throw new AppError('EXPORT_REPLAY_CONFLICT', 'The export destination contains different data')
  }
}
