import type { BraidState, MessageStatus } from '../domain/state.js'
import type { InteractionCapabilities } from '../domain/interaction-state.js'
import { sanitizeTerminalText } from '../views/shared/sanitize.js'
import { buildInteractionViews, type InteractionViewModel } from '../views/shared/interaction.js'

const MAX_VISIBLE_MESSAGES = 200
const MAX_VISIBLE_MESSAGE_CHARS = 200_000

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
  readonly status: 'ready' | 'running' | 'waiting' | 'failed' | 'blocked' | 'aborted'
  readonly statusText: string
  readonly messages: readonly MessageView[]
  readonly hiddenMessageCount: number
  readonly interactions: readonly InteractionViewModel[]
}

function visibleTail(text: string): string {
  if (text.length <= MAX_VISIBLE_MESSAGE_CHARS) return text
  return `…\n${text.slice(-MAX_VISIBLE_MESSAGE_CHARS)}`
}

export function buildAppView(
  state: BraidState,
  capabilities?: InteractionCapabilities,
  now = new Date().toISOString(),
): AppView {
  const hiddenMessageCount = Math.max(0, state.messages.length - MAX_VISIBLE_MESSAGES)
  const messages = state.messages.slice(-MAX_VISIBLE_MESSAGES).map((message) => ({
    id: message.id,
    role: message.role,
    text: sanitizeTerminalText(visibleTail(message.text)),
    status: message.status,
  }))
  const fixture = state.profile.model?.default === 'fixture/deterministic'
  const latestRun = state.runs.at(-1)
  const interactions = buildInteractionViews(state, now, capabilities)
  const status = state.interactions.some(
    (interaction) => interaction.status === 'pending' || interaction.status === 'responding',
  )
    ? 'waiting'
    : state.activeRunId
      ? 'running'
      : latestRun?.status === 'failed'
        ? 'failed'
        : latestRun?.status === 'blocked'
          ? 'blocked'
          : latestRun?.status === 'aborted'
            ? 'aborted'
            : 'ready'
  const statusText =
    status === 'waiting'
      ? `${state.interactions.filter((interaction) => interaction.status === 'pending').length} interaction(s) waiting`
      : status === 'running'
        ? 'working'
        : status === 'failed'
          ? (latestRun?.error ?? state.lastError ?? 'failed')
          : status === 'blocked'
            ? 'blocked'
            : status === 'aborted'
              ? 'cancelled'
              : 'ready'

  return Object.freeze({
    revision: state.revision,
    profileName: sanitizeTerminalText(state.profile.name ?? 'Unnamed profile'),
    runner: sanitizeTerminalText(state.profile.harness ?? 'automatic'),
    model: sanitizeTerminalText(state.profile.model?.default ?? 'automatic'),
    connection: fixture ? 'deterministic fixture' : 'not connected',
    status,
    statusText: sanitizeTerminalText(statusText),
    messages: Object.freeze(messages),
    hiddenMessageCount,
    interactions,
  })
}
