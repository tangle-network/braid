import { commandAvailability, isMutatingCommand } from '../../views/shared/command-registry.js'
import type { BraidIntent, UiDispatchResult } from '../../views/shared/intents.js'
import type { InteractionOutcome, InteractionView } from '../../views/shared/models.js'
import { dispatchAutomationCommand } from './ui-automation-command.js'
import { dispatchConversationRunCommand } from './ui-conversation-dispatch.js'
import { dispatchCoreIntent } from './ui-core-dispatch.js'
import type { UiDispatchContext } from './ui-dispatch-context.js'
import { dispatchHeadlessCommand } from './ui-headless-dispatch.js'

type RunCommandIntent = Extract<BraidIntent, { readonly type: 'run-command' }>

export async function dispatchCommandIntent(
  intent: RunCommandIntent,
  context: UiDispatchContext,
): Promise<UiDispatchResult> {
  if (isMutatingCommand(intent.command) && !intent.operationId) {
    return {
      kind: 'error',
      code: 'OPERATION_ID_REQUIRED',
      message: `${intent.command} requires operationId`,
      retryable: false,
    }
  }
  if (intent.command === 'approve' || intent.command === 'reject') {
    return dispatchInteractionCommand(intent, context)
  }
  if (intent.command === 'automate') return dispatchAutomationCommand(intent, context)
  if (intent.command === 'help') return { kind: 'accepted', revision: context.app.state().revision }
  if (intent.command === 'quit') {
    return dispatchCoreIntent({ type: 'shutdown', operationId: intent.operationId ?? '' }, context)
  }
  if (intent.command === 'cancel') {
    return dispatchCoreIntent(
      { type: 'cancel-run', operationId: intent.operationId ?? '' },
      context,
    )
  }
  if (
    intent.command === 'detach' ||
    intent.command === 'reconnect' ||
    intent.command === 'reconcile'
  ) {
    const state = context.app.state()
    const runId =
      intent.args[0] ??
      (intent.command === 'detach'
        ? (state.activeRunId ?? undefined)
        : [...state.runs]
            .reverse()
            .find(
              (run) =>
                (run.status === 'detached' ||
                  run.status === 'reconnecting' ||
                  run.status === 'unknown') &&
                (run.controlRef !== undefined ||
                  run.receipt.nativeContextBoundaryProof !== undefined),
            )?.id)
    if (runId === undefined) {
      return {
        kind: 'error',
        code: 'UNKNOWN_RUN',
        message:
          intent.command === 'detach'
            ? 'There is no active run to detach'
            : `There is no recoverable run to ${intent.command}`,
        retryable: false,
      }
    }
    return dispatchHeadlessCommand(
      {
        type: 'headless-command',
        command: intent.command,
        operationId: intent.operationId ?? '',
        params: { runId },
      },
      context,
    )
  }
  if (intent.command === 'graph' || intent.command === 'activity') {
    return dispatchCoreIntent(
      {
        type: 'open-surface',
        surface: intent.command,
        ...(intent.command === 'graph' && intent.args.length > 0
          ? { query: intent.args.join(' ') }
          : {}),
      },
      context,
    )
  }
  if (intent.command === 'fork' && context.fixture === 'fork') {
    return dispatchCoreIntent({ type: 'open-surface', surface: 'fork' }, context)
  }
  const conversationResult = await dispatchConversationRunCommand(intent, context)
  if (conversationResult !== undefined) return conversationResult
  const availability = commandAvailability(intent.command, context.view().capabilities)
  if (!availability.available) {
    return {
      kind: 'unavailable',
      code: 'CAPABILITY_UNAVAILABLE',
      reason: availability.reason ?? 'Capability is unavailable',
    }
  }
  return { kind: 'accepted', revision: context.app.state().revision }
}

async function dispatchInteractionCommand(
  intent: Extract<BraidIntent, { readonly type: 'run-command' }>,
  context: UiDispatchContext,
): Promise<UiDispatchResult> {
  if (intent.command !== 'approve' && intent.command !== 'reject') {
    return {
      kind: 'error',
      code: 'INVALID_INTENT',
      message: `Unsupported interaction command ${intent.command}`,
      retryable: false,
    }
  }
  const interaction = selectInteraction(context.view().interactions, intent.args)
  if (interaction === undefined) {
    return {
      kind: 'error',
      code: 'NO_PENDING_INTERACTION',
      message: `No pending interaction matches ${intent.args[0] ?? 'the current operation'}`,
      retryable: false,
    }
  }
  const outcome = interactionOutcome(interaction.allowedOutcomes, intent.command, intent.args)
  if (outcome === undefined) {
    return {
      kind: 'unavailable',
      code: 'CAPABILITY_UNAVAILABLE',
      reason: `The pending interaction does not allow ${intent.command === 'approve' ? 'approval' : 'rejection'}`,
    }
  }
  return dispatchCoreIntent(
    {
      type: 'respond-interaction',
      operationId: intent.operationId ?? '',
      runId: interaction.runId,
      interactionId: interaction.interactionId,
      response: { outcome },
    },
    context,
  )
}

function selectInteraction(
  interactions: readonly InteractionView[],
  args: readonly string[],
): InteractionView | undefined {
  const reference = args[0]
  if (reference === undefined) return interactions[0]
  const position = Number(reference)
  if (Number.isInteger(position) && position > 0) return interactions[position - 1]
  return (
    interactions.find(
      (interaction) => interaction.interactionId === reference || interaction.runId === reference,
    ) ?? interactions[0]
  )
}

function interactionOutcome(
  allowed: readonly InteractionOutcome[],
  command: 'approve' | 'reject',
  args: readonly string[],
): InteractionOutcome | undefined {
  const candidates: readonly InteractionOutcome[] =
    command === 'approve'
      ? ['accept', 'once', 'session', 'persistent']
      : ['reject', 'deny', 'revise']
  const requested = args.find((arg) => candidates.includes(arg as InteractionOutcome))
  const preferred = requested ?? candidates[0]
  return (
    allowed.find((outcome) => outcome === preferred) ??
    allowed.find((outcome) => candidates.includes(outcome))
  )
}
