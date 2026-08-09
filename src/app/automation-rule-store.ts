import type { BraidEvent, BraidEventEnvelope } from '../domain/events.js'
import { createOperationId, type Digest } from '../domain/ids.js'
import type { StoredAutomationRule } from './automation-matching.js'
import type { AutomationStoreInput } from './automation-rule-types.js'

export async function commitAutomationEvent(
  input: AutomationStoreInput,
  event: BraidEvent,
): Promise<void> {
  const result = input.commitAndWait(event)
  if (result !== undefined) await result
}

export function automationOperationRecord(operationId: string, requestDigest: Digest, now: string) {
  return {
    id: createOperationId(operationId),
    kind: 'custom' as const,
    requestDigest,
    status: 'terminal' as const,
    createdAt: now,
    updatedAt: now,
  }
}

export function findAutomationOperation(
  events: readonly BraidEventEnvelope[],
  operationId: string,
): { readonly id: string; readonly requestDigest: Digest } | undefined {
  for (const envelope of events) {
    const event = envelope.event
    if (event.kind === 'rule.upserted' && event.operation?.id === operationId)
      return event.operation
    if (event.kind === 'rule.deleted' && event.operation.id === operationId) return event.operation
  }
  return undefined
}

export function findAutomationRuleEvent(
  events: readonly BraidEventEnvelope[],
  operationId: string,
): StoredAutomationRule | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event
    if (event?.kind === 'rule.upserted' && event.operation?.id === operationId)
      return event.rule as StoredAutomationRule
  }
  return undefined
}
