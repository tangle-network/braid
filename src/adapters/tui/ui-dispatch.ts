import type { BraidIntent, UiDispatchResult } from '../../views/shared/intents.js'
import {
  dispatchProfileConnectionIntent,
  type ProfileConnectionDispatchServices,
} from './profile-connection-dispatch.js'
import { dispatchCommandIntent } from './ui-command-dispatch.js'
import { dispatchCoreIntent } from './ui-core-dispatch.js'
import type { UiDispatchContext } from './ui-dispatch-context.js'
import { errorResult } from './ui-dispatch-error.js'
import { dispatchHeadlessCommand } from './ui-headless-dispatch.js'
import { dispatchIntelligenceIntent } from './ui-intelligence-dispatch.js'

export type { UiDispatchContext } from './ui-dispatch-context.js'
export { errorResult } from './ui-dispatch-error.js'
export type { ProfileConnectionDispatchServices }

/** Coordinates the independent UI routing families without owning their operations. */
export async function dispatchIntent(
  intent: BraidIntent,
  context: UiDispatchContext,
): Promise<UiDispatchResult> {
  try {
    const profileConnectionResult = await dispatchProfileConnectionIntent(
      intent,
      context.profileConnections,
    )
    if (profileConnectionResult !== undefined) return profileConnectionResult

    if (intent.type === 'refresh-supervision') {
      const refreshResult = await dispatchIntelligenceIntent(intent, context)
      if (refreshResult === undefined) throw new Error('Supervision refresh was not dispatched')
      return refreshResult
    }

    const intelligenceResult = await dispatchIntelligenceIntent(intent, context)
    if (intelligenceResult !== undefined) return intelligenceResult

    if (intent.type === 'run-command') return await dispatchCommandIntent(intent, context)
    if (intent.type === 'headless-command') return await dispatchHeadlessCommand(intent, context)

    return await dispatchCoreIntent(intent, context)
  } catch (error) {
    return errorResult(error)
  }
}
