import type { Digest, IdForKind, IdKind, ReplayCursor } from './ids-types.js'
import { redactSensitiveText } from './secret-sanitizer.js'

export const prefixes: Readonly<Record<IdKind, readonly string[]>> = {
  workspace: ['workspace-'],
  profile: ['profile-'],
  profileSnapshot: ['profile-snapshot-'],
  credentialRef: ['credential-', 'credential-ref-'],
  connection: ['connection-'],
  conversation: ['conversation-', 'conv-'],
  branch: ['branch-'],
  turn: ['turn-'],
  run: ['run-'],
  message: ['message-'],
  messagePart: ['message-part-', 'part-'],
  artifact: ['artifact-'],
  interaction: ['interaction-'],
  analysis: ['analysis-'],
  analysisRun: ['analysis-run-'],
  citation: ['citation-'],
  attachment: ['attachment-'],
  feedbackDecision: ['feedback-'],
  trace: ['trace-'],
  providerSession: ['provider-session-', 'session-'],
  environment: ['environment-', 'env-'],
  checkpoint: ['checkpoint-'],
  supervisor: ['supervisor-'],
  worker: ['worker-'],
  draft: ['draft-'],
  queue: ['queue-'],
  queueEntry: ['queue-entry-'],
  rule: ['rule-'],
  binding: ['binding-'],
  graphNode: ['node-'],
  graphEdge: ['edge-'],
  operation: ['operation-', 'op-'],
  effect: ['effect-'],
  receipt: ['receipt-'],
  event: ['event-'],
}

export const idPattern = /^[A-Za-z][A-Za-z0-9._:-]{0,255}$/u

export function parsePrefixedId<K extends IdKind>(kind: K, value: unknown): IdForKind<K> {
  if (
    typeof value !== 'string' ||
    !idPattern.test(value) ||
    !prefixes[kind].some((prefix) => value.startsWith(prefix)) ||
    redactSensitiveText(value) !== value
  ) {
    throw new TypeError(`Invalid ${kind} identifier`)
  }
  return value as IdForKind<K>
}

export function isPrefixedId<K extends IdKind>(kind: K, value: unknown): value is IdForKind<K> {
  return (
    typeof value === 'string' &&
    idPattern.test(value) &&
    prefixes[kind].some((prefix) => value.startsWith(prefix)) &&
    redactSensitiveText(value) === value
  )
}

export function assertPrefixedId<K extends IdKind>(
  kind: K,
  value: unknown,
): asserts value is IdForKind<K> {
  parsePrefixedId(kind, value)
}

export function parseDigest(value: unknown): Digest {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError('Invalid SHA-256 digest')
  }
  return value as Digest
}

export function isDigest(value: unknown): value is Digest {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

export function assertDigest(value: unknown): asserts value is Digest {
  parseDigest(value)
}

export function parseCursor(value: unknown): ReplayCursor {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes('\u0000') ||
    /\s/u.test(value)
  ) {
    throw new TypeError('Invalid replay cursor')
  }
  return value as ReplayCursor
}

export function isCursor(value: unknown): value is ReplayCursor {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.includes('\u0000') &&
    !/\s/u.test(value)
  )
}

export function assertCursor(value: unknown): asserts value is ReplayCursor {
  parseCursor(value)
}
