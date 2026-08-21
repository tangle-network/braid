import { canonicalDigest } from '../../domain/canonical.js'
import { credentialRef } from '../../ports/credentials.js'
import type {
  ConversationId,
  DestructionReport,
  EventId,
  NonTerminalRun,
  OperationIntent,
  RedactionReport,
  RetentionReport,
  StorageArtifacts,
} from '../../ports/storage.js'
import { missing, projectionOf } from './memory-base.js'
import { MemoryMaintenanceStorage } from './memory-maintenance.js'
import { payloadChecksum, tombstone } from './sqlite-crypto.js'
import { StorageError } from './sqlite-errors.js'
import { assertOperationRequestDigest } from './storage-validation.js'

export class MemoryRetentionStorage extends MemoryMaintenanceStorage {
  async applyRetention(input: {
    readonly before: string
    readonly conversationId?: ConversationId
    readonly operation: OperationIntent
  }): Promise<RetentionReport> {
    this.assertOpen()
    assertOperationRequestDigest(input.operation, {
      before: input.before,
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    })
    const replay = await this.reuseMutation<RetentionReport>(input.operation)
    if (replay !== undefined) return replay
    let redactedEvents = 0
    for (let index = 0; index < this.eventStore.length; index += 1) {
      const event = this.eventStore[index]
      if (
        event &&
        !event.redacted &&
        event.receivedAt < input.before &&
        (input.conversationId === undefined || event.conversationId === input.conversationId) &&
        this.cursorStore.get(event.runId)?.terminal
      ) {
        this.eventStore[index] = {
          ...event,
          payload: tombstone('retention'),
          payloadChecksum: payloadChecksum(tombstone('retention')),
          payloadState: 'redacted',
          redacted: true,
        }
        redactedEvents += 1
      }
    }
    this.projectionState = projectionOf(this.eventStore, [...this.cursorStore.values()])
    const result = { redactedEvents, deletedConversations: [] as ConversationId[] }
    await this.completeMutation(input.operation, 'terminal', result)
    return result
  }

  async redact(input: {
    readonly conversationId: ConversationId
    readonly eventId: EventId
    readonly reason: string
    readonly operation: OperationIntent
  }): Promise<RedactionReport> {
    this.assertOpen()
    assertOperationRequestDigest(input.operation, {
      conversationId: input.conversationId,
      eventId: input.eventId,
      reasonDigest: canonicalDigest(input.reason),
    })
    const replay = await this.reuseMutation<RedactionReport>(input.operation)
    if (replay !== undefined) return replay
    let rewrittenEvents = 0
    const target = this.eventStore.find(
      (event) => event.conversationId === input.conversationId && event.eventId === input.eventId,
    )
    if (target === undefined) {
      const error = new StorageError('EVENT_NOT_FOUND', `Event ${input.eventId} was not found`)
      await this.completeMutationFailure(input.operation, error)
      throw error
    }
    for (let index = 0; index < this.eventStore.length; index += 1) {
      const event = this.eventStore[index]
      if (event?.conversationId !== input.conversationId) continue
      const redacted = event.eventId === input.eventId
      this.eventStore[index] = {
        ...event,
        ...(redacted
          ? {
              payload: tombstone(input.reason),
              payloadChecksum: payloadChecksum(tombstone(input.reason)),
            }
          : {}),
        ...(redacted ? { payloadState: 'redacted' as const, redacted: true } : {}),
      }
      rewrittenEvents += 1
    }
    this.projectionState = projectionOf(this.eventStore, [...this.cursorStore.values()])
    const result = {
      conversationId: input.conversationId,
      redactedEventId: input.eventId,
      rewrittenEvents,
      newContentKeyRef: credentialRef(`cred:v1:memory-redacted-${input.conversationId}`),
    }
    await this.completeMutation(input.operation, 'terminal', result)
    return result
  }

  async destroyConversation(input: {
    readonly conversationId: ConversationId
    readonly reason: string
    readonly operation: OperationIntent
  }): Promise<DestructionReport> {
    this.assertOpen()
    assertOperationRequestDigest(input.operation, {
      conversationId: input.conversationId,
      reasonDigest: canonicalDigest(input.reason),
    })
    const replay = await this.reuseMutation<DestructionReport>(input.operation)
    if (replay !== undefined) return replay
    const hasEvents = this.eventStore.some((event) => event.conversationId === input.conversationId)
    if (!hasEvents) {
      await this.completeMutation(input.operation, 'failed', { code: 'CONVERSATION_NOT_FOUND' })
      throw new StorageError(
        'CONVERSATION_NOT_FOUND',
        `Conversation ${input.conversationId} was not found`,
      )
    }
    for (let index = 0; index < this.eventStore.length; index += 1) {
      const event = this.eventStore[index]
      if (event?.conversationId === input.conversationId) {
        this.eventStore[index] = {
          ...event,
          payload: tombstone(input.reason),
          payloadChecksum: payloadChecksum(tombstone(input.reason)),
          payloadState: 'deleted',
          redacted: true,
          tombstoneReason: canonicalDigest(input.reason),
        }
      }
    }
    this.projectionState = projectionOf(this.eventStore, [...this.cursorStore.values()])
    const result = {
      conversationId: input.conversationId,
      destroyed: true,
      retainedCiphertext: true,
    }
    await this.completeMutation(input.operation, 'terminal', result)
    return result
  }

  async compact(operation: OperationIntent): Promise<void> {
    this.assertOpen()
    assertOperationRequestDigest(operation, {})
    const replay = await this.reuseMutation<{ readonly completed: true }>(operation)
    if (replay !== undefined) return
    await this.completeMutation(operation, 'terminal', { completed: true })
  }

  artifacts(): StorageArtifacts {
    return { database: ':memory:', wal: ':memory:-wal', sharedMemory: ':memory:-shm', backups: [] }
  }

  async reconcileNonTerminalRuns(): Promise<readonly NonTerminalRun[]> {
    this.assertOpen()
    return [...this.cursorStore.values()]
      .filter((cursor) => !cursor.terminal)
      .map((cursor) => ({
        runId: cursor.runId,
        conversationId: cursor.conversationId,
        lastSequence: cursor.lastSequence,
        lastCursor: cursor.lastCursor,
        missingHistory: missing(cursor),
      }))
  }

  async close(): Promise<void> {
    this.isClosed = true
  }
}
