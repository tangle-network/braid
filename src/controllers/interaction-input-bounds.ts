import {
  assertBoundedString,
  assertBoundedStructure,
  MAX_ID_BYTES,
  MAX_INTERACTION_FIELDS,
  MAX_TEXT_BYTES,
} from '../domain/bounds.js'
import type { ReceiveInteractionInput, RespondInteractionInput } from '../ports/interactions.js'

const IDENTITY_FIELDS = [
  'runId',
  'interactionId',
  'providerSessionId',
  'profileDigest',
  'connectionId',
  'workspaceId',
  'conversationId',
  'branchId',
  'model',
  'runner',
] as const

export function assertReceiveInputBounded(input: ReceiveInteractionInput): void {
  assertIdentityFields(input as unknown as Record<string, unknown>)
}

export function assertResponseInputBounded(input: RespondInteractionInput): void {
  assertIdentityFields(input as unknown as Record<string, unknown>)
  assertBoundedString(input.operationId, 'operationId', MAX_ID_BYTES)
  assertBoundedString(input.response.id, 'response.id', MAX_ID_BYTES)
  assertBoundedStructure(input.response, {
    maxBytes: MAX_TEXT_BYTES,
    maxTotalBytes: MAX_TEXT_BYTES,
    maxDepth: 8,
    maxArrayLength: MAX_INTERACTION_FIELDS,
    maxObjectKeys: MAX_INTERACTION_FIELDS,
    maxFields: MAX_INTERACTION_FIELDS,
  })
}

function assertIdentityFields(input: Record<string, unknown>): void {
  for (const field of IDENTITY_FIELDS) {
    const value = input[field]
    if (value !== undefined) {
      if (typeof value !== 'string' || !value) {
        throw new Error(`${field} must be a non-empty string`)
      }
      assertBoundedString(value, field, MAX_ID_BYTES)
    }
  }
}
