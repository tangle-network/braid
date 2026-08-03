import type { InteractionView, CapabilityMap, ForkPreviewView } from '../../views/shared/models.js'
import type { BraidState } from '../../domain/state.js'

export const UNSUPPORTED: Readonly<Record<string, string>> = Object.freeze({
  'conversation.create': 'Conversation creation is not exposed by the current application core',
  'conversation.open': 'Conversation search is not exposed by the current application core',
  'profile.select': 'Profile catalog and editing are not exposed by the current application core',
  'connection.select': 'Connection setup is not exposed by the current application core',
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
  'run.queue': 'Queued turns are not exposed by the current application core',
  'run.steer': 'Live steering is not reported by the current runtime adapter',
  'export.create': 'Redacted export is not exposed by the current storage adapter',
  'settings.open': 'Settings persistence is not exposed by the current application core',
})

export type UiFixture = 'interaction' | 'fork'

export const FIXTURE_INTERACTION: InteractionView = Object.freeze({
  runId: 'fixture-run-1',
  interactionId: 'fixture-interaction-1',
  kind: 'permission',
  prompt: 'Allow the fixture tool to inspect the selected file?',
  subject: Object.freeze({
    type: 'file',
    title: 'src/app/application.ts',
    target: 'read-only',
    detail: 'The fixture requests a bounded read for a real interaction preview.',
    preview: Object.freeze(['export class BraidApplication {', '  cancel(input: CancelInput) { …']),
    trustedWorkspace: 'inside',
  }),
  answerSpec: Object.freeze({ kind: 'boolean', required: true }),
  allowedOutcomes: Object.freeze(['accept', 'reject', 'cancel'] as const),
  queuePosition: 0,
  secret: false,
})

export const FIXTURE_FORK: ForkPreviewView = Object.freeze({
  kind: 'workspace',
  source: 'workspace:/workspace',
  destination: 'workspace:/workspace-fork',
  fields: Object.freeze([
    {
      label: 'conversation context',
      source: 'conv-1 / branch-1',
      destination: 'conv-fork-1 / branch-1',
    },
    {
      label: 'profile snapshot',
      source: 'digest:fixture-source',
      destination: 'digest:fixture-copy',
    },
    {
      label: 'workspace state',
      source: 'checkpoint:fixture-1',
      destination: 'checkpoint:fixture-1',
    },
  ]),
  allowed: true,
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
  capabilities['application.quit'] = { available: true, source: 'local' }
  capabilities['help.read'] = { available: true, source: 'local' }
  capabilities['activity.read'] = { available: true, source: 'local' }
  capabilities['graph.read'] = { available: true, source: 'local' }
  capabilities['details.read'] = { available: true, source: 'local' }
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
  if (fixture === 'interaction') {
    capabilities['interaction.respond'] = { available: true, source: 'provider' }
  }
  if (fixture === 'fork') {
    capabilities['conversation.fork'] = { available: true, source: 'provider' }
  }
  return Object.freeze(capabilities)
}
