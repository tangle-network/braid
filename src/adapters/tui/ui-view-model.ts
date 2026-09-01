import { selectedRunConfiguration } from '../../app/effective-run-configuration.js'
import { profileModelSettings } from '../../app/profile-model-settings.js'
import { canonicalDigest } from '../../domain/canonical.js'
import { activeRunForBranch, type BraidState } from '../../domain/state.js'
import { type ColorMode, resolveColorMode } from '../../views/shared/appearance.js'
import { environmentView } from '../../views/shared/environment-presentation.js'
import { type BraidViewModel, freezeView } from '../../views/shared/models.js'
import { sanitizeTerminalText } from '../../views/shared/sanitize.js'
import { queryGraph } from '../../views/shared/semantic-graph.js'
import { sessionUsageFor, usageForRun } from '../../views/shared/usage-projection.js'
import { capabilityMap } from './ui-capabilities.js'
import { entityDetailsFor } from './ui-entity-details.js'
import {
  activityFor,
  graphFor,
  interactionViews,
  MAX_VISIBLE_MESSAGES,
  messagesFor,
  queueViews,
  runViews,
  statusFor,
  workStripFor,
} from './ui-projection.js'
import { uiSemanticState } from './ui-semantic-state.js'

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

interface ViewModelCacheEntry {
  readonly selectedSurface: BraidViewModel['selectedSurface']
  readonly color: ColorMode
  readonly highContrast: boolean
  readonly reducedMotion: boolean
  readonly canCancel: boolean
  readonly storageFailure: string | undefined
  readonly cleanupUncertain: string | undefined
  readonly canRespond: boolean
  readonly graphQuery: string
  readonly value: BraidViewModel
}

const semanticViewCache = new WeakMap<
  BraidState,
  { readonly graphQuery: string; readonly projection: SemanticViewProjection }
>()
/*
 * State identity changes on every durable revision, so one completed view is safe to retain.
 * Pending interactions contain wall-clock countdowns, so those views must rebuild.
 */
const viewModelCache = new WeakMap<BraidState, ViewModelCacheEntry>()

function semanticViewFor(state: BraidState, graphQuery: string): SemanticViewProjection {
  const cached = semanticViewCache.get(state)
  if (cached?.graphQuery === graphQuery) return cached.projection
  const activity = Object.freeze(activityFor(state))
  const bounded = uiSemanticState(state)
  const semanticGraph = queryGraph(bounded.state, { query: graphQuery })
  const projection = Object.freeze({
    activity,
    graph: Object.freeze(graphFor(bounded.state, semanticGraph)),
    entityDetails: Object.freeze(entityDetailsFor(state, activity)),
    hiddenGraphNodeCount: bounded.hiddenNodeCount,
  })
  semanticViewCache.set(state, { graphQuery, projection })
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
  graphQuery = '',
): BraidViewModel {
  const color =
    appearance.color === undefined ? ('truecolor' as const) : resolveColorMode(appearance.color)
  const highContrast = appearance.highContrast ?? false
  const reducedMotion = appearance.reducedMotion ?? false
  const hasPendingInteraction = state.runs.some((run) =>
    run.interactions.some((interaction) => interaction.status === 'pending'),
  )
  const cached = viewModelCache.get(state)
  if (
    cached !== undefined &&
    !hasPendingInteraction &&
    cached.selectedSurface === selectedSurface &&
    cached.color === color &&
    cached.highContrast === highContrast &&
    cached.reducedMotion === reducedMotion &&
    cached.canCancel === canCancel &&
    cached.storageFailure === storageFailure &&
    cached.cleanupUncertain === cleanupUncertain &&
    cached.canRespond === canRespond &&
    cached.graphQuery === graphQuery
  ) {
    return cached.value
  }
  const status = storageFailure ? ('storage-failure' as const) : statusFor(state)
  const latest = state.runs.at(-1)
  const latestUsage = latest === undefined ? undefined : usageForRun(latest)
  const configuration = selectedRunConfiguration(state, state.profile)
  const profile = configuration.profile
  const modelSettings = profileModelSettings(profile)
  const fixture = profile.model?.default === 'fixture/deterministic'
  const profileDigest = canonicalDigest(profile)
  const selectedConnection = state.connections.find(
    (connection) => String(connection.id) === configuration.connectionId,
  )
  const selectedConversation = state.conversations.find(
    (conversation) => conversation.id === state.conversationId,
  )
  const selectedBranch = state.branches.find((branch) => branch.id === state.branchId)
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
  const semantic = semanticViewFor(state, graphQuery)
  const selectedActiveRun = activeRunForBranch(state, state.conversationId, state.branchId)
  const workStrip = workStripFor(state)
  const view = freezeView({
    revision: state.revision,
    workspace: state.workspace ? sanitizeTerminalText(state.workspace) : null,
    profileName: sanitizeTerminalText(profile.name ?? 'Unnamed profile'),
    profileDigest,
    runner: sanitizeTerminalText(profile.harness ?? 'automatic'),
    model: sanitizeTerminalText(model),
    ...(profile.model?.reasoningEffort
      ? { effort: sanitizeTerminalText(profile.model.reasoningEffort) }
      : {}),
    runOverrides: Object.freeze({
      ...(selectedBranch?.overrides.runner === undefined
        ? {}
        : { runner: sanitizeTerminalText(selectedBranch.overrides.runner) }),
      ...(selectedBranch?.overrides.model === undefined
        ? {}
        : { model: sanitizeTerminalText(selectedBranch.overrides.model) }),
      ...(selectedBranch?.overrides.effort === undefined
        ? {}
        : { effort: sanitizeTerminalText(selectedBranch.overrides.effort) }),
      ...(selectedBranch?.overrides.mode === undefined
        ? {}
        : { mode: sanitizeTerminalText(selectedBranch.overrides.mode) }),
    }),
    ...(modelSettings.maxVisibleOutputTokens === undefined
      ? {}
      : { maxVisibleOutputTokens: modelSettings.maxVisibleOutputTokens }),
    ...(modelSettings.maxReasoningTokens === undefined
      ? {}
      : { maxReasoningTokens: modelSettings.maxReasoningTokens }),
    ...(modelSettings.maxTotalOutputTokens === undefined
      ? {}
      : { maxTotalOutputTokens: modelSettings.maxTotalOutputTokens }),
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
    ...(selectedActiveRun ? { activeRunId: selectedActiveRun.id } : {}),
    ...(state.focusedRunId ? { focusedRunId: state.focusedRunId } : {}),
    ...(workStrip === undefined ? {} : { workStrip }),
    interactions: Object.freeze(interactionViews(state)),
    activity: semantic.activity,
    graph: semantic.graph,
    graphQuery,
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
              ...(latestUsage?.tokenStatus === undefined || latestUsage.tokenStatus === 'unknown'
                ? []
                : [{ label: 'token measurement', value: latestUsage.tokenStatus }]),
              ...(latestUsage?.costStatus === undefined || latestUsage.costStatus === 'unknown'
                ? []
                : [{ label: 'cost measurement', value: latestUsage.costStatus }]),
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
      highContrast,
      reducedMotion,
    }),
  })
  if (!hasPendingInteraction) {
    viewModelCache.set(state, {
      selectedSurface,
      color,
      highContrast,
      reducedMotion,
      canCancel,
      storageFailure,
      cleanupUncertain,
      canRespond,
      graphQuery,
      value: view,
    })
  }
  return view
}
