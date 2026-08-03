import type { BraidState, MessageStatus } from '../domain/state.js'
import { boundVisibleText, sanitizeTerminalText } from '../views/shared/sanitize.js'

const MAX_VISIBLE_MESSAGES = 200

export interface MessageView {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly status: MessageStatus
}

export interface AppView {
  readonly revision: number
  readonly profileName: string
  readonly runner: string
  readonly model: string
  readonly connection: string
  readonly status: 'ready' | 'running' | 'cancelling' | 'failed' | 'blocked' | 'aborted' | 'unknown'
  readonly statusText: string
  readonly messages: readonly MessageView[]
  readonly hiddenMessageCount: number
}

function visibleTail(text: string): string {
  return boundVisibleText(text)
}

export function buildAppView(state: BraidState): AppView {
  const hiddenMessageCount = Math.max(0, state.messages.length - MAX_VISIBLE_MESSAGES)
  const messages = state.messages.slice(-MAX_VISIBLE_MESSAGES).map((message) => ({
    id: message.id,
    role: message.role,
    text: sanitizeTerminalText(visibleTail(message.text)),
    status: message.status,
  }))
  const fixture = state.profile.model?.default === 'fixture/deterministic'
  const latestRun = state.runs.at(-1)
  const activeRun = state.activeRunId
    ? state.runs.find((run) => run.id === state.activeRunId)
    : undefined
  const status = activeRun
    ? activeRun.status === 'cancelling'
      ? 'cancelling'
      : 'running'
    : latestRun?.status === 'unknown'
      ? 'unknown'
      : latestRun?.status === 'failed'
        ? 'failed'
        : latestRun?.status === 'blocked'
          ? 'blocked'
          : latestRun?.status === 'aborted'
            ? 'aborted'
            : 'ready'
  const statusText =
    status === 'running'
      ? 'working'
      : status === 'cancelling'
        ? 'cancelling'
        : status === 'failed'
          ? (latestRun?.error ?? state.lastError ?? 'failed')
          : status === 'blocked'
            ? 'blocked'
            : status === 'aborted'
              ? 'cancelled'
              : status === 'unknown'
                ? 'unknown'
                : 'ready'

  return Object.freeze({
    revision: state.revision,
    profileName: state.profile.name ?? 'Unnamed profile',
    runner: state.profile.harness ?? 'automatic',
    model: state.profile.model?.default ?? 'automatic',
    connection: fixture ? 'deterministic fixture' : 'not connected',
    status,
    statusText: sanitizeTerminalText(statusText),
    messages: Object.freeze(messages),
    hiddenMessageCount,
  })
}
