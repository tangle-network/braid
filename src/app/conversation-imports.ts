import { resolve } from 'node:path'
import { canonicalDigest } from '../domain/canonical.js'
import type { ConversationRecord, OperationRecord } from '../domain/entities.js'
import type { Digest, OperationId } from '../domain/ids.js'
import { parseDigestValue } from '../domain/ids.js'
import type { BraidState } from '../domain/state.js'
import { MAX_CONVERSATION_DOCUMENT_BYTES } from './conversation-exports.js'
import { buildConversationImport } from './conversation-import-builder.js'
import {
  type ConversationImportSource,
  prepareConversationImport,
} from './conversation-import-document.js'
import {
  coordinateConversationOperation,
  normalizedTitle,
  operationReplay,
  parseOperation,
  requestDigest,
} from './conversation-support.js'
import type { ConversationHost } from './conversation-types.js'
import { AppError } from './errors.js'

export interface ImportConversationInput extends ConversationImportSource {
  readonly operationId: string
  readonly title?: string
}

export interface ImportConversationResult {
  readonly conversationId: string
  readonly contentDigest: Digest
  readonly bytes: number
  readonly branches: number
  readonly messages: number
  readonly runs: number
  readonly analyses: number
  readonly replayed: boolean
}

export class ConversationImports {
  readonly #host: ConversationHost

  constructor(host: ConversationHost) {
    this.#host = host
  }

  async import(input: ImportConversationInput): Promise<ImportConversationResult> {
    const operationId = parseOperation(input.operationId, 'import')
    const title = input.title === undefined ? undefined : normalizedTitle(input.title)
    const source = importRequestIdentity(input)
    const digest = requestDigest('conversation-import', {
      source,
      title: title ?? null,
    })
    const coordinationInput = {
      operationId: input.operationId,
      source,
      ...(title === undefined ? {} : { title }),
    }
    return coordinateConversationOperation(this.#host, 'import', coordinationInput, async () =>
      this.#commit(input, operationId, digest, title),
    )
  }

  async #commit(
    input: ConversationImportSource,
    operationId: OperationId,
    digest: Digest,
    title: string | undefined,
  ): Promise<ImportConversationResult> {
    const state = this.#host.state()
    const replay = operationReplay(state, operationId, 'conversation-import', digest)
    if (replay !== undefined) {
      if (replay.target?.kind !== 'conversation') {
        throw new AppError('IMPORT_REPLAY_INVALID', 'Conversation import replay has no target')
      }
      const metadata = importReplayMetadata(replay.result)
      return importResult(state, replay.target.id, metadata.contentDigest, metadata.bytes, true)
    }
    const prepared = prepareConversationImport(input)
    const event = buildConversationImport({
      state,
      prepared,
      operationId,
      requestDigest: digest,
      at: this.#host.now(),
      ...(title === undefined ? {} : { title }),
    })
    await this.#host.commit(event)
    return importResult(
      this.#host.state(),
      event.conversation.id,
      prepared.contentDigest,
      prepared.bytes,
      false,
    )
  }
}

function importRequestIdentity(
  input: ConversationImportSource,
): Readonly<{ inlineDigest: Digest } | { source: string }> {
  const hasContent = input.content !== undefined
  const hasSource = input.source !== undefined
  if (hasContent === hasSource) {
    throw new AppError(
      'IMPORT_SOURCE_REQUIRED',
      'Provide exactly one import content or source path',
    )
  }
  if (input.content !== undefined) {
    if (Buffer.byteLength(input.content, 'utf8') > MAX_CONVERSATION_DOCUMENT_BYTES) {
      throw new AppError('IMPORT_TOO_LARGE', 'Conversation import exceeds 2 MiB')
    }
    return { inlineDigest: canonicalDigest(input.content) }
  }
  const source = input.source?.trim()
  if (!source) {
    throw new AppError('IMPORT_SOURCE_REQUIRED', 'Conversation import source path is empty')
  }
  return { source: resolve(source) }
}

function importReplayMetadata(result: OperationRecord['result']): {
  readonly contentDigest: Digest
  readonly bytes: number
} {
  try {
    const contentDigest = parseDigestValue(result?.contentDigest)
    const bytes = result?.bytes
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error('invalid byte count')
    }
    return { contentDigest, bytes }
  } catch {
    throw new AppError('IMPORT_REPLAY_INVALID', 'Conversation import replay metadata is invalid')
  }
}

function importResult(
  state: BraidState,
  conversationId: ConversationRecord['id'],
  contentDigest: Digest,
  bytes: number,
  replayed: boolean,
): ImportConversationResult {
  const conversation = state.conversations.find((record) => record.id === conversationId)
  if (!conversation || conversation.deletedAt !== undefined) {
    throw new AppError('IMPORT_REPLAY_INVALID', 'Imported conversation is unavailable')
  }
  const branches = state.branches.filter((record) => record.conversationId === conversationId)
  const branchIds = new Set(branches.map((record) => record.id))
  const turns = state.turns.filter((record) => record.conversationId === conversationId)
  const runIds = new Set(turns.flatMap((record) => record.runIds))
  return {
    conversationId,
    contentDigest,
    bytes,
    branches: branches.length,
    messages: state.messages.filter((record) => record.conversationId === conversationId).length,
    runs: state.runs.filter((record) => runIds.has(record.id)).length,
    analyses: state.analyses.filter(
      (record) =>
        record.source.conversationId === conversationId && branchIds.has(record.source.branchId),
    ).length,
    replayed,
  }
}
