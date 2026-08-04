import type { AgentProfile } from '@tangle-network/agent-interface'
import { buildAppView } from '../../app/view-model.js'
import { canonicalDigest } from '../../domain/canonical.js'
import type { BraidState } from '../../domain/state.js'
import { type ColorMode, resolveColorMode } from '../../views/shared/appearance.js'
import { type BraidViewModel, freezeView } from '../../views/shared/models.js'
import { sanitizeTerminalText } from '../../views/shared/sanitize.js'
import { capabilityMap } from './ui-capabilities.js'
import {
  activityFor,
  graphFor,
  interactionViews,
  MAX_VISIBLE_MESSAGES,
  messagesFor,
  queueViews,
  runViews,
  statusFor,
} from './ui-projection.js'

export interface UiAppearanceOptions {
  readonly color?: ColorMode
  readonly highContrast?: boolean
  readonly reducedMotion?: boolean
}

export function buildBraidViewModel(
  state: BraidState,
  selectedSurface: BraidViewModel['selectedSurface'] = 'transcript',
  appearance: UiAppearanceOptions = {},
  canCancel = true,
  storageFailure?: string,
  cleanupUncertain?: string,
): BraidViewModel {
  const legacy = buildAppView(state)
  const status = storageFailure ? ('storage-failure' as const) : statusFor(state)
  const latest = state.runs.at(-1)
  const profile = state.profile as Readonly<AgentProfile>
  const profileDigest = canonicalDigest(profile)
  const selectedConversation = state.conversations.find(
    (conversation) => conversation.id === state.conversationId,
  )
  const statusText = storageFailure
    ? `storage failure: ${sanitizeTerminalText(storageFailure)}`
    : cleanupUncertain
      ? `cleanup uncertain: ${sanitizeTerminalText(cleanupUncertain)}`
      : state.lastError
        ? sanitizeTerminalText(state.lastError)
        : status === 'empty'
          ? 'ready for a message'
          : status === 'running'
            ? 'streaming'
            : status === 'completed'
              ? 'completed'
              : status === 'cancelled'
                ? 'cancelled'
                : status
  const model = profile.model?.default ?? legacy.model
  const color =
    appearance.color === undefined ? ('truecolor' as const) : resolveColorMode(appearance.color)
  return freezeView({
    revision: state.revision,
    workspace: state.workspace ? sanitizeTerminalText(state.workspace) : null,
    profileName: sanitizeTerminalText(legacy.profileName),
    profileDigest,
    runner: sanitizeTerminalText(legacy.runner),
    model: sanitizeTerminalText(model),
    ...(profile.model?.reasoningEffort
      ? { effort: sanitizeTerminalText(profile.model.reasoningEffort) }
      : {}),
    connection: sanitizeTerminalText(legacy.connection),
    conversationId: state.conversationId,
    conversationTitle: sanitizeTerminalText(selectedConversation?.title ?? 'New conversation'),
    conversations: Object.freeze(
      state.conversations
        .filter((conversation) => conversation.deletedAt === undefined)
        .map((conversation) => ({
          id: conversation.id,
          title: sanitizeTerminalText(conversation.title),
          branchId: conversation.activeBranchId,
          archived: conversation.archived,
          active: conversation.id === state.conversationId,
          updatedAt: conversation.updatedAt,
        })),
    ),
    branch: sanitizeTerminalText(state.branchId),
    status,
    statusText,
    queueCount: state.queuedInputs.length,
    queue: Object.freeze(queueViews(state)),
    ...(storageFailure === undefined
      ? {}
      : { storageFailure: sanitizeTerminalText(storageFailure) }),
    ...(cleanupUncertain === undefined
      ? {}
      : { cleanupUncertain: sanitizeTerminalText(cleanupUncertain) }),
    messages: Object.freeze(messagesFor(state)),
    hiddenMessageCount: Math.max(0, state.messages.length - MAX_VISIBLE_MESSAGES),
    runs: Object.freeze(runViews(state)),
    ...(state.activeRunId ? { activeRunId: state.activeRunId } : {}),
    interactions: Object.freeze(interactionViews(state)),
    activity: Object.freeze(activityFor(state)),
    graph: Object.freeze(graphFor(state)),
    ...(latest
      ? {
          details: Object.freeze({
            title: `run ${latest.id}`,
            fields: Object.freeze([
              { label: 'status', value: latest.status },
              { label: 'input tokens', value: String(latest.inputTokens) },
              { label: 'output tokens', value: String(latest.outputTokens) },
              ...(latest.model
                ? [{ label: 'model', value: sanitizeTerminalText(latest.model) }]
                : []),
            ]),
          }),
        }
      : {}),
    capabilities: capabilityMap(state, canCancel),
    draft: sanitizeTerminalText(state.draft),
    selectedSurface,
    appearance: Object.freeze({
      color,
      highContrast: appearance.highContrast ?? false,
      reducedMotion: appearance.reducedMotion ?? false,
    }),
  })
}
