import type { InteractionResponse } from '@tangle-network/agent-interface'
import {
  capabilityForHeadlessCommand,
  isMutatingHeadlessCommand,
} from '../../views/shared/headless-commands.js'
import type { BraidIntent, UiDispatchResult } from '../../views/shared/intents.js'
import { queryActivity } from '../../views/shared/semantic-activity.js'
import { queryDetails } from '../../views/shared/semantic-details.js'
import { queryGraph } from '../../views/shared/semantic-graph.js'
import { SemanticQueryError } from '../../views/shared/semantic-query-scope.js'
import { dispatchConversationHeadlessCommand } from './ui-conversation-dispatch.js'
import { dispatchCoreIntent } from './ui-core-dispatch.js'
import type { UiDispatchContext } from './ui-dispatch-context.js'
import { projectInteractionReceipt } from './ui-interaction-receipt.js'

type HeadlessCommandIntent = Extract<BraidIntent, { readonly type: 'headless-command' }>

export async function dispatchHeadlessCommand(
  intent: HeadlessCommandIntent,
  context: UiDispatchContext,
): Promise<UiDispatchResult> {
  if (isMutatingHeadlessCommand(intent.command) && !intent.operationId) {
    return {
      kind: 'error',
      code: 'OPERATION_ID_REQUIRED',
      message: `${intent.command} requires operationId`,
      retryable: false,
    }
  }
  if (intent.command === 'get_graph') {
    const conversationId = stringParam(intent.command, intent.params, 'conversationId')
    const branchId = stringParam(intent.command, intent.params, 'branchId')
    const query = stringParam(intent.command, intent.params, 'query')
    const state = context.app.state()
    return {
      kind: 'accepted',
      revision: state.revision,
      data: queryGraph(state, {
        ...(conversationId === undefined ? {} : { conversationId }),
        ...(branchId === undefined ? {} : { branchId }),
        ...(query === undefined ? {} : { query }),
      }),
    }
  }
  if (intent.command === 'get_activity') {
    const conversationId = stringParam(intent.command, intent.params, 'conversationId')
    const branchId = stringParam(intent.command, intent.params, 'branchId')
    const runId = stringParam(intent.command, intent.params, 'runId')
    const state = context.app.state()
    return {
      kind: 'accepted',
      revision: state.revision,
      data: queryActivity(state, {
        ...(conversationId === undefined ? {} : { conversationId }),
        ...(branchId === undefined ? {} : { branchId }),
        ...(runId === undefined ? {} : { runId }),
      }),
    }
  }
  if (intent.command === 'get_details') {
    const entityType = stringParam(intent.command, intent.params, 'entityType')
    const entityId = stringParam(intent.command, intent.params, 'entityId')
    if (entityType === undefined || entityId === undefined) {
      throw new SemanticQueryError('INVALID_PARAMS', 'get_details requires entityType and entityId')
    }
    const state = context.app.state()
    return {
      kind: 'accepted',
      revision: state.revision,
      data: queryDetails(state, { entityType, entityId }),
    }
  }

  const conversationResult = await dispatchConversationHeadlessCommand(intent, context)
  if (conversationResult !== undefined) return conversationResult
  if (intent.command === 'cancel_run') {
    if (!intent.operationId) {
      return {
        kind: 'error',
        code: 'OPERATION_ID_REQUIRED',
        message: 'cancel_run requires operationId',
        retryable: false,
      }
    }
    return dispatchCoreIntent(
      {
        type: 'cancel-run',
        operationId: intent.operationId,
        ...(typeof intent.params.runId === 'string' ? { runId: intent.params.runId } : {}),
      },
      context,
    )
  }
  if (intent.command === 'queue' || intent.command === 'steer') {
    const text = intent.params.text
    if (typeof text !== 'string') {
      return {
        kind: 'error',
        code: 'INVALID_PARAMS',
        message: `${intent.command}.params.text must be a string`,
        retryable: false,
      }
    }
    return dispatchCoreIntent(
      { type: intent.command, operationId: intent.operationId ?? '', text },
      context,
    )
  }
  if (intent.command === 'cancel') {
    const receipt = await context.app.cancelRun({
      operationId: intent.operationId ?? '',
      ...(typeof intent.params.runId === 'string' ? { runId: intent.params.runId } : {}),
      ...(typeof intent.params.reason === 'string' ? { reason: intent.params.reason } : {}),
    })
    return {
      kind: 'accepted',
      operationId: receipt.operationId,
      runId: receipt.runId,
      control: 'cancel',
      outcome: receipt.acknowledgement.outcome,
      revision: context.app.state().revision,
      completion: receipt.completion.then(() => undefined),
    }
  }
  if (intent.command === 'detach') {
    const receipt = await context.app.detachRun({
      operationId: intent.operationId ?? '',
      ...(typeof intent.params.runId === 'string' ? { runId: intent.params.runId } : {}),
    })
    return {
      kind: 'accepted',
      operationId: receipt.operationId,
      runId: receipt.runId,
      control: 'detach',
      outcome: receipt.acknowledgement.outcome,
      revision: context.app.state().revision,
      completion: receipt.completion.then(() => undefined),
    }
  }
  if (intent.command === 'reconnect' || intent.command === 'reconcile') {
    const runId = intent.params.runId
    if (typeof runId !== 'string') {
      return {
        kind: 'error',
        code: 'INVALID_PARAMS',
        message: `${intent.command}.params.runId must be a string`,
        retryable: false,
      }
    }
    const state =
      intent.command === 'reconnect'
        ? await context.app.reconnectRun({
            operationId: intent.operationId ?? '',
            runId,
          })
        : await context.app.reconcileRun({
            operationId: intent.operationId ?? '',
            runId,
          })
    return { kind: 'accepted', revision: state.revision }
  }
  if (intent.command === 'respond_interaction') {
    const runId = intent.params.runId
    const interactionId = intent.params.interactionId
    if (typeof runId !== 'string' || typeof interactionId !== 'string') {
      return {
        kind: 'error',
        code: 'INVALID_PARAMS',
        message: 'respond_interaction requires runId and interactionId',
        retryable: false,
      }
    }
    const receipt = await context.app.respondInteraction({
      operationId: intent.operationId ?? '',
      runId,
      interactionId,
      response: intent.params.response as InteractionResponse,
    })
    return projectInteractionReceipt(receipt, () => context.app.state().revision)
  }
  if (intent.command === 'send') {
    const text = intent.params.text
    if (typeof text !== 'string') {
      return {
        kind: 'error',
        code: 'INVALID_PARAMS',
        message: 'send.params.text must be a string',
        retryable: false,
      }
    }
    if (!intent.operationId) {
      return {
        kind: 'error',
        code: 'OPERATION_ID_REQUIRED',
        message: 'send requires operationId',
        retryable: false,
      }
    }
    return dispatchCoreIntent(
      {
        type: 'send',
        operationId: intent.operationId,
        text,
        ...(typeof intent.params.conversationId === 'string'
          ? { conversationId: intent.params.conversationId }
          : {}),
        ...(typeof intent.params.branchId === 'string' ? { branchId: intent.params.branchId } : {}),
      },
      context,
    )
  }
  const capability = capabilityForHeadlessCommand(intent.command)
  if (capability && !context.view().capabilities[capability]?.available) {
    return {
      kind: 'unavailable',
      code: 'CAPABILITY_UNAVAILABLE',
      reason: context.view().capabilities[capability]?.reason ?? 'Capability is unavailable',
    }
  }
  return {
    kind: 'unavailable',
    code: 'CAPABILITY_UNAVAILABLE',
    reason: isMutatingHeadlessCommand(intent.command)
      ? 'The current application core does not implement this command'
      : 'The current application core does not implement this query',
  }
}

function stringParam(
  command: string,
  params: Readonly<Record<string, unknown>>,
  name: string,
): string | undefined {
  const value = params[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new SemanticQueryError('INVALID_PARAMS', `${command}.params.${name} must be a string`)
  }
  return value
}
