import type { CommandName } from './command-table.js'
import type { HeadlessCommandName } from './headless-commands.js'
import type { RunAdmissionReceipt } from '../../domain/receipts.js'

export type InteractionResponseValue =
  | {
      readonly outcome: string
      readonly value?: string | number | boolean
      readonly data?: Readonly<Record<string, string | number | boolean | readonly string[]>>
    }
  | { readonly outcome: 'cancel'; readonly data?: never }

export type BraidIntent =
  | {
      readonly type: 'send'
      readonly operationId: string
      readonly text: string
      readonly conversationId?: string
      readonly branchId?: string
    }
  | {
      readonly type: 'set-draft'
      readonly operationId: string
      readonly text: string
      readonly conversationId?: string
      readonly branchId?: string
    }
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
  | {
      readonly type: 'shutdown'
      readonly operationId: string
      readonly mode?: 'wait' | 'detach' | 'cancel'
    }

export type UiDispatchResult =
  | {
      readonly kind: 'accepted'
      readonly operationId?: string
      readonly revision: number
      readonly replayed?: boolean
      readonly runId?: string
      readonly control?:
        | 'cancel'
        | 'steer'
        | 'queue'
        | 'detach'
        | 'reconnect'
        | 'respond_interaction'
      readonly outcome?: 'accepted' | 'already-applied' | 'rejected' | 'unknown'
      readonly position?: number
      readonly admission?: RunAdmissionReceipt
      readonly completion?: Promise<void>
      readonly data?: unknown
      readonly notice?: string
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
