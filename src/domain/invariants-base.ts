import type { JsonValue } from './entities.js'
import type { IdKind } from './ids.js'
import { isDigestValue, isId, isReplayCursor } from './ids.js'
import { isCanonicalIsoDateTime } from './text.js'

export const OPERATION_KINDS = new Set([
  'profile-save',
  'connection-change',
  'conversation-create',
  'conversation-open',
  'conversation-update',
  'conversation-archive',
  'conversation-delete',
  'branch-create',
  'run-override',
  'conversation-clone',
  'conversation-fork',
  'context-plan',
  'conversation-import',
  'draft-update',
  'send',
  'queue',
  'interaction-response',
  'cancel-run',
  'steer-worker',
  'checkpoint',
  'fork-environment',
  'analysis',
  'promote-analysis',
  'export',
  'delete',
  'custom',
])

export const OPERATION_STATUSES = new Set([
  'pending',
  'acknowledged',
  'failed',
  'unknown',
  'conflict',
  'terminal',
])
const SECRET_NAME =
  /(secret|password|passphrase|token|bearer|authorization|credential|private(?:[_-]?key)?|api[-_]?key)\s*[:=]/iu

export function assertPublicReference(value: string, name: string): void {
  nonEmpty(value, name)
  if (SECRET_NAME.test(value) || /:\/\/[^/\s:@]+:[^/\s@]+@/u.test(value)) {
    fail(`${name} cannot contain credential material`)
  }
  try {
    const url = new URL(value)
    if (url.username || url.password) fail(`${name} cannot contain URL credentials`)
    for (const key of url.searchParams.keys()) {
      if (
        /(secret|password|passphrase|token|bearer|authorization|credential|private(?:[_-]?key)?|api[-_]?key)/iu.test(
          key,
        )
      ) {
        fail(`${name} cannot contain credential-bearing query parameters`)
      }
    }
  } catch (error) {
    if (error instanceof DomainInvariantError) throw error
    // Local paths and provider references need not be URLs.
  }
}

export class DomainInvariantError extends Error {
  readonly code = 'DOMAIN_INVARIANT'

  constructor(message: string) {
    super(message)
    this.name = 'DomainInvariantError'
  }
}

export function fail(message: string): never {
  throw new DomainInvariantError(message)
}

export function failUnsupported(value: never, name: string): never {
  void value
  return fail(`${name} is unsupported`)
}

export function nonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${name} must be non-empty`)
}

export function finiteNonNegative(value: unknown, name: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`${name} must be a finite non-negative number`)
  }
}

export function finiteRatio(value: unknown, name: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${name} must be a number between zero and one`)
  }
}

export function finitePositive(value: unknown, name: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(`${name} must be a finite positive number`)
  }
}

export function objectValue(
  value: unknown,
  name: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(`${name} must be an object`)
}

export function assertJsonValue(value: unknown, name = 'value'): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${name} must not contain a non-finite number`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertJsonValue(entry, `${name}[${index}]`)
    })
    return
  }
  objectValue(value, name)
  for (const [key, child] of Object.entries(value)) assertJsonValue(child, `${name}.${key}`)
}

export function assertEntityId(kind: IdKind, value: unknown, name: string): void {
  if (!isId(kind, value)) {
    fail(`${name} is not a valid ${kind} identifier`)
  }
}

export function assertDigest(value: unknown, name: string): void {
  if (!isDigestValue(value)) {
    fail(`${name} is not a SHA-256 digest`)
  }
}

export function assertDate(value: unknown, name: string): void {
  if (!isCanonicalIsoDateTime(value)) fail(`${name} is not a canonical ISO date`)
}

export function assertUniqueIds(values: readonly string[], name: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) fail(`${name} contains duplicate identifier ${value}`)
    seen.add(value)
  }
}

import type { BraidState } from './state.js'

export function assertFeedbackDecisionRecord(
  record: BraidState['feedbackDecisions'][number],
): void {
  assertEntityId('feedbackDecision', record.id, 'feedbackDecision.id')
  assertEntityId('conversation', record.conversationId, 'feedbackDecision.conversationId')
  if (record.operationId !== undefined)
    assertEntityId('operation', record.operationId, 'feedbackDecision.operationId')
  nonEmpty(record.chosenOption, 'feedbackDecision.chosenOption')
  assertDate(record.createdAt, 'feedbackDecision.createdAt')
}

export function assertReplayCursorRecord(record: BraidState['replayCursors'][number]): void {
  assertEntityId('run', record.runId, 'replayCursor.runId')
  if (!isReplayCursor(record.cursor)) fail('replayCursor.cursor is invalid')
  finiteNonNegative(record.committedSequence, 'replayCursor.committedSequence')
}

export function assertAppliedEventRecord(record: BraidState['appliedEvents'][number]): void {
  assertEntityId('event', record.id, 'appliedEvent.id')
  finitePositive(record.sequence, 'appliedEvent.sequence')
  finitePositive(record.revision, 'appliedEvent.revision')
  assertDigest(record.digest, 'appliedEvent.digest')
}

export function assertUnknownEventRecord(record: BraidState['unknownEvents'][number]): void {
  assertEntityId('event', record.id, 'unknownEvent.id')
  nonEmpty(record.type, 'unknownEvent.type')
  nonEmpty(record.summary, 'unknownEvent.summary')
  finitePositive(record.sequence, 'unknownEvent.sequence')
}

export function assertMissingHistory(range: {
  readonly runId: unknown
  readonly fromSequence: number
  readonly toSequence?: number
}): void {
  assertEntityId('run', range.runId, 'missingHistory.runId')
  finiteNonNegative(range.fromSequence, 'missingHistory.fromSequence')
  if (range.toSequence !== undefined) {
    finiteNonNegative(range.toSequence, 'missingHistory.toSequence')
    if (range.toSequence < range.fromSequence)
      fail('missingHistory.toSequence must not precede fromSequence')
  }
}
