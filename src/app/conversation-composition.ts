import { canonicalDigest } from '../domain/canonical.js'
import type { BraidEvent } from '../domain/events.js'
import { parseConversationId, parseOperationId } from '../domain/ids.js'
import type { BraidState } from '../domain/state.js'
import type { StoragePort } from '../ports/storage.js'
import { ConversationActions } from './conversations.js'

export interface ConversationCompositionInput {
  readonly state: () => BraidState
  readonly now: () => string
  readonly commit: (event: BraidEvent) => Promise<void>
  readonly coordinate: <T>(
    input: { readonly operationId: string; readonly digest: string },
    action: () => Promise<T>,
  ) => Promise<T>
  readonly storage?: Pick<StoragePort, 'destroyConversation'>
}

export function createConversationActions(
  input: ConversationCompositionInput,
): ConversationActions {
  return new ConversationActions({
    state: input.state,
    now: input.now,
    commit: input.commit,
    coordinate: input.coordinate,
    ...(input.storage === undefined
      ? {}
      : {
          destroy: async (operation: {
            readonly conversationId: string
            readonly operationId: string
          }) => {
            const reason = 'User-requested conversation deletion'
            const request = {
              conversationId: operation.conversationId,
              reasonDigest: canonicalDigest(reason),
            }
            await input.storage?.destroyConversation({
              conversationId: parseConversationId(operation.conversationId),
              reason,
              operation: {
                operationId: parseOperationId(operation.operationId),
                kind: 'conversation-delete',
                request,
                requestDigest: canonicalDigest(request),
              },
            })
          },
        }),
  })
}
