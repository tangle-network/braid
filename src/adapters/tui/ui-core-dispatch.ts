import type { InteractionResponse } from '@tangle-network/agent-interface'
import type {
  BraidIntent,
  InteractionResponseValue,
  UiDispatchResult,
} from '../../views/shared/intents.js'
import type { UiDispatchContext } from './ui-dispatch-context.js'
import { FIXTURE_INTERACTION } from './ui-fixtures.js'
import { projectInteractionReceipt } from './ui-interaction-receipt.js'

export type CoreIntent = Exclude<BraidIntent, { readonly type: 'run-command' | 'headless-command' }>

/** Routes operations that are not command names or headless catalog entries. */
export async function dispatchCoreIntent(
  intent: CoreIntent,
  context: UiDispatchContext,
): Promise<UiDispatchResult> {
  switch (intent.type) {
    case 'send': {
      const receipt = context.app.send({
        operationId: intent.operationId,
        text: intent.text,
        ...(intent.conversationId ? { conversationId: intent.conversationId } : {}),
        ...(intent.branchId ? { branchId: intent.branchId } : {}),
      })
      if (receipt.admissionReady !== undefined) await receipt.admissionReady
      return {
        kind: 'accepted',
        operationId: receipt.operationId,
        runId: receipt.runId,
        revision: receipt.revision,
        replayed: receipt.replayed,
        admission: receipt.admission,
        completion: receipt.completion.then(() => undefined),
      }
    }
    case 'cancel-run': {
      if (!context.app.canCancel()) {
        return {
          kind: 'unavailable',
          code: 'CAPABILITY_UNAVAILABLE',
          reason: 'The current runtime does not acknowledge provider cancellation',
        }
      }
      const receipt = await context.app.cancelRun({
        operationId: intent.operationId,
        ...(intent.runId ? { runId: intent.runId } : {}),
        terminalStatus: 'aborted',
        legacy: true,
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
    case 'open-surface':
      context.setSelectedSurface(intent.surface === 'settings' ? 'details' : intent.surface)
      context.notify()
      return { kind: 'accepted', revision: context.app.state().revision }
    case 'shutdown': {
      if (!intent.operationId) {
        return {
          kind: 'error',
          code: 'OPERATION_ID_REQUIRED',
          message: 'shutdown requires operationId',
          retryable: false,
        }
      }
      const receipt = context.app.shutdown({
        operationId: intent.operationId,
        ...(intent.mode === undefined ? {} : { mode: intent.mode }),
      })
      return {
        kind: 'accepted',
        operationId: receipt.operationId,
        revision: receipt.revision,
        replayed: receipt.replayed,
        completion: receipt.completion.then(() => undefined),
      }
    }
    case 'resize':
      return { kind: 'accepted', revision: context.app.state().revision }
    case 'set-draft': {
      const result = await context.app.conversations.drafts.set({
        operationId: intent.operationId,
        text: intent.text,
        ...(intent.conversationId === undefined ? {} : { conversationId: intent.conversationId }),
        ...(intent.branchId === undefined ? {} : { branchId: intent.branchId }),
      })
      return {
        kind: 'accepted',
        operationId: intent.operationId,
        revision: context.app.state().revision,
        replayed: result.replayed,
        data: result.draft,
      }
    }
    case 'respond-interaction':
      return dispatchInteractionResponse(intent, context)
    case 'queue': {
      const receipt = context.app.queueInput({
        operationId: intent.operationId,
        text: intent.text,
      })
      if (receipt.completion !== undefined) await receipt.completion
      return {
        kind: 'accepted',
        operationId: receipt.operationId,
        runId: receipt.runId,
        control: 'queue',
        position: receipt.position,
        revision: receipt.revision,
        ...(receipt.completion === undefined
          ? {}
          : { completion: receipt.completion.then(() => undefined) }),
      }
    }
    case 'steer': {
      const receipt = await context.app.steer({
        operationId: intent.operationId,
        text: intent.text,
      })
      return {
        kind: 'accepted',
        operationId: receipt.operationId,
        runId: receipt.runId,
        control: 'steer',
        outcome: receipt.acknowledgement.outcome,
        revision: context.app.state().revision,
        completion: receipt.completion.then(() => undefined),
      }
    }
    default: {
      const exhaustive: never = intent
      return exhaustive
    }
  }
}

async function dispatchInteractionResponse(
  intent: Extract<BraidIntent, { readonly type: 'respond-interaction' }>,
  context: UiDispatchContext,
): Promise<UiDispatchResult> {
  if (
    context.fixture === 'interaction' &&
    !context.interactionResolved() &&
    intent.runId === FIXTURE_INTERACTION.runId &&
    intent.interactionId === FIXTURE_INTERACTION.interactionId
  ) {
    context.markInteractionResolved()
    context.notify()
    return {
      kind: 'accepted',
      operationId: intent.operationId,
      revision: context.app.state().revision,
      completion: Promise.resolve(),
    }
  }

  const run = context.app.state().runs.find((candidate) => candidate.id === intent.runId)
  const interaction = run?.interactions.find(
    (candidate) => candidate.request.id === intent.interactionId,
  )
  if (!interaction) {
    return {
      kind: 'error',
      code: 'UNKNOWN_INTERACTION',
      message: 'The interaction is no longer available',
      retryable: false,
    }
  }
  const response = responseForIntent(interaction.request, intent.interactionId, intent.response)
  if (!response) {
    return {
      kind: 'unavailable',
      code: 'CAPABILITY_UNAVAILABLE',
      reason: 'This interaction only permits decline or cancel',
    }
  }
  const receipt = await context.app.respondInteraction({
    operationId: intent.operationId,
    runId: intent.runId,
    interactionId: intent.interactionId,
    response,
  })
  return projectInteractionReceipt(receipt, () => context.app.state().revision)
}

function responseForIntent(
  request: import('@tangle-network/agent-interface').InteractionRequest,
  interactionId: string,
  value: InteractionResponseValue,
): InteractionResponse | undefined {
  if (value.outcome === 'cancel') return { id: interactionId, outcome: 'cancelled' }
  if (request.kind !== 'question' && request.kind !== 'permission') return undefined
  if (value.outcome === 'deny' || value.outcome === 'reject' || value.outcome === 'revise')
    return { id: interactionId, outcome: 'declined' }
  if (!['accept', 'once', 'session', 'persistent'].includes(value.outcome)) return undefined
  if (value.data !== undefined) {
    const data: Record<string, string | number | boolean | string[]> = {}
    for (const [key, item] of Object.entries(value.data)) {
      data[key] = Array.isArray(item) ? item.map(String) : (item as string | number | boolean)
    }
    return { id: interactionId, outcome: 'accepted', data }
  }
  const rawValue = 'value' in value ? value.value : undefined
  const field = request.answerSpec.fields[0]
  if (request.kind === 'permission') {
    const grant =
      value.outcome === 'once'
        ? 'allow_once'
        : value.outcome === 'session'
          ? 'allow_session'
          : value.outcome === 'persistent'
            ? 'allow_always'
            : typeof rawValue === 'string' &&
                ['allow_once', 'allow_session', 'allow_always'].includes(rawValue)
              ? rawValue
              : 'allow_once'
    return { id: interactionId, outcome: 'accepted', data: { grant } }
  }
  if (!field || rawValue === undefined) return { id: interactionId, outcome: 'accepted' }
  const fieldValue = field.type === 'select' ? [String(rawValue)] : rawValue
  return { id: interactionId, outcome: 'accepted', data: { [field.name]: fieldValue } }
}
