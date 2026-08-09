import { canonicalJson } from '../domain/canonical.js'
import type {
  BranchRecord,
  ConversationRecord,
  DraftRecord,
  QueueRecord,
} from '../domain/entities.js'
import type { BraidEvent } from '../domain/events.js'
import type { Digest, OperationId } from '../domain/ids.js'
import { parseConversationId } from '../domain/ids.js'
import { assertBraidState, DomainInvariantError } from '../domain/invariants.js'
import { MAX_CONVERSATION_IMPORT_EVENT_BYTES } from '../domain/redaction.js'
import { applyConversationEvent } from '../domain/reducer-conversation-events.js'
import type { BraidState } from '../domain/state.js'
import type { PreparedConversationImport } from './conversation-import-document.js'
import { importConversationGraph } from './conversation-import-graph.js'
import { importConversationMessages } from './conversation-import-messages.js'
import { importConversationRuns } from './conversation-import-runs.js'
import {
  assertConversationImportIdsAvailable,
  assertConversationImportNavigable,
  assertConversationImportReferences,
} from './conversation-import-validation.js'
import {
  createConversationImportIds,
  exactString,
  importRecord,
  importRecords,
  oneOf,
  optionalFiniteNumber,
  requiredString,
} from './conversation-import-values.js'
import {
  acknowledgedOperation,
  normalizedTitle,
  requireIdle,
  requireWorkspace,
} from './conversation-support.js'
import { AppError } from './errors.js'

export type ConversationImportedEvent = Extract<
  BraidEvent,
  { readonly kind: 'conversation.imported' }
>

export function buildConversationImport(input: {
  readonly state: BraidState
  readonly prepared: PreparedConversationImport
  readonly operationId: OperationId
  readonly requestDigest: Digest
  readonly at: string
  readonly title?: string
}): ConversationImportedEvent {
  requireIdle(input.state, 'Conversation import')
  const workspaceId = requireWorkspace(input.state)
  const content = input.prepared.document.content
  const sourceConversation = importRecord(content.conversation, 'content.conversation')
  const sourceConversationId = parseSourceConversation(
    sourceConversation.id,
    input.prepared.document.conversationId,
  )
  if (sourceConversation.deletedAt !== undefined) {
    throw new AppError('IMPORT_INVALID', 'Deleted conversations cannot be imported')
  }
  const ids = createConversationImportIds(input.operationId, input.prepared.contentDigest)
  const conversationId = ids.id('conversation', sourceConversationId, 'content.conversation.id')
  const sourceBranches = importRecords(content.branches, 'branch', 'content.branches')
  if (sourceBranches.length === 0) {
    throw new AppError('IMPORT_INVALID', 'Conversation import contains no branches')
  }
  const branches = sourceBranches.map((record, index) =>
    importBranch(record, index, ids, sourceConversationId, conversationId),
  )
  const activeBranchId = ids.id(
    'branch',
    sourceConversation.activeBranchId,
    'content.conversation.activeBranchId',
  )
  const retention = importRecord(sourceConversation.retention, 'content.conversation.retention')
  const conversation: ConversationRecord = {
    id: conversationId,
    workspaceId,
    title: normalizedTitle(
      input.title,
      requiredString(sourceConversation.title, 'content.conversation.title'),
    ),
    activeBranchId,
    createdAt: requiredString(sourceConversation.createdAt, 'content.conversation.createdAt'),
    updatedAt: requiredString(sourceConversation.updatedAt, 'content.conversation.updatedAt'),
    archived: false,
    retention: {
      ...optionalField(
        'completedRunDays',
        optionalFiniteNumber(
          retention.completedRunDays,
          'content.conversation.retention.completedRunDays',
        ),
      ),
      ...optionalField(
        'traceDays',
        optionalFiniteNumber(retention.traceDays, 'content.conversation.retention.traceDays'),
      ),
      ...optionalField(
        'analysisDays',
        optionalFiniteNumber(retention.analysisDays, 'content.conversation.retention.analysisDays'),
      ),
      ...optionalField(
        'toolOutputBytes',
        optionalFiniteNumber(
          retention.toolOutputBytes,
          'content.conversation.retention.toolOutputBytes',
        ),
      ),
      ...optionalField(
        'cacheBytes',
        optionalFiniteNumber(retention.cacheBytes, 'content.conversation.retention.cacheBytes'),
      ),
    },
  }
  const drafts: DraftRecord[] = branches.map((branch) => ({
    id: branch.draftId,
    branchId: branch.id,
    text: '',
    updatedAt: input.at,
  }))
  const queues: QueueRecord[] = branches.map((branch) => ({
    id: branch.queueId,
    branchId: branch.id,
    entryIds: [],
    createdAt: input.at,
    updatedAt: input.at,
  }))
  const messages = importConversationMessages({
    ids,
    sourceConversationId,
    conversationId,
    messages: importRecords(content.messages, 'message', 'content.messages'),
    messageParts: importRecords(content.messageParts, 'messagePart', 'content.messageParts'),
    turns: importRecords(content.turns, 'turn', 'content.turns'),
  })
  const runs = importConversationRuns({
    ids,
    sourceConversationId,
    conversationId,
    operationId: input.operationId,
    fallbackProfile: input.state.profile,
    runs: importRecords(content.runs, 'run', 'content.runs'),
    analyses: importRecords(content.analyses, 'analysis', 'content.analyses'),
    feedbackDecisions: importRecords(
      content.feedbackDecisions,
      'feedbackDecision',
      'content.feedbackDecisions',
    ),
  })
  const graph = importConversationGraph({
    state: input.state,
    content,
    ids,
    workspaceId,
    conversation,
    branches,
    analyses: runs.analyses,
    sourceContentDigest: input.prepared.contentDigest,
    at: input.at,
  })
  const event: ConversationImportedEvent = {
    kind: 'conversation.imported',
    conversation,
    branches,
    drafts,
    queues,
    messages: messages.messages,
    messageParts: messages.messageParts,
    turns: messages.turns,
    runs: runs.runs,
    analyses: runs.analyses,
    graphNodes: graph.nodes,
    graphEdges: graph.edges,
    feedbackDecisions: runs.feedbackDecisions,
    sourceContentDigest: input.prepared.contentDigest,
    operation: acknowledgedOperation({
      id: input.operationId,
      kind: 'conversation-import',
      digest: input.requestDigest,
      at: input.at,
      target: { kind: 'conversation', id: conversation.id },
      result: {
        contentDigest: input.prepared.contentDigest,
        bytes: input.prepared.bytes,
      },
    }),
  }
  if (Buffer.byteLength(canonicalJson(event), 'utf8') > MAX_CONVERSATION_IMPORT_EVENT_BYTES) {
    throw new AppError('IMPORT_TOO_LARGE', 'Expanded conversation import exceeds 4 MiB')
  }
  assertConversationImportIdsAvailable(input.state, event)
  assertConversationImportReferences(event)
  try {
    const candidate = applyConversationEvent(input.state, event)
    assertConversationImportNavigable(candidate, event)
    assertBraidState(candidate)
  } catch (error) {
    if (error instanceof DomainInvariantError) {
      throw new AppError('IMPORT_INVALID', `Conversation import is inconsistent: ${error.message}`)
    }
    throw error
  }
  return event
}

function importBranch(
  record: Readonly<Record<string, unknown>>,
  index: number,
  ids: ReturnType<typeof createConversationImportIds>,
  sourceConversationId: string,
  conversationId: ConversationRecord['id'],
): BranchRecord {
  const label = `content.branches[${index}]`
  const sourceId = requiredString(record.id, `${label}.id`)
  exactString(record.conversationId, sourceConversationId, `${label}.conversationId`)
  const id = ids.id('branch', sourceId, `${label}.id`)
  const source =
    record.source === undefined ? undefined : importRecord(record.source, `${label}.source`)
  if (source !== undefined) {
    exactString(source.conversationId, sourceConversationId, `${label}.source.conversationId`)
  }
  return {
    id,
    conversationId,
    ...(source === undefined
      ? {}
      : {
          source: {
            conversationId,
            branchId: ids.id('branch', source.branchId, `${label}.source.branchId`),
            ...(source.throughMessageId === undefined
              ? {}
              : {
                  throughMessageId: ids.id(
                    'message',
                    source.throughMessageId,
                    `${label}.source.throughMessageId`,
                  ),
                }),
            ...(source.throughTurnId === undefined
              ? {}
              : {
                  throughTurnId: ids.id(
                    'turn',
                    source.throughTurnId,
                    `${label}.source.throughTurnId`,
                  ),
                }),
          },
        }),
    overrides: {},
    draftId: ids.derived('draft', `branch:${sourceId}`),
    queueId: ids.derived('queue', `branch:${sourceId}`),
    ...(record.tipMessageId === undefined
      ? {}
      : { tipMessageId: ids.id('message', record.tipMessageId, `${label}.tipMessageId`) }),
    status:
      oneOf(
        record.status,
        ['active', 'preparing', 'failed-preparation', 'archived'] as const,
        `${label}.status`,
      ) === 'archived'
        ? 'archived'
        : 'active',
    createdAt: requiredString(record.createdAt, `${label}.createdAt`),
    updatedAt: requiredString(record.updatedAt, `${label}.updatedAt`),
  }
}

function parseSourceConversation(value: unknown, documentId: string): string {
  let id: string
  try {
    id = parseConversationId(value)
  } catch {
    throw new AppError('IMPORT_INVALID', 'Conversation import identifier is invalid')
  }
  if (id !== documentId) {
    throw new AppError(
      'IMPORT_INVALID',
      'Conversation import identifier does not match its content',
    )
  }
  return id
}

function optionalField<K extends string, T>(key: K, value: T | undefined): { [P in K]?: T } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: T })
}
