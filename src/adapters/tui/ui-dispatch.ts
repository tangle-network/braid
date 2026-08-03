import type { BraidApplication, AppError } from '../../app/application.js'
import type { BraidIntent, UiDispatchResult, UiSubscriber } from '../../views/shared/intents.js'
import { commandAvailability, isMutatingCommand } from '../../views/shared/command-registry.js'
import {
  capabilityForHeadlessCommand,
  isMutatingHeadlessCommand,
} from '../../views/shared/headless-commands.js'
import type { BraidViewModel } from '../../views/shared/models.js'
import { redactSensitiveText } from '../../views/shared/sanitize.js'
import { FIXTURE_INTERACTION, UNSUPPORTED, type UiFixture } from './ui-capabilities.js'

export interface UiDispatchContext {
  readonly app: BraidApplication
  readonly fixture: UiFixture | undefined
  readonly subscribers: ReadonlySet<UiSubscriber>
  readonly view: () => BraidViewModel
  readonly notify: () => void
  readonly interactionResolved: () => boolean
  markInteractionResolved(): void
  setSelectedSurface(surface: BraidViewModel['selectedSurface']): void
}

export function errorResult(error: unknown): UiDispatchResult {
  const typed = error as Partial<AppError>
  if (typeof typed.code === 'string' && typeof typed.message === 'string') {
    return {
      kind: 'error',
      code: typed.code,
      message: redactSensitiveText(typed.message),
      retryable: false,
    }
  }
  return {
    kind: 'error',
    code: 'INTERNAL_ERROR',
    message: redactSensitiveText(error instanceof Error ? error.message : 'Internal error'),
    retryable: false,
  }
}

export async function dispatchIntent(
  intent: BraidIntent,
  context: UiDispatchContext,
): Promise<UiDispatchResult> {
  try {
    switch (intent.type) {
      case 'send': {
        const receipt = context.app.send({
          operationId: intent.operationId,
          text: intent.text,
          ...(intent.conversationId ? { conversationId: intent.conversationId } : {}),
          ...(intent.branchId ? { branchId: intent.branchId } : {}),
        })
        return {
          kind: 'accepted',
          operationId: receipt.operationId,
          revision: receipt.revision,
          replayed: receipt.replayed,
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
        const receipt = context.app.cancel({
          operationId: intent.operationId,
          ...(intent.runId ? { runId: intent.runId } : {}),
        })
        return {
          kind: 'accepted',
          operationId: receipt.operationId,
          revision: receipt.revision,
          replayed: receipt.replayed,
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
        const receipt = context.app.shutdown({ operationId: intent.operationId })
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
      case 'set-draft':
        return {
          kind: 'unavailable',
          code: 'CAPABILITY_UNAVAILABLE',
          reason: 'Draft persistence is not exposed by the current application core',
        }
      case 'respond-interaction':
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
        return {
          kind: 'unavailable',
          code: 'CAPABILITY_UNAVAILABLE',
          reason:
            UNSUPPORTED['interaction.respond'] ??
            'The current application core does not expose this operation',
        }
      case 'queue':
      case 'steer':
        return {
          kind: 'unavailable',
          code: 'CAPABILITY_UNAVAILABLE',
          reason:
            UNSUPPORTED[intent.type === 'queue' ? 'run.queue' : 'run.steer'] ??
            'The current application core does not expose this operation',
        }
      case 'run-command': {
        if (isMutatingCommand(intent.command) && !intent.operationId) {
          return {
            kind: 'error',
            code: 'OPERATION_ID_REQUIRED',
            message: `${intent.command} requires operationId`,
            retryable: false,
          }
        }
        if (intent.command === 'help')
          return { kind: 'accepted', revision: context.app.state().revision }
        if (intent.command === 'quit') {
          if (!intent.operationId) {
            return {
              kind: 'error',
              code: 'OPERATION_ID_REQUIRED',
              message: 'quit requires operationId',
              retryable: false,
            }
          }
          return dispatchIntent({ type: 'shutdown', operationId: intent.operationId }, context)
        }
        if (intent.command === 'cancel') {
          if (!intent.operationId) {
            return {
              kind: 'error',
              code: 'OPERATION_ID_REQUIRED',
              message: 'cancel requires operationId',
              retryable: false,
            }
          }
          return dispatchIntent({ type: 'cancel-run', operationId: intent.operationId }, context)
        }
        if (intent.command === 'graph' || intent.command === 'activity') {
          return dispatchIntent({ type: 'open-surface', surface: intent.command }, context)
        }
        if (intent.command === 'fork' && context.fixture === 'fork') {
          return dispatchIntent({ type: 'open-surface', surface: 'fork' }, context)
        }
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
      case 'headless-command': {
        if (isMutatingHeadlessCommand(intent.command) && !intent.operationId) {
          return {
            kind: 'error',
            code: 'OPERATION_ID_REQUIRED',
            message: `${intent.command} requires operationId`,
            retryable: false,
          }
        }
        if (intent.command === 'get_graph')
          return dispatchIntent({ type: 'open-surface', surface: 'graph' }, context)
        if (intent.command === 'get_activity')
          return dispatchIntent({ type: 'open-surface', surface: 'activity' }, context)
        if (intent.command === 'get_details')
          return dispatchIntent({ type: 'open-surface', surface: 'details' }, context)
        if (intent.command === 'cancel_run') {
          if (!intent.operationId) {
            return {
              kind: 'error',
              code: 'OPERATION_ID_REQUIRED',
              message: 'cancel_run requires operationId',
              retryable: false,
            }
          }
          return dispatchIntent(
            {
              type: 'cancel-run',
              operationId: intent.operationId,
              ...(typeof intent.params.runId === 'string' ? { runId: intent.params.runId } : {}),
            },
            context,
          )
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
          return dispatchIntent(
            {
              type: 'send',
              operationId: intent.operationId,
              text,
              ...(typeof intent.params.conversationId === 'string'
                ? { conversationId: intent.params.conversationId }
                : {}),
              ...(typeof intent.params.branchId === 'string'
                ? { branchId: intent.params.branchId }
                : {}),
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
      default: {
        const exhaustive: never = intent
        return exhaustive
      }
    }
  } catch (error) {
    return errorResult(error)
  }
}
