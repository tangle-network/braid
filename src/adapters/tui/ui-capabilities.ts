import type { BraidState } from '../../domain/state.js'
import type { CapabilityMap } from '../../views/shared/models.js'
import type { UiFixture } from './ui-fixtures.js'

export const UNSUPPORTED: Readonly<Record<string, string>> = Object.freeze({
  'conversation.create': 'Conversation creation is not exposed by the current application core',
  'conversation.open': 'Conversation search is not exposed by the current application core',
  'run.runner': 'Runner overrides require the current profile compatibility helpers',
  'run.model': 'Model overrides require provider capabilities from the current connection',
  'run.effort': 'Effort overrides require provider capabilities from the current connection',
  'conversation.branch': 'Branch creation is not exposed by the current application core',
  'conversation.clone': 'Conversation cloning is not exposed by the current application core',
  'conversation.fork': 'Fork planning requires the current conversation and environment graph',
  'analysis.ask': 'Trace analysis requires the current agent-eval adapter',
  'analysis.recipe': 'Trace analysis recipes require the current agent-eval adapter',
  'analysis.compare': 'Comparisons require the current agent-eval adapter',
  'interaction.respond': 'Interaction response is not exposed by the current runtime adapter',
  'interaction.automation': 'Interaction automation requires the shared response contract',
  'export.create': 'Redacted export is not exposed by the current storage adapter',
})

export function capabilityMap(
  state: BraidState,
  canCancel = true,
  fixture?: UiFixture,
): CapabilityMap {
  const active = state.activeRunId !== null
  const deterministicFixture = state.profile.model?.default === 'fixture/deterministic'
  const capabilities: Record<
    string,
    {
      available: boolean
      source: 'provider' | 'runtime' | 'application' | 'local'
      reason?: string
    }
  > = {}
  for (const [key, reason] of Object.entries(UNSUPPORTED)) {
    capabilities[key] = { available: false, source: 'application', reason }
  }
  const completedRuns = state.runs.filter(
    (run) => run.complete && (run.status === 'completed' || run.status === 'failed'),
  )
  const analysisReason =
    state.workspace === null
      ? 'Initialize a workspace before analyzing a run'
      : completedRuns.length === 0
        ? 'Complete or fail a run before analyzing it'
        : undefined
  capabilities['analysis.ask'] = analysisReason
    ? { available: false, source: 'application', reason: analysisReason }
    : { available: true, source: 'application' }
  capabilities['analysis.recipe'] = analysisReason
    ? { available: false, source: 'application', reason: analysisReason }
    : { available: true, source: 'application' }
  capabilities['analysis.compare'] =
    completedRuns.length < 2
      ? {
          available: false,
          source: 'application',
          reason: 'Two completed or failed runs are required for comparison',
        }
      : { available: true, source: 'application' }
  capabilities['application.quit'] = { available: true, source: 'local' }
  capabilities['help.read'] = { available: true, source: 'local' }
  capabilities['profile.select'] = { available: true, source: 'application' }
  capabilities['connection.select'] = { available: true, source: 'application' }
  capabilities['settings.open'] = { available: true, source: 'application' }
  capabilities['activity.read'] = { available: true, source: 'local' }
  capabilities['graph.read'] = { available: true, source: 'local' }
  capabilities['details.read'] = { available: true, source: 'local' }
  capabilities['draft.write'] =
    state.workspace === null
      ? {
          available: false,
          source: 'application',
          reason: 'Initialize a workspace before editing a draft',
        }
      : { available: true, source: 'application' }
  const conversationsAvailable = state.workspace !== null && !active
  for (const capability of [
    'conversation.create',
    'conversation.open',
    'conversation.branch',
    'conversation.clone',
    'conversation.fork',
    'export.create',
  ]) {
    capabilities[capability] = conversationsAvailable
      ? { available: true, source: 'application' }
      : {
          available: false,
          source: 'application',
          reason:
            state.workspace === null
              ? 'Initialize a workspace first'
              : 'Finish or cancel the active run first',
        }
  }
  capabilities['run.send'] =
    state.workspace !== null && !active && deterministicFixture
      ? { available: true, source: 'provider' }
      : {
          available: false,
          source: 'application',
          reason: active
            ? 'A run is already active'
            : state.workspace === null
              ? 'Initialize a workspace before sending'
              : 'Configure a connection before sending',
        }
  capabilities['run.cancel'] =
    active && canCancel
      ? { available: true, source: 'runtime' }
      : {
          available: false,
          source: 'runtime',
          reason: active
            ? 'The current runtime does not acknowledge provider cancellation'
            : 'There is no active run to cancel',
        }
  const activeRun = state.activeRunId
    ? state.runs.find((run) => run.id === state.activeRunId)
    : undefined
  capabilities['run.queue'] = activeRun?.capabilities.controls.queue
    ? { available: true, source: 'provider' }
    : {
        available: false,
        source: 'provider',
        reason: active
          ? 'The current runtime does not report queued input support'
          : 'There is no active run',
      }
  capabilities['run.steer'] = activeRun?.capabilities.controls.steer
    ? { available: true, source: 'provider' }
    : {
        available: false,
        source: 'provider',
        reason: active
          ? 'The current runtime does not report steering support'
          : 'There is no active run',
      }
  capabilities['run.detach'] = activeRun?.capabilities.streaming.detach
    ? { available: true, source: 'provider' }
    : {
        available: false,
        source: 'provider',
        reason: active
          ? 'The current runtime does not report detach support'
          : 'There is no active run',
      }
  capabilities['run.reconnect'] = activeRun?.capabilities.streaming.replay
    ? { available: true, source: 'provider' }
    : {
        available: false,
        source: 'provider',
        reason: active
          ? 'The current runtime does not report replay support'
          : 'There is no active run',
      }
  capabilities['run.reconcile'] = activeRun?.capabilities.controls.status
    ? { available: true, source: 'provider' }
    : {
        available: false,
        source: 'provider',
        reason: active
          ? 'The current runtime does not report status reconciliation'
          : 'There is no active run',
      }
  if (fixture === 'interaction') {
    capabilities['interaction.respond'] = { available: true, source: 'provider' }
  }
  if (fixture === 'fork') {
    capabilities['conversation.fork'] = { available: true, source: 'provider' }
  }
  if (fixture === 'analysis') {
    capabilities['analysis.ask'] = { available: true, source: 'application' }
  }
  if (fixture === 'comparison') {
    capabilities['analysis.compare'] = { available: true, source: 'application' }
  }
  return Object.freeze(capabilities)
}
