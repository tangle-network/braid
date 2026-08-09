import type { RuntimeEventSummary } from '../domain/runtime-events.js'
import type {
  BraidMessagePart,
  BraidState,
  MessagePartKind,
  MessageRole,
  MessageStatus,
} from '../domain/state.js'
import { boundVisibleText, sanitizeTerminalText } from '../views/shared/sanitize.js'

const MAX_VISIBLE_MESSAGES = 200
const MAX_VISIBLE_PARTS = 512
const MAX_VISIBLE_PART_CHARS = 32_000

export interface MessageView {
  readonly id: string
  readonly role: MessageRole
  readonly text: string
  readonly status: MessageStatus
  readonly parts: readonly MessagePartView[]
}

export interface MessagePartView {
  readonly id: string
  readonly kind: MessagePartKind
  readonly text: string
  readonly status?: string
  readonly toolName?: string
  readonly title?: string
}

export interface AppView {
  readonly revision: number
  readonly profileName: string
  readonly runner: string
  readonly model: string
  readonly connection: string
  readonly status:
    | 'ready'
    | 'running'
    | 'failed'
    | 'blocked'
    | 'aborted'
    | 'cancelled'
    | 'unknown'
    | 'expired'
    | 'detached'
    | 'reconnecting'
    | 'cancelling'
  readonly statusText: string
  readonly messages: readonly MessageView[]
  readonly hiddenMessageCount: number
  readonly activities: readonly {
    readonly id: string
    readonly type: string
    readonly label: string
    readonly detail?: string
  }[]
  readonly eventDetails: readonly RuntimeEventSummary[]
}

function visibleTail(text: string): string {
  return boundVisibleText(text)
}

function detailText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return '[unavailable]'
  }
}

function partView(part: BraidMessagePart, visibleText?: string): MessagePartView {
  const detail = part.text ?? part.error ?? (part.result === undefined ? part.input : part.result)
  return {
    id: part.id,
    kind: part.kind,
    text: visibleText ?? visibleTail(detailText(detail).slice(0, MAX_VISIBLE_PART_CHARS)),
    ...(part.status === undefined ? {} : { status: sanitizeTerminalText(part.status) }),
    ...(part.toolName === undefined ? {} : { toolName: sanitizeTerminalText(part.toolName) }),
    ...(part.title === undefined ? {} : { title: sanitizeTerminalText(part.title) }),
  }
}

export function buildAppView(state: BraidState): AppView {
  const hiddenMessageCount = Math.max(0, state.messages.length - MAX_VISIBLE_MESSAGES)
  const messages = state.messages.slice(-MAX_VISIBLE_MESSAGES).map((message) => {
    const text = visibleTail(message.text)
    return {
      id: message.id,
      role: message.role,
      text,
      status: message.status,
      parts: Object.freeze(
        message.parts
          .slice(-MAX_VISIBLE_PARTS)
          .map((part) =>
            partView(part, part.kind === 'text' && part.text === message.text ? text : undefined),
          ),
      ),
    }
  })
  const fixture = state.profile.model?.default === 'fixture/deterministic'
  const latestRun = state.runs.at(-1)
  const activities =
    latestRun?.activity.slice(-MAX_VISIBLE_PARTS).map((item) => ({
      id: item.id,
      type: item.type,
      label: sanitizeTerminalText(item.label),
      ...(item.detail === undefined ? {} : { detail: sanitizeTerminalText(item.detail) }),
    })) ?? []
  const status = state.activeRunId
    ? latestRun?.status === 'reconnecting'
      ? 'reconnecting'
      : latestRun?.status === 'cancelling'
        ? 'cancelling'
        : 'running'
    : latestRun?.status === 'failed'
      ? 'failed'
      : latestRun?.status === 'blocked'
        ? 'blocked'
        : latestRun?.status === 'aborted'
          ? 'aborted'
          : latestRun?.status === 'cancelled'
            ? 'cancelled'
            : latestRun?.status === 'unknown'
              ? 'unknown'
              : latestRun?.status === 'expired'
                ? 'expired'
                : latestRun?.status === 'detached'
                  ? 'detached'
                  : 'ready'
  const statusText =
    status === 'running' || status === 'reconnecting'
      ? 'working'
      : status === 'cancelling'
        ? 'cancelling'
        : status === 'failed'
          ? (latestRun?.error ?? state.lastError ?? 'failed')
          : status === 'blocked'
            ? 'blocked'
            : status === 'aborted' || status === 'cancelled'
              ? 'cancelled'
              : status === 'unknown'
                ? 'unknown'
                : status === 'expired'
                  ? 'expired'
                  : status === 'detached'
                    ? 'background'
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
    activities: Object.freeze(activities),
    eventDetails: Object.freeze(latestRun?.eventDetails.slice(-MAX_VISIBLE_PARTS) ?? []),
  })
}
