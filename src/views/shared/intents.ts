import type { CommandName } from './command-table.js'
import type { HeadlessCommandName } from './headless-commands.js'

export type InteractionResponseValue =
  | { readonly outcome: string; readonly value?: string | number | boolean }
  | { readonly outcome: 'cancel' }

export type BraidIntent =
  | {
      readonly type: 'send'
      readonly operationId: string
      readonly text: string
      readonly conversationId?: string
      readonly branchId?: string
    }
  | { readonly type: 'set-draft'; readonly text: string }
  | { readonly type: 'queue'; readonly operationId: string; readonly text: string }
  | { readonly type: 'steer'; readonly operationId: string; readonly text: string }
  | { readonly type: 'cancel-run'; readonly operationId: string; readonly runId?: string }
  | {
      readonly type: 'respond-interaction'
      readonly operationId: string
      readonly runId: string
      readonly interactionId: string
      readonly response: InteractionResponseValue
    }
  | {
      readonly type: 'run-command'
      readonly operationId?: string
      readonly command: CommandName
      readonly args: readonly string[]
    }
  | {
      readonly type: 'headless-command'
      readonly command: HeadlessCommandName
      readonly operationId?: string
      readonly params: Readonly<Record<string, unknown>>
    }
  | {
      readonly type: 'open-surface'
      readonly surface: 'activity' | 'graph' | 'details' | 'fork' | 'help' | 'settings'
      readonly query?: string
    }
  | { readonly type: 'resize'; readonly columns: number; readonly rows: number }
  | { readonly type: 'shutdown'; readonly operationId: string }

export type UiDispatchResult =
  | {
      readonly kind: 'accepted'
      readonly operationId?: string
      readonly revision: number
      readonly replayed?: boolean
      readonly completion?: Promise<void>
    }
  | {
      readonly kind: 'unavailable'
      readonly code: 'CAPABILITY_UNAVAILABLE' | 'INVALID_INTENT'
      readonly reason: string
    }
  | {
      readonly kind: 'error'
      readonly code: string
      readonly message: string
      readonly retryable: boolean
    }

export interface UiEvent {
  readonly sequence: number
  readonly revision: number
  readonly kind: string
  readonly payload: Readonly<Record<string, unknown>>
}

export type UiSubscriber = (view: import('./models.js').BraidViewModel, event?: UiEvent) => void

export interface BraidUiController {
  view(): import('./models.js').BraidViewModel
  state(): import('./models.js').HeadlessState
  events(): readonly UiEvent[]
  initialize(workspace: string): Promise<UiDispatchResult>
  subscribe(subscriber: UiSubscriber): () => void
  dispatch(intent: BraidIntent): Promise<UiDispatchResult>
  waitForIdle(): Promise<import('./models.js').BraidViewModel>
}
