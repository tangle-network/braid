import {
  assertBoundedString,
  assertBoundedStructure,
  MAX_ID_BYTES,
  MAX_INTERACTION_FIELDS,
  MAX_TEXT_BYTES,
} from '../domain/bounds.js'
import type {
  AutomationDryRunInput,
  CreateAutomationRuleInput,
  UpdateAutomationRuleInput,
} from './interaction-controller-types.js'
import { InteractionError } from './interaction-error.js'
import { assertOperationId } from '../domain/operation-authority.js'

const MATCHER_FIELDS = [
  'interactionKind',
  'subjectType',
  'subjectValue',
  'profileDigest',
  'connectionId',
  'runner',
  'workspaceId',
  'providerSessionId',
] as const

export function assertAutomationCreateBounded(input: CreateAutomationRuleInput): void {
  assertInput(input, input.interactionKey, input.expiresAt)
}

export function assertAutomationUpdateBounded(input: UpdateAutomationRuleInput): void {
  assertInput(input, input.ruleId, input.interactionKey, input.expiresAt)
}

export function assertAutomationDryRunBounded(input: AutomationDryRunInput): void {
  assertInput(input, input.key)
}

export function assertAutomationCommandBounded(operationId: string, ruleId: string): void {
  try {
    assertOperationId(operationId)
    assertBoundedString(ruleId, 'ruleId', MAX_ID_BYTES)
  } catch (error) {
    throw new InteractionError(
      'INVALID_AUTOMATION_RULE',
      error instanceof Error ? error.message : 'Automation identity is invalid',
    )
  }
}

function assertInput(input: object, ...identityValues: readonly (string | undefined)[]): void {
  try {
    assertBoundedStructure(input, {
      maxBytes: MAX_TEXT_BYTES,
      maxDepth: 16,
      maxArrayLength: MAX_INTERACTION_FIELDS,
      maxObjectKeys: MAX_INTERACTION_FIELDS,
      maxFields: MAX_INTERACTION_FIELDS * 4,
    })
    for (const value of identityValues) {
      if (value !== undefined) assertBoundedString(value, 'automation identity', MAX_ID_BYTES)
    }
    const operationId = (input as { readonly operationId?: string }).operationId
    if (operationId !== undefined) assertOperationId(operationId)
    const matcher = (input as { readonly matcher?: Record<string, unknown> }).matcher
    for (const field of MATCHER_FIELDS) {
      const value = matcher?.[field]
      if (value !== undefined)
        assertBoundedString(value as string, `matcher.${field}`, MAX_ID_BYTES)
    }
  } catch (error) {
    throw new InteractionError(
      'INVALID_AUTOMATION_RULE',
      error instanceof Error ? error.message : 'Automation input is too large',
    )
  }
}
