import { isIP } from 'node:net'
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

/** Validate a public URL without resolving DNS names. */
export function assertPublicUrl(
  value: string,
  name: string,
  options: Readonly<{
    readonly protocols?: readonly string[]
    readonly rejectQuery?: boolean
    readonly rejectFragment?: boolean
    readonly rejectPrivateHost?: boolean
  }> = {},
): void {
  assertPublicReference(value, name)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    fail(`${name} must be a valid URL`)
  }
  const protocols = options.protocols ?? ['https:']
  if (!protocols.includes(url.protocol)) {
    fail(`${name} must use an allowed URL protocol`)
  }
  if (options.rejectQuery === true && url.search !== '') {
    fail(`${name} must not contain query data`)
  }
  if (options.rejectFragment === true && url.hash !== '') {
    fail(`${name} must not contain fragment data`)
  }
  if (options.rejectPrivateHost !== false && isPrivateHost(url.hostname)) {
    fail(`${name} must use a public hostname`)
  }
}

function isPrivateHost(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[/u, '')
    .replace(/\]$/u, '')
    .replace(/\.$/u, '')
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local')
  ) {
    return true
  }
  const version = isIP(normalized)
  if (version === 4) return isPrivateIpv4(normalized)
  if (version === 6) return isPrivateIpv6(normalized)
  return false
}

function isPrivateIpv4(value: string): boolean {
  const octets = value.split('.').map(Number)
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false
  }
  const first = octets[0] ?? -1
  const second = octets[1] ?? -1
  const third = octets[2] ?? -1
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 31 && third === 196) ||
    (first === 192 && second === 52 && third === 193) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 175 && third === 48) ||
    (first === 198 && second >= 18 && second <= 19) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  )
}

function isPrivateIpv6(value: string): boolean {
  const first = Number.parseInt(value.split(':')[0] || '0', 16)
  if (!Number.isFinite(first)) return true
  if (value === '::' || value === '::1') return true
  if (first >= 0xfc00 && first <= 0xfdff) return true
  if (first >= 0xfe80 && first <= 0xfebf) return true
  if (first >= 0xff00) return true
  if (value.startsWith('2001:db8:') || value === '2001:db8') return true
  const mapped = mappedIpv4(value)
  if (mapped !== undefined) return isPrivateIpv4(mapped)
  return false
}

function mappedIpv4(value: string): string | undefined {
  const marker = value.indexOf('::')
  const left = (marker < 0 ? value : value.slice(0, marker)).split(':').filter(Boolean)
  const right = (marker < 0 ? '' : value.slice(marker + 2)).split(':').filter(Boolean)
  const expanded = [
    ...left,
    ...(marker < 0 ? [] : Array(8 - left.length - right.length).fill('0')),
    ...right,
  ]
  if (expanded.length !== 8 || expanded[5]?.toLowerCase() !== 'ffff') return undefined
  const high = Number.parseInt(expanded[6] ?? '', 16)
  const low = Number.parseInt(expanded[7] ?? '', 16)
  if (!Number.isInteger(high) || !Number.isInteger(low) || high < 0 || low < 0) return undefined
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
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
