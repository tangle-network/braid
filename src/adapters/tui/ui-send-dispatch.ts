import type { BraidApplication } from '../../app/application.js'
import { ConversationOperationCoordinator } from '../../app/conversation-operation-coordinator.js'
import { AppError } from '../../app/errors.js'
import { resolveConversationTarget, resolveRunTarget } from '../../app/run-targets.js'
import { canonicalDigest } from '../../domain/canonical.js'
import type { BraidIntent, UiDispatchResult } from '../../views/shared/intents.js'

type RunInputIntent = Extract<BraidIntent, { type: 'send' | 'queue' }>
const inputs = new WeakMap<BraidApplication, ConversationOperationCoordinator>()

/** Coalesce boundary/admission writes, not the lifetime of the resulting run. */
export function dispatchRunInput(
  intent: RunInputIntent,
  app: BraidApplication,
): Promise<UiDispatchResult> {
  let coordinator = inputs.get(app)
  if (coordinator === undefined) {
    coordinator = new ConversationOperationCoordinator()
    inputs.set(app, coordinator)
  }
  const state = app.state()
  const previous = state.runs.find((run) => run.operationId === intent.operationId)
  const resolved =
    intent.type === 'send'
      ? { ...intent, ...resolveConversationTarget(state, intent, previous) }
      : intent
  const replayed = coordinator.has(intent.operationId)
  return coordinator
    .run(intent.operationId, canonicalDigest(resolved), () =>
      resolved.type === 'send'
        ? sendResolved(resolved, app, previous !== undefined)
        : queueResolved(resolved, app),
    )
    .then((result) =>
      replayed && result.kind === 'accepted' ? { ...result, replayed: true } : result,
    )
}

async function sendResolved(
  intent: Extract<BraidIntent, { type: 'send' }>,
  app: BraidApplication,
  replay: boolean,
): Promise<UiDispatchResult> {
  const continuationRunId = replay ? undefined : app.nativeContinuationRunId(intent)
  const receipt =
    continuationRunId === undefined
      ? app.send(intent)
      : await app.continueNative({
          operationId: intent.operationId,
          text: intent.text,
          runId: continuationRunId,
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

async function queueResolved(
  intent: Extract<BraidIntent, { type: 'queue' }>,
  app: BraidApplication,
): Promise<UiDispatchResult> {
  // A consumed queue entry is still an acknowledged operation, not a fresh enqueue.
  const original = app
    .events()
    .map((envelope) => envelope.event)
    .find((event) => event.kind === 'run.queue.added' && event.operationId === intent.operationId)
  if (original?.kind === 'run.queue.added') {
    resolveRunTarget(app.state(), intent, original.runId)
    if (original.text !== intent.text)
      throw new AppError(
        'OPERATION_CONFLICT',
        'The queue operation is already bound to different input',
      )
    await app.whenDurable()
    return {
      kind: 'accepted',
      operationId: intent.operationId,
      runId: original.runId,
      control: 'queue',
      position: original.position,
      revision: app.state().revision,
      replayed: true,
    }
  }
  const receipt = app.queueInput(intent)
  if (receipt.completion !== undefined) await receipt.completion
  return {
    kind: 'accepted',
    operationId: receipt.operationId,
    runId: receipt.runId,
    control: 'queue',
    position: receipt.position,
    revision: receipt.revision,
    ...(receipt.completion === undefined ? {} : { completion: receipt.completion }),
  }
}
