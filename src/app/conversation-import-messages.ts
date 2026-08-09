import type { MessagePartRecord, MessageRecord, TurnRecord } from '../domain/entities.js'
import type { ConversationId } from '../domain/ids.js'
import type { RuntimeMessagePart } from '../domain/runtime-projection.js'
import type { ConversationImportIds } from './conversation-import-values.js'
import {
  booleanValue,
  canonicalDateTime,
  exactString,
  finiteInteger,
  importRecord,
  oneOf,
  optionalString,
  requiredString,
  stringValue,
} from './conversation-import-values.js'
import { AppError } from './errors.js'

const MESSAGE_STATUSES = [
  'incomplete',
  'streaming',
  'complete',
  'failed',
  'aborted',
  'cancelled',
  'blocked',
  'expired',
  'unknown',
  'redacted',
] as const
const TURN_STATUSES = [
  'queued',
  'prepared',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'unknown',
] as const
const TERMINAL_MESSAGE_STATUSES = new Set([
  'complete',
  'failed',
  'aborted',
  'cancelled',
  'blocked',
  'expired',
  'unknown',
  'redacted',
])
const TERMINAL_TURN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'unknown'])
const RUNTIME_PART_KINDS = [
  'text',
  'reasoning',
  'tool-call',
  'tool-result',
  'artifact',
  'proposal',
  'warning',
  'error',
  'interaction',
  'system',
  'unknown',
] as const

export interface ImportedConversationMessages {
  readonly messages: readonly MessageRecord[]
  readonly messageParts: readonly MessagePartRecord[]
  readonly turns: readonly TurnRecord[]
}

export function importConversationMessages(input: {
  readonly ids: ConversationImportIds
  readonly sourceConversationId: string
  readonly conversationId: ConversationId
  readonly messages: readonly Record<string, unknown>[]
  readonly messageParts: readonly Record<string, unknown>[]
  readonly turns: readonly Record<string, unknown>[]
}): ImportedConversationMessages {
  const messageParts = input.messageParts.map((record, index) =>
    importMessagePart(input.ids, record, `messageParts[${index}]`),
  )
  const partsByMessage = new Map<string, MessagePartRecord[]>()
  for (const part of messageParts) {
    const parts = partsByMessage.get(part.messageId) ?? []
    parts.push(part)
    partsByMessage.set(part.messageId, parts)
  }
  const messages = input.messages.map((record, index) => {
    const label = `messages[${index}]`
    const id = input.ids.id('message', record.id, `${label}.id`)
    exactString(record.conversationId, input.sourceConversationId, `${label}.conversationId`)
    const sourceStatus = oneOf(record.status, MESSAGE_STATUSES, `${label}.status`)
    const complete = booleanValue(record.complete, `${label}.complete`)
    const status = TERMINAL_MESSAGE_STATUSES.has(sourceStatus) ? sourceStatus : 'unknown'
    const turnId =
      record.turnId === undefined
        ? undefined
        : input.ids.id('turn', record.turnId, `${label}.turnId`)
    const runId =
      record.runId === undefined ? undefined : input.ids.id('run', record.runId, `${label}.runId`)
    const storedParts = (partsByMessage.get(id) ?? []).sort(
      (left, right) => left.ordinal - right.ordinal,
    )
    const declaredPartIds = stringArray(record.partIds, `${label}.partIds`).map((partId) =>
      input.ids.id('messagePart', partId, `${label}.partIds`),
    )
    const actualPartIds = storedParts.map((part) => part.id)
    if (!sameStringSet(declaredPartIds, actualPartIds)) {
      throw new AppError('IMPORT_INVALID', `${label}.partIds do not match imported message parts`)
    }
    return {
      id,
      conversationId: input.conversationId,
      branchId: input.ids.id('branch', record.branchId, `${label}.branchId`),
      role: oneOf(record.role, ['user', 'assistant'] as const, `${label}.role`),
      text: stringValue(record.text, `${label}.text`),
      partIds: declaredPartIds,
      parts: importRuntimeMessageParts(input.ids, record.parts, `${label}.parts`),
      ...(record.partsTruncated === undefined
        ? {}
        : { partsTruncated: booleanValue(record.partsTruncated, `${label}.partsTruncated`) }),
      status,
      ...(turnId === undefined ? {} : { turnId }),
      ...(runId === undefined ? {} : { runId }),
      createdAt: requiredString(record.createdAt, `${label}.createdAt`),
      updatedAt: requiredString(record.updatedAt, `${label}.updatedAt`),
      complete: complete && TERMINAL_MESSAGE_STATUSES.has(status),
      ...optionalField(
        'missingHistory',
        optionalMissingHistory(input.ids, record.missingHistory, `${label}.missingHistory`),
      ),
    } satisfies MessageRecord
  })
  const messageIds = new Set(messages.map((message) => message.id))
  const orphan = messageParts.find((part) => !messageIds.has(part.messageId))
  if (orphan) throw new AppError('IMPORT_INVALID', `Message part ${orphan.id} has no message`)
  const turns = input.turns.map((record, index) => {
    const label = `turns[${index}]`
    exactString(record.conversationId, input.sourceConversationId, `${label}.conversationId`)
    const sourceStatus = oneOf(record.status, TURN_STATUSES, `${label}.status`)
    const runIds = stringArray(record.runIds, `${label}.runIds`).map((runId) =>
      input.ids.id('run', runId, `${label}.runIds`),
    )
    const selectedRunId =
      record.selectedRunId === undefined
        ? undefined
        : input.ids.id('run', record.selectedRunId, `${label}.selectedRunId`)
    return {
      id: input.ids.id('turn', record.id, `${label}.id`),
      conversationId: input.conversationId,
      branchId: input.ids.id('branch', record.branchId, `${label}.branchId`),
      userMessageId: input.ids.id('message', record.userMessageId, `${label}.userMessageId`),
      runIds,
      ...(selectedRunId === undefined ? {} : { selectedRunId }),
      status: TERMINAL_TURN_STATUSES.has(sourceStatus) ? sourceStatus : 'unknown',
      createdAt: requiredString(record.createdAt, `${label}.createdAt`),
      updatedAt: requiredString(record.updatedAt, `${label}.updatedAt`),
    } satisfies TurnRecord
  })
  return { messages, messageParts, turns }
}

function importMessagePart(
  ids: ConversationImportIds,
  record: Readonly<Record<string, unknown>>,
  label: string,
): MessagePartRecord {
  const base = {
    id: ids.id('messagePart', record.id, `${label}.id`),
    messageId: ids.id('message', record.messageId, `${label}.messageId`),
    ordinal: finiteInteger(record.ordinal, `${label}.ordinal`),
    createdAt: requiredString(record.createdAt, `${label}.createdAt`),
    updatedAt: requiredString(record.updatedAt, `${label}.updatedAt`),
  }
  const kind = requiredString(record.kind, `${label}.kind`)
  switch (kind) {
    case 'text':
    case 'reasoning':
      return { ...base, kind, text: stringValue(record.text, `${label}.text`) }
    case 'tool-call':
      return {
        ...base,
        kind,
        name: requiredString(record.name, `${label}.name`),
        arguments: importRecord(record.arguments, `${label}.arguments`) as never,
        ...optionalField('callId', optionalString(record.callId, `${label}.callId`)),
        status: oneOf(
          record.status,
          ['pending', 'running', 'completed', 'failed'] as const,
          `${label}.status`,
        ),
      }
    case 'tool-result':
      return {
        ...base,
        kind,
        ...optionalField('callId', optionalString(record.callId, `${label}.callId`)),
        summary: requiredString(record.summary, `${label}.summary`),
        ...(record.output === undefined ? {} : { output: record.output as never }),
        status: oneOf(record.status, ['completed', 'failed'] as const, `${label}.status`),
      }
    case 'artifact':
      return {
        ...base,
        kind,
        artifactId: ids.id('artifact', record.artifactId, `${label}.artifactId`),
        summary: requiredString(record.summary, `${label}.summary`),
      }
    case 'file': {
      const path = optionalString(record.path, `${label}.path`)
      const filename = optionalString(record.filename, `${label}.filename`)
      return {
        ...base,
        kind,
        ...optionalField('path', path),
        ...optionalField('filename', filename),
        ...optionalField('mediaType', optionalString(record.mediaType, `${label}.mediaType`)),
      }
    }
    case 'image':
      return {
        ...base,
        kind,
        ...(record.artifactId === undefined
          ? {}
          : { artifactId: ids.id('artifact', record.artifactId, `${label}.artifactId`) }),
        ...optionalField('mediaType', optionalString(record.mediaType, `${label}.mediaType`)),
        ...optionalField('altText', optionalString(record.altText, `${label}.altText`)),
      }
    case 'warning':
      return { ...base, kind, message: requiredString(record.message, `${label}.message`) }
    case 'error':
      return {
        ...base,
        kind,
        message: requiredString(record.message, `${label}.message`),
        retryable: booleanValue(record.retryable, `${label}.retryable`),
      }
    case 'unknown':
      return {
        ...base,
        kind,
        namespace: requiredString(record.namespace, `${label}.namespace`),
        type: requiredString(record.type, `${label}.type`),
        summary: requiredString(record.summary, `${label}.summary`),
      }
    default:
      throw new AppError('IMPORT_INVALID', `${label}.kind is unsupported`)
  }
}

function importRuntimeMessageParts(
  ids: ConversationImportIds,
  value: unknown,
  label: string,
): readonly RuntimeMessagePart[] {
  if (!Array.isArray(value)) throw new AppError('IMPORT_INVALID', `${label} must be an array`)
  const imported = value.map((item, index) => {
    const partLabel = `${label}[${index}]`
    const part = importRecord(item, partLabel)
    const sourceId = requiredString(part.id, `${partLabel}.id`)
    const source = importRuntimePartSource(part.source, `${partLabel}.source`)
    const metadata =
      part.metadata === undefined ? undefined : importRecord(part.metadata, `${partLabel}.metadata`)
    return {
      id: ids.derived('messagePart', `${partLabel}:${sourceId}`),
      kind: oneOf(part.kind, RUNTIME_PART_KINDS, `${partLabel}.kind`),
      ...optionalField('text', optionalText(part.text, `${partLabel}.text`)),
      ...optionalField('status', optionalString(part.status, `${partLabel}.status`)),
      ...optionalField('toolName', optionalString(part.toolName, `${partLabel}.toolName`)),
      ...optionalField('callId', optionalString(part.callId, `${partLabel}.callId`)),
      ...(part.input === undefined ? {} : { input: part.input }),
      ...(part.result === undefined ? {} : { result: part.result }),
      ...optionalField('error', optionalText(part.error, `${partLabel}.error`)),
      ...(part.artifactId === undefined
        ? {}
        : {
            artifactId: ids.derived(
              'artifact',
              `${partLabel}:${requiredString(part.artifactId, `${partLabel}.artifactId`)}`,
            ),
          }),
      ...optionalField('uri', optionalString(part.uri, `${partLabel}.uri`)),
      ...optionalField('mimeType', optionalString(part.mimeType, `${partLabel}.mimeType`)),
      ...optionalField('title', optionalString(part.title, `${partLabel}.title`)),
      ...optionalField('metadata', metadata),
      ...optionalField('source', source),
    } satisfies RuntimeMessagePart
  })
  const idsSeen = new Set<string>()
  for (const part of imported) {
    if (idsSeen.has(part.id)) {
      throw new AppError('IMPORT_INVALID', `${label} contains duplicate runtime part IDs`)
    }
    idsSeen.add(part.id)
  }
  return imported
}

function importRuntimePartSource(value: unknown, label: string) {
  if (value === undefined) return undefined
  const source = importRecord(value, label)
  return {
    ...optionalField('eventId', optionalString(source.eventId, `${label}.eventId`)),
    ...(source.sequence === undefined
      ? {}
      : { sequence: finiteInteger(source.sequence, `${label}.sequence`) }),
    ...optionalField('cursor', optionalString(source.cursor, `${label}.cursor`)),
    ...(source.occurredAt === undefined
      ? {}
      : { occurredAt: canonicalDateTime(source.occurredAt, `${label}.occurredAt`) }),
  }
}

function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, label)
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new AppError('IMPORT_INVALID', `${label} must be a text array`)
  }
  return value
}

function optionalField<K extends string, T>(key: K, value: T | undefined): { [P in K]?: T } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: T })
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value))
}

function optionalMissingHistory(ids: ConversationImportIds, value: unknown, label: string) {
  if (value === undefined) return undefined
  const range = importRecord(value, label)
  const fromSequence = finiteInteger(range.fromSequence, `${label}.fromSequence`)
  const toSequence =
    range.toSequence === undefined
      ? undefined
      : finiteInteger(range.toSequence, `${label}.toSequence`)
  if (toSequence !== undefined && toSequence < fromSequence) {
    throw new AppError('IMPORT_INVALID', `${label}.toSequence must not precede fromSequence`)
  }
  return {
    runId: ids.id('run', range.runId, `${label}.runId`),
    fromSequence,
    ...optionalField('toSequence', toSequence),
    reason: oneOf(
      range.reason,
      ['gap', 'expired-cursor', 'provider-missing', 'replay-unsupported'] as const,
      `${label}.reason`,
    ),
  }
}
