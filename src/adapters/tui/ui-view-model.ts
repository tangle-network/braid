import type { AgentProfile } from '@tangle-network/agent-interface'
import { canonicalDigest } from '../../domain/canonical.js'
import type { BraidState } from '../../domain/state.js'
import { buildAppView } from '../../app/view-model.js'
import { freezeView, type BraidViewModel } from '../../views/shared/models.js'
import { sanitizeTerminalText } from '../../views/shared/sanitize.js'
import { capabilityMap } from './ui-capabilities.js'
import {
  activityFor,
  graphFor,
  MAX_VISIBLE_MESSAGES,
  messagesFor,
  runViews,
  statusFor,
} from './ui-projection.js'

export interface UiAppearanceOptions {
  readonly color?: BraidViewModel['appearance']['color']
  readonly highContrast?: boolean
  readonly reducedMotion?: boolean
}

export function buildBraidViewModel(
  state: BraidState,
  selectedSurface: BraidViewModel['selectedSurface'] = 'transcript',
  appearance: UiAppearanceOptions = {},
  canCancel = true,
): BraidViewModel {
  const legacy = buildAppView(state)
  const status = statusFor(state)
  const latest = state.runs.at(-1)
  const profile = state.profile as Readonly<AgentProfile>
  const profileDigest = canonicalDigest(profile)
  const statusText = state.lastError
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
    branch: sanitizeTerminalText(state.branchId),
    status,
    statusText,
    queueCount: 0,
    messages: Object.freeze(messagesFor(state)),
    hiddenMessageCount: Math.max(0, state.messages.length - MAX_VISIBLE_MESSAGES),
    runs: Object.freeze(runViews(state)),
    ...(state.activeRunId ? { activeRunId: state.activeRunId } : {}),
    interactions: Object.freeze([]),
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
      color: appearance.color ?? 'truecolor',
      highContrast: appearance.highContrast ?? false,
      reducedMotion: appearance.reducedMotion ?? false,
    }),
  })
}
