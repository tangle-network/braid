import { permissionScopeOffered } from '../domain/interaction.js'
import type { InteractionRecord } from '../domain/interaction-state.js'
import type { CreateAutomationRuleInput } from './interaction-controller-types.js'
import { InteractionError } from './interaction-error.js'

export function validateAutomationScope(
  request: InteractionRecord['request'],
  target: InteractionRecord | undefined,
  input: CreateAutomationRuleInput,
  publicData: Readonly<Record<string, string | number | boolean | readonly string[]>>,
): void {
  if (request.kind === 'permission') {
    const grant = publicData.grant
    const selected = Array.isArray(grant) && grant.length === 1 ? grant[0] : undefined
    const expected =
      input.responseScope === 'once'
        ? 'allow_once'
        : input.responseScope === 'session'
          ? 'allow_session'
          : 'allow_always'
    if (selected !== expected && selected !== 'deny') {
      throw new InteractionError(
        'AUTOMATION_SCOPE_NOT_OFFERED',
        'The rule answer exceeds its response scope',
      )
    }
    const offeredScope = selected === 'deny' ? 'deny' : input.responseScope
    if (!permissionScopeOffered(request, offeredScope)) {
      throw new InteractionError(
        'AUTOMATION_SCOPE_NOT_OFFERED',
        'The requested response scope was not offered',
      )
    }
  } else if (input.responseScope !== 'once') {
    throw new InteractionError(
      'AUTOMATION_SCOPE_NOT_OFFERED',
      'Only one-time automation is offered for this interaction',
    )
  }
  const persistentProfile = input.matcher?.profileDigest ?? target?.profileDigest
  if (input.responseScope === 'persistent' && (!request.subject || !persistentProfile)) {
    throw new InteractionError(
      'AUTOMATION_SCOPE_NOT_OFFERED',
      'Persistent automation requires an exact subject and profile scope',
    )
  }
  if (input.responseScope === 'persistent' && input.matcher?.providerSessionId !== undefined) {
    throw new InteractionError(
      'AUTOMATION_SCOPE_NOT_OFFERED',
      'Persistent automation cannot be bound to one provider session',
    )
  }
  if (
    input.responseScope === 'session' &&
    !target?.providerSessionId &&
    !input.matcher?.providerSessionId
  ) {
    throw new InteractionError(
      'AUTOMATION_SCOPE_NOT_OFFERED',
      'Session automation requires an exact provider session scope',
    )
  }
  if (
    input.maximumUses !== undefined &&
    (!Number.isInteger(input.maximumUses) || input.maximumUses < 1)
  ) {
    throw new InteractionError('INVALID_AUTOMATION_RULE', 'maximumUses must be a positive integer')
  }
  if (input.priority !== undefined && !Number.isInteger(input.priority)) {
    throw new InteractionError('INVALID_AUTOMATION_RULE', 'priority must be an integer')
  }
  if (input.expiresAt !== undefined && !Number.isFinite(Date.parse(input.expiresAt))) {
    throw new InteractionError('INVALID_AUTOMATION_RULE', 'expiresAt must be a valid timestamp')
  }
}
