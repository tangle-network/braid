import type { AgentProfile } from '@tangle-network/agent-interface'
import { canonicalDigest } from '../../domain/canonical.js'
import type { BraidState } from '../../domain/state.js'
import { type ColorMode, resolveColorMode } from '../../views/shared/appearance.js'
import { type BraidViewModel, freezeView } from '../../views/shared/models.js'
import { sanitizeTerminalText } from '../../views/shared/sanitize.js'
import { queryGraph } from '../../views/shared/semantic-graph.js'
import { sessionUsageFor, usageForRun } from '../../views/shared/usage-projection.js'
import { environmentView } from '../../views/shared/environment-presentation.js'
import { capabilityMap } from './ui-capabilities.js'
import { entityDetailsFor } from './ui-entity-details.js'
import { uiSemanticState } from './ui-semantic-state.js'
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

interface SemanticViewProjection {
  readonly activity: BraidViewModel['activity']
  readonly graph: BraidViewModel['graph']
  readonly entityDetails: NonNullable<BraidViewModel['entityDetails']>
  readonly hiddenGraphNodeCount: number
}

const semanticViewCache = new WeakMap<BraidState, SemanticViewProjection>()

function semanticViewFor(state: BraidState): SemanticViewProjection {
  const cached = semanticViewCache.get(state)
  if (cached !== undefined) return cached
  const activity = Object.freeze(activityFor(state))
  const bounded = uiSemanticState(state)
  const semanticGraph = queryGraph(bounded.state)
  const projection = Object.freeze({
    activity,
    graph: Object.freeze(graphFor(bounded.state, semanticGraph)),
    entityDetails: Object.freeze(entityDetailsFor(state, activity)),
    hiddenGraphNodeCount: bounded.hiddenNodeCount,
  })
  semanticViewCache.set(state, projection)
  return projection
}

export function buildBraidViewModel(
  state: BraidState,
  selectedSurface: BraidViewModel['selectedSurface'] = 'transcript',
  appearance: UiAppearanceOptions = {},
  canCancel = true,
  storageFailure?: string,
  cleanupUncertain?: string,
  canRespond = false,
): BraidViewModel {
  const status = storageFailure ? ('storage-failure' as const) : statusFor(state)
  const latest = state.runs.at(-1)
  const profile = state.profile as Readonly<AgentProfile>
  const fixture = profile.model?.default === 'fixture/deterministic'
  const profileDigest = canonicalDigest(profile)
  const selectedConnection = state.connections.find(
    (connection) => connection.id === state.selectedConnectionId,
  )
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
  const model = profile.model?.default ?? 'automatic'
  const color =
    appearance.color === undefined ? ('truecolor' as const) : resolveColorMode(appearance.color)
  const semantic = semanticViewFor(state)
  return freezeView({
    revision: state.revision,
    workspace: state.workspace ? sanitizeTerminalText(state.workspace) : null,
    profileName: sanitizeTerminalText(profile.name ?? 'Unnamed profile'),
    profileDigest,
    runner: sanitizeTerminalText(profile.harness ?? 'automatic'),
    model: sanitizeTerminalText(model),
    ...(profile.model?.reasoningEffort
      ? { effort: sanitizeTerminalText(profile.model.reasoningEffort) }
      : {}),
    connection: fixture
      ? 'deterministic fixture'
      : sanitizeTerminalText(selectedConnection?.name ?? 'not connected'),
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
    messages: Object.freeze(messagesFor(state, { completeText: true })),
    hiddenMessageCount: Math.max(0, state.messages.length - MAX_VISIBLE_MESSAGES),
    runs: Object.freeze(runViews(state)),
    sessionUsage: sessionUsageFor(state),
    environments: Object.freeze(state.environments.map(environmentView)),
    ...(state.activeRunId ? { activeRunId: state.activeRunId } : {}),
    interactions: Object.freeze(interactionViews(state)),
    activity: semantic.activity,
    graph: semantic.graph,
    entityDetails: semantic.entityDetails,
    ...(semantic.hiddenGraphNodeCount === 0
      ? {}
      : { hiddenGraphNodeCount: semantic.hiddenGraphNodeCount }),
    ...(latest
      ? {
          details: Object.freeze({
            title: `run ${latest.id}`,
            fields: Object.freeze([
              { label: 'status', value: latest.status },
              { label: 'input tokens', value: String(latest.inputTokens) },
              { label: 'output tokens', value: String(latest.outputTokens) },
              {
                label: 'token measurement',
                value: usageForRun(latest).tokenStatus ?? 'unknown',
              },
              {
                label: 'cost measurement',
                value: usageForRun(latest).costStatus ?? 'unknown',
              },
              ...(latest.model
                ? [{ label: 'model', value: sanitizeTerminalText(latest.model) }]
                : []),
            ]),
          }),
        }
      : {}),
    capabilities: capabilityMap(state, canCancel, undefined, canRespond),
    draft: sanitizeTerminalText(state.draft),
    selectedSurface,
    appearance: Object.freeze({
      color,
      highContrast: appearance.highContrast ?? false,
      reducedMotion: appearance.reducedMotion ?? false,
    }),
  })
}
