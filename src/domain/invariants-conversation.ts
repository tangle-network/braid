import { harnessTypeSchema, reasoningEffortSchema } from '@tangle-network/agent-interface'
import type {
  BranchRecord,
  ConversationRecord,
  MessagePartRecord,
  MessageRecord,
  TurnRecord,
} from './entities.js'
import {
  assertDate,
  assertEntityId,
  assertJsonValue,
  assertMissingHistory,
  assertPublicReference,
  assertUniqueIds,
  fail,
  failUnsupported,
  finiteNonNegative,
  nonEmpty,
  objectValue,
} from './invariants-base.js'

export function assertConversationRecord(record: ConversationRecord): void {
  assertEntityId('conversation', record.id, 'conversation.id')
  assertEntityId('workspace', record.workspaceId, 'conversation.workspaceId')
  assertEntityId('branch', record.activeBranchId, 'conversation.activeBranchId')
  nonEmpty(record.title, 'conversation.title')
  if (record.profileId !== undefined)
    assertEntityId('profile', record.profileId, 'conversation.profileId')
  for (const [name, value] of Object.entries(record.retention)) {
    if (value !== undefined) finiteNonNegative(value, `conversation.retention.${name}`)
  }
  assertDate(record.createdAt, 'conversation.createdAt')
  assertDate(record.updatedAt, 'conversation.updatedAt')
  if (record.deletedAt !== undefined) assertDate(record.deletedAt, 'conversation.deletedAt')
}

export function assertBranchRecord(record: BranchRecord): void {
  assertEntityId('branch', record.id, 'branch.id')
  assertEntityId('conversation', record.conversationId, 'branch.conversationId')
  if (record.source !== undefined) {
    assertEntityId('conversation', record.source.conversationId, 'branch.source.conversationId')
    assertEntityId('branch', record.source.branchId, 'branch.source.branchId')
    if (record.source.throughMessageId !== undefined)
      assertEntityId('message', record.source.throughMessageId, 'branch.source.throughMessageId')
    if (record.source.throughTurnId !== undefined)
      assertEntityId('turn', record.source.throughTurnId, 'branch.source.throughTurnId')
  }
  if (record.profileId !== undefined)
    assertEntityId('profile', record.profileId, 'branch.profileId')
  if (record.profileSnapshotId !== undefined)
    assertEntityId('profileSnapshot', record.profileSnapshotId, 'branch.profileSnapshotId')
  if (record.connectionId !== undefined)
    assertEntityId('connection', record.connectionId, 'branch.connectionId')
  assertEntityId('draft', record.draftId, 'branch.draftId')
  assertEntityId('queue', record.queueId, 'branch.queueId')
  if (record.bindingId !== undefined)
    assertEntityId('binding', record.bindingId, 'branch.bindingId')
  if (record.environmentId !== undefined)
    assertEntityId('environment', record.environmentId, 'branch.environmentId')
  if (record.tipMessageId !== undefined)
    assertEntityId('message', record.tipMessageId, 'branch.tipMessageId')
  const overrides: unknown = record.overrides
  objectValue(overrides, 'branch.overrides')
  const overrideKeys = Object.keys(overrides)
  if (overrideKeys.some((key) => !['runner', 'model', 'effort', 'mode'].includes(key)))
    fail('branch.overrides contains an unsupported field')
  if (overrides.runner !== undefined && !harnessTypeSchema.safeParse(overrides.runner).success)
    fail('branch.overrides.runner is not supported')
  if (overrides.effort !== undefined && !reasoningEffortSchema.safeParse(overrides.effort).success)
    fail('branch.overrides.effort is not supported')
  if (overrides.model !== undefined) {
    if (typeof overrides.model !== 'string') fail('branch.overrides.model must be text')
    assertPublicReference(overrides.model, 'branch.overrides.model')
  }
  if (overrides.mode !== undefined) {
    if (typeof overrides.mode !== 'string') fail('branch.overrides.mode must be text')
    assertPublicReference(overrides.mode, 'branch.overrides.mode')
  }
  assertDate(record.createdAt, 'branch.createdAt')
  assertDate(record.updatedAt, 'branch.updatedAt')
}

export function assertTurnRecord(record: TurnRecord): void {
  assertEntityId('turn', record.id, 'turn.id')
  assertEntityId('conversation', record.conversationId, 'turn.conversationId')
  assertEntityId('branch', record.branchId, 'turn.branchId')
  assertEntityId('message', record.userMessageId, 'turn.userMessageId')
  record.runIds.forEach((id) => {
    assertEntityId('run', id, 'turn.runIds')
  })
  assertUniqueIds(record.runIds, 'turn.runIds')
  if (record.selectedRunId !== undefined)
    assertEntityId('run', record.selectedRunId, 'turn.selectedRunId')
  if (record.queueEntryId !== undefined)
    assertEntityId('queueEntry', record.queueEntryId, 'turn.queueEntryId')
  assertDate(record.createdAt, 'turn.createdAt')
  assertDate(record.updatedAt, 'turn.updatedAt')
}

export function assertMessageRecord(record: MessageRecord): void {
  assertEntityId('message', record.id, 'message.id')
  assertEntityId('conversation', record.conversationId, 'message.conversationId')
  assertEntityId('branch', record.branchId, 'message.branchId')
  record.partIds.forEach((id) => {
    assertEntityId('messagePart', id, 'message.partIds')
  })
  assertUniqueIds(record.partIds, 'message.partIds')
  if (record.turnId !== undefined) assertEntityId('turn', record.turnId, 'message.turnId')
  if (record.runId !== undefined) assertEntityId('run', record.runId, 'message.runId')
  if (typeof record.text !== 'string') fail('message.text must be text')
  if (
    record.complete &&
    ![
      'complete',
      'failed',
      'aborted',
      'cancelled',
      'blocked',
      'expired',
      'unknown',
      'redacted',
    ].includes(record.status)
  ) {
    fail('complete messages must have a terminal status')
  }
  assertDate(record.createdAt, 'message.createdAt')
  assertDate(record.updatedAt, 'message.updatedAt')
  if (record.missingHistory !== undefined) assertMissingHistory(record.missingHistory)
}

export function assertMessagePartRecord(record: MessagePartRecord): void {
  assertEntityId('messagePart', record.id, 'messagePart.id')
  assertEntityId('message', record.messageId, 'messagePart.messageId')
  finiteNonNegative(record.ordinal, 'messagePart.ordinal')
  assertDate(record.createdAt, 'messagePart.createdAt')
  assertDate(record.updatedAt, 'messagePart.updatedAt')
  switch (record.kind) {
    case 'text':
    case 'reasoning':
      if (typeof record.text !== 'string') fail(`messagePart.${record.kind}.text must be text`)
      return
    case 'tool-call':
      nonEmpty(record.name, 'messagePart.tool-call.name')
      assertJsonValue(record.arguments, 'messagePart.tool-call.arguments')
      return
    case 'tool-result':
      nonEmpty(record.summary, 'messagePart.tool-result.summary')
      if (record.output !== undefined)
        assertJsonValue(record.output, 'messagePart.tool-result.output')
      return
    case 'artifact':
      assertEntityId('artifact', record.artifactId, 'messagePart.artifact.artifactId')
      nonEmpty(record.summary, 'messagePart.artifact.summary')
      return
    case 'file':
      if (record.path === undefined && record.filename === undefined)
        fail('messagePart.file needs path or filename')
      return
    case 'image':
      if (record.artifactId !== undefined)
        assertEntityId('artifact', record.artifactId, 'messagePart.image.artifactId')
      return
    case 'warning':
    case 'error':
      nonEmpty(record.message, `messagePart.${record.kind}.message`)
      return
    case 'unknown':
      nonEmpty(record.namespace, 'messagePart.unknown.namespace')
      nonEmpty(record.type, 'messagePart.unknown.type')
      nonEmpty(record.summary, 'messagePart.unknown.summary')
      return
    default:
      failUnsupported(record, 'message part kind')
  }
}
