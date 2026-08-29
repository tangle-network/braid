import type { InteractionRequest } from '@tangle-network/agent-interface'
import type {
  AutomationRuleScope,
  NonSecretInteractionData,
} from '../domain/entities-interactions.js'
import type { AutomationRuleMatcher, AutomationRuleRecord } from '../domain/entities-runtime.js'
import type { BraidEventEnvelope } from '../domain/events.js'
import type { BraidInteraction } from '../domain/runtime-projection.js'
import type { BraidState } from '../domain/state.js'
import { SerializedActionQueue } from './action-serialization.js'
import type { AutomationRuleMetadata } from './automation-matching.js'
import type {
  ApplyAutomationReceipt,
  AutomationContext,
  AutomationDryRunReceipt,
  AutomationRuleReceipt,
  AutomationStoreInput,
  RuleMutationReceipt,
  StoredAutomationRule,
} from './automation-rule-types.js'
import { interactionRequestDigest } from './automation-rule-validation.js'
import {
  applyAutomation,
  createAutomationRule,
  deleteAutomationRule,
  disableAutomationRule,
  dryRunAutomation,
  updateAutomationRule,
} from './automation-rules.js'
import { AppError } from './errors.js'

export interface AutomationRuleCreateCommand {
  readonly operationId: string
  readonly ruleId: string
  readonly runId?: string
  readonly interactionId?: string
  readonly request?: InteractionRequest
  readonly answer: NonSecretInteractionData
  readonly responseScope: AutomationRuleScope
  readonly matcher?: AutomationRuleMatcher
  readonly context?: AutomationContext
  readonly expiresAt?: string
  readonly maximumUses?: number
  readonly confirmPersistent?: boolean
  readonly creationSource?: AutomationRuleMetadata['creationSource']
}

export interface AutomationRuleUpdateCommand {
  readonly operationId: string
  readonly ruleId: string
  readonly runId?: string
  readonly interactionId?: string
  readonly request?: InteractionRequest
  readonly answer?: NonSecretInteractionData
  readonly responseScope?: AutomationRuleScope
  readonly matcher?: AutomationRuleMatcher
  readonly context?: AutomationContext
  readonly expiresAt?: string
  readonly maximumUses?: number
  readonly confirmPersistent?: boolean
  readonly creationSource?: AutomationRuleMetadata['creationSource']
}

export interface AutomationDryRunCommand {
  readonly operationId: string
  readonly runId: string
  readonly interactionId: string
  readonly context?: AutomationContext
}

export interface AutomationApplyCommand {
  readonly operationId: string
  readonly runId: string
  readonly interactionId: string
}

export interface AutomationApplyOptions {
  /** Used by startup reconciliation, which already owns the readiness barrier. */
  readonly bypassStartupReconciliation?: boolean
}

export interface AutomationActions {
  readonly create: (input: AutomationRuleCreateCommand) => Promise<AutomationRuleReceipt>
  readonly update: (input: AutomationRuleUpdateCommand) => Promise<AutomationRuleReceipt>
  readonly dryRun: (input: AutomationDryRunCommand) => Promise<AutomationDryRunReceipt>
  readonly apply: (
    input: AutomationApplyCommand,
    options?: AutomationApplyOptions,
  ) => Promise<ApplyAutomationReceipt>
  readonly disable: (input: {
    readonly operationId: string
    readonly ruleId: string
  }) => Promise<RuleMutationReceipt>
  readonly delete: (input: {
    readonly operationId: string
    readonly ruleId: string
  }) => Promise<RuleMutationReceipt>
  readonly list: () => readonly StoredAutomationRule[]
}

export function createAutomationActions(options: {
  readonly state: () => BraidState
  readonly events: () => readonly BraidEventEnvelope[]
  readonly commitAndWait: AutomationStoreInput['commitAndWait']
  readonly now: () => string
  readonly respond: (
    input: {
      readonly operationId: string
      readonly runId: string
      readonly interactionId: string
      readonly response: import('@tangle-network/agent-interface').InteractionResponse
      readonly automationRule?: AutomationRuleRecord
    },
    options?: AutomationApplyOptions,
  ) => Promise<import('./application-types.js').InteractionReceipt>
  readonly startupReconciliation?: Promise<void>
  readonly reconcilePending?: () => Promise<void>
  readonly canRespond: (runId?: string) => boolean
}): AutomationActions {
  const queue = new SerializedActionQueue()
  const store = (): AutomationStoreInput => ({
    state: options.state,
    events: options.events,
    commitAndWait: options.commitAndWait,
    now: options.now,
  })

  return {
    create: async (input) => {
      const receipt = await queue.run(async () => {
        const target = targetFor(options.state(), input.runId, input.interactionId)
        assertCanRespond(options, target)
        const request = requestFor(target, input.request)
        return createAutomationRule({
          ...store(),
          ...input,
          request,
          context: contextFor(options.state(), target, input.context),
        })
      })
      await options.reconcilePending?.()
      return receipt
    },
    update: async (input) => {
      const receipt = await queue.run(async () => {
        const target = targetFor(options.state(), input.runId, input.interactionId)
        assertCanRespond(options, target)
        const request = input.request ?? target?.request
        return updateAutomationRule({
          ...store(),
          ...input,
          ...(request === undefined ? {} : { request }),
          context: contextFor(options.state(), target, input.context),
        })
      })
      await options.reconcilePending?.()
      return receipt
    },
    dryRun: (input) =>
      queue.run(async () => {
        const state = options.state()
        const target = targetFor(state, input.runId, input.interactionId)
        if (target === undefined)
          throw new AppError('UNKNOWN_INTERACTION', 'The interaction is no longer available')
        assertCanRespond(options, target)
        return dryRunAutomation({
          ...store(),
          operationId: input.operationId,
          interaction: target,
          context: contextFor(state, target, input.context),
        })
      }),
    apply: (input, applyOptions = {}) => {
      const ready =
        applyOptions.bypassStartupReconciliation === true
          ? Promise.resolve()
          : (options.startupReconciliation ?? Promise.resolve())
      return ready.then(() =>
        queue.run(async () => {
          const state = options.state()
          const target = targetFor(state, input.runId, input.interactionId)
          if (target === undefined)
            throw new AppError('UNKNOWN_INTERACTION', 'The interaction is no longer available')
          assertCanRespond(options, target)
          return applyAutomation({
            ...store(),
            operationId: input.operationId,
            interaction: target,
            context: contextFor(state, target, undefined),
            respond: (response, { rule }) =>
              options.respond(
                {
                  operationId: input.operationId,
                  runId: input.runId,
                  interactionId: input.interactionId,
                  response,
                  automationRule: rule,
                },
                applyOptions,
              ),
          })
        }),
      )
    },
    disable: async (input) => {
      const receipt = await queue.run(() => disableAutomationRule({ ...store(), ...input }))
      await options.reconcilePending?.()
      return receipt
    },
    delete: async (input) => {
      const receipt = await queue.run(() => deleteAutomationRule({ ...store(), ...input }))
      await options.reconcilePending?.()
      return receipt
    },
    list: () => structuredClone(options.state().rules) as readonly StoredAutomationRule[],
  }
}

function assertCanRespond(
  options: { readonly canRespond: (runId?: string) => boolean },
  target: BraidInteraction | undefined,
): void {
  if (target === undefined || options.canRespond(target.runId)) return
  throw new AppError(
    'CAPABILITY_UNAVAILABLE',
    'The current runtime cannot acknowledge interaction responses',
  )
}

function targetFor(
  state: BraidState,
  runId: string | undefined,
  interactionId: string | undefined,
): BraidInteraction | undefined {
  if (runId === undefined && interactionId === undefined) return undefined
  if (runId === undefined || interactionId === undefined)
    throw new AppError(
      'INVALID_PARAMS',
      'Automation commands require both runId and interactionId when targeting a pending interaction',
    )
  const run = state.runs.find((candidate) => candidate.id === runId)
  const target = run?.interactions.find((candidate) => candidate.request.id === interactionId)
  if (target === undefined)
    throw new AppError('UNKNOWN_INTERACTION', 'The interaction is no longer available')
  return target
}

function requestFor(
  target: BraidInteraction | undefined,
  request: InteractionRequest | undefined,
): InteractionRequest {
  if (target !== undefined && request !== undefined) {
    if (interactionRequestDigest(target.request) !== interactionRequestDigest(request))
      throw new AppError(
        'INTERACTION_BINDING_MISMATCH',
        'The automation request belongs to a different interaction',
      )
    return target.request
  }
  if (target !== undefined) return target.request
  if (request !== undefined) return request
  throw new AppError(
    'AUTOMATION_INTERACTION_REQUIRED',
    'Automation create or update requires an interaction target or request',
  )
}

function contextFor(
  state: BraidState,
  target: BraidInteraction | undefined,
  provided: AutomationContext | undefined,
): AutomationContext {
  const run =
    target === undefined ? undefined : state.runs.find((candidate) => candidate.id === target.runId)
  const providerSessionId = run?.providerSessionId ?? target?.responseBinding.sessionId
  return {
    ...(state.workspaceId === null ? {} : { workspaceId: state.workspaceId }),
    ...(run?.receipt.profileDigest === undefined
      ? {}
      : { profileDigest: run.receipt.profileDigest }),
    ...(run?.connectionId === undefined && run?.receipt.requested.connectionId === undefined
      ? {}
      : { connectionId: run.connectionId ?? run.receipt.requested.connectionId }),
    ...(run?.receipt.requested.runner === undefined
      ? {}
      : { runner: run.receipt.requested.runner }),
    ...(providerSessionId === undefined ? {} : { providerSessionId }),
    ...(provided ?? {}),
  }
}
