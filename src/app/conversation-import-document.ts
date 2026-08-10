import { resolve } from 'node:path'
import { readNoFollow } from '../adapters/persistence/safe-file.js'
import { canonicalDigest } from '../domain/canonical.js'
import type { Digest } from '../domain/ids.js'
import { parseDigestValue } from '../domain/ids.js'
import { redactStructuredValueWithNumericTelemetry } from '../domain/redaction.js'
import { isCanonicalIsoDateTime } from '../domain/text.js'
import {
  type ConversationExportDocument,
  MAX_CONVERSATION_DOCUMENT_BYTES,
  MAX_CONVERSATION_DOCUMENT_ITEMS,
} from './conversation-exports.js'
import { AppError } from './errors.js'

const MAX_IMPORT_DEPTH = 24
// The 2 MiB byte limit remains the primary memory bound. A long, valid run history
// contains many small nested receipt and event fields, so its aggregate node count
// is intentionally higher than any single collection limit used during redaction.
const DOCUMENT_KEYS = new Set([
  'schemaVersion',
  'format',
  'exportedAt',
  'conversationId',
  'content',
  'contentDigest',
  'redacted',
  'externalControlsDisabled',
])
const CONTENT_KEYS = new Set([
  'conversation',
  'branches',
  'messages',
  'messageParts',
  'turns',
  'runs',
  'analyses',
  'graphNodes',
  'graphEdges',
  'feedbackDecisions',
])
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export interface PreparedConversationImport {
  readonly document: ConversationExportDocument
  readonly contentDigest: Digest
  readonly bytes: number
}

export interface ConversationImportSource {
  readonly content?: string
  readonly source?: string
}

export function prepareConversationImport(
  input: ConversationImportSource,
): PreparedConversationImport {
  let raw = readImportSource(input)
  if (input.source !== undefined && raw.endsWith('\n')) {
    raw = raw.slice(0, -1)
    if (raw.endsWith('\r')) raw = raw.slice(0, -1)
  }
  const bytes = Buffer.byteLength(raw, 'utf8')
  if (bytes > MAX_CONVERSATION_DOCUMENT_BYTES) {
    throw new AppError('IMPORT_TOO_LARGE', 'Conversation import exceeds 2 MiB')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new AppError('IMPORT_INVALID_JSON', 'Conversation import is not valid JSON')
  }
  assertBoundedImport(parsed)
  const document = assertConversationDocument(parsed)
  let actual: Digest
  try {
    actual = canonicalDigest(document.content)
  } catch {
    throw new AppError('IMPORT_INVALID', 'Conversation import content is not canonical JSON')
  }
  if (actual !== document.contentDigest) {
    throw new AppError('IMPORT_DIGEST_MISMATCH', 'Conversation import checksum does not match')
  }
  let redacted: unknown
  try {
    redacted = redactStructuredValueWithNumericTelemetry(document.content, undefined, {
      maxDepth: MAX_IMPORT_DEPTH,
      maxItems: MAX_CONVERSATION_DOCUMENT_ITEMS,
      maxBytes: MAX_CONVERSATION_DOCUMENT_BYTES,
    })
  } catch {
    throw new AppError('IMPORT_TOO_COMPLEX', 'Conversation import exceeds structural limits')
  }
  if (canonicalDigest(redacted) !== actual) {
    throw new AppError('IMPORT_REDACTION_REQUIRED', 'Conversation import contains unsafe data')
  }
  return { document, contentDigest: actual, bytes }
}

function readImportSource(input: ConversationImportSource): string {
  const hasContent = input.content !== undefined
  const hasSource = input.source !== undefined
  if (hasContent === hasSource) {
    throw new AppError(
      'IMPORT_SOURCE_REQUIRED',
      'Provide exactly one import content or source path',
    )
  }
  if (input.content !== undefined) return input.content
  if (input.source?.trim().length === 0) {
    throw new AppError('IMPORT_SOURCE_REQUIRED', 'Conversation import source path is empty')
  }
  try {
    const bytes = readNoFollow(resolve(input.source as string), MAX_CONVERSATION_DOCUMENT_BYTES + 1)
    if (bytes === undefined)
      throw new AppError('IMPORT_NOT_FOUND', 'Conversation import file was not found')
    return bytes.toString('utf8')
  } catch (error) {
    if (error instanceof AppError) throw error
    const message = error instanceof Error ? error.message : ''
    if (/too large/iu.test(message)) {
      throw new AppError('IMPORT_TOO_LARGE', 'Conversation import exceeds 2 MiB')
    }
    throw new AppError('IMPORT_SOURCE_UNSAFE', 'Conversation import file could not be read safely')
  }
}

function assertConversationDocument(value: unknown): ConversationExportDocument {
  const document = recordValue(value, 'Conversation import')
  assertExactKeys(document, DOCUMENT_KEYS, 'Conversation import')
  if (document.schemaVersion !== 2 || document.format !== 'braid-conversation') {
    throw new AppError('IMPORT_UNSUPPORTED', 'Conversation import format or version is unsupported')
  }
  if (!isCanonicalIsoDateTime(document.exportedAt)) {
    throw new AppError('IMPORT_INVALID', 'Conversation import timestamp is invalid')
  }
  if (typeof document.conversationId !== 'string') {
    throw new AppError('IMPORT_INVALID', 'Conversation import identifier is invalid')
  }
  if (document.redacted !== true || document.externalControlsDisabled !== true) {
    throw new AppError(
      'IMPORT_UNSAFE',
      'Conversation import must be redacted with controls disabled',
    )
  }
  const content = recordValue(document.content, 'Conversation import content')
  assertExactKeys(content, CONTENT_KEYS, 'Conversation import content')
  for (const key of CONTENT_KEYS) {
    if (key === 'conversation') continue
    if (!Array.isArray(content[key])) {
      throw new AppError('IMPORT_INVALID', `Conversation import content.${key} must be an array`)
    }
  }
  recordValue(content.conversation, 'Conversation import conversation')
  let contentDigest: Digest
  try {
    contentDigest = parseDigestValue(document.contentDigest)
  } catch {
    throw new AppError('IMPORT_INVALID', 'Conversation import checksum is invalid')
  }
  return {
    schemaVersion: 2,
    format: 'braid-conversation',
    exportedAt: document.exportedAt,
    conversationId: document.conversationId,
    content,
    contentDigest,
    redacted: true,
    externalControlsDisabled: true,
  }
}

function assertBoundedImport(root: unknown): void {
  const stack: { readonly value: unknown; readonly depth: number }[] = [{ value: root, depth: 0 }]
  let items = 0
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) break
    if (current.depth > MAX_IMPORT_DEPTH) {
      throw new AppError('IMPORT_TOO_COMPLEX', 'Conversation import nesting is too deep')
    }
    if (current.value === null || typeof current.value !== 'object') {
      if (typeof current.value === 'number' && !Number.isFinite(current.value)) {
        throw new AppError('IMPORT_INVALID', 'Conversation import contains a non-finite number')
      }
      continue
    }
    const entries = Array.isArray(current.value)
      ? current.value.map((value, index) => [String(index), value] as const)
      : Object.entries(current.value)
    items += entries.length
    if (items > MAX_CONVERSATION_DOCUMENT_ITEMS) {
      throw new AppError('IMPORT_TOO_COMPLEX', 'Conversation import contains too many items')
    }
    for (const [key, child] of entries) {
      if (DANGEROUS_KEYS.has(key)) {
        throw new AppError('IMPORT_INVALID', 'Conversation import contains a forbidden object key')
      }
      stack.push({ value: child, depth: current.depth + 1 })
    }
  }
}

export function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('IMPORT_INVALID', `${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key))
  if (unknown !== undefined) {
    throw new AppError('IMPORT_INVALID', `${label} contains unknown field ${unknown}`)
  }
  const missing = [...allowed].find((key) => value[key] === undefined)
  if (missing !== undefined) {
    throw new AppError('IMPORT_INVALID', `${label} is missing field ${missing}`)
  }
}
