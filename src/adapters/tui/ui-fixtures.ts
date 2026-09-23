import type { BraidViewModel, InteractionView, ViewStatus } from '../../views/shared/models.js'
import { freezeView } from '../../views/shared/models.js'
import type { UiFixture } from './ui-capabilities.js'
import {
  activity,
  analysisView,
  connectionOptions,
  effortOptions,
  forkPreview,
  graph,
  messageSet,
  modelOptions,
  noticeFor,
  permission,
  profileOptions,
  question,
  runSet,
  runnerOptions,
  setup,
  statusTextFor,
} from './ui-fixture-data.js'

export function applyUiFixture(
  view: BraidViewModel,
  fixture: UiFixture,
  demoStage?: BraidViewModel['demoStage'],
): BraidViewModel {
  const mapped: Record<
    Exclude<UiFixture, 'demo'>,
    { status: ViewStatus; surface?: BraidViewModel['selectedSurface'] }
  > = {
    'first-run': { status: 'loading' },
    profile: { status: 'ready' },
    connection: { status: 'ready' },
    runner: { status: 'ready' },
    model: { status: 'ready' },
    effort: { status: 'ready' },
    ready: { status: 'ready' },
    streaming: { status: 'streaming' },
    interaction: { status: 'waiting' },
    permission: { status: 'waiting' },
    question: { status: 'waiting' },
    'fork-preview': { status: 'ready', surface: 'fork' },
    fork: { status: 'ready', surface: 'fork' },
    'fork-complete': { status: 'completed', surface: 'fork' },
    analysis: { status: 'completed', surface: 'analysis' },
    graph: { status: 'completed', surface: 'graph' },
    activity: { status: 'running', surface: 'activity' },
    reconnecting: { status: 'reconnecting' },
    failure: { status: 'failed' },
    cancelled: { status: 'cancelled' },
    unknown: { status: 'unknown' },
  }
  const selected = fixture === 'demo' ? demoFixtureStage(demoStage ?? 'profile') : mapped[fixture]
  const status = selected.status
  const interaction: InteractionView | undefined =
    fixture === 'question'
      ? question
      : fixture === 'interaction' ||
          fixture === 'permission' ||
          (fixture === 'demo' && demoStage === 'permission')
        ? permission
        : undefined
  const isSetup =
    ['first-run', 'profile', 'connection', 'runner', 'model', 'effort'].includes(fixture) ||
    (fixture === 'demo' &&
      ['profile', 'connection', 'runner', 'model', 'effort'].includes(demoStage ?? 'profile'))
  const setupValue = isSetup
    ? Object.freeze({
        ...setup,
        step:
          fixture === 'connection' || demoStage === 'connection'
            ? ('connection' as const)
            : ('review' as const),
      })
    : undefined
  const forkDone = fixture === 'fork-complete' || (fixture === 'demo' && demoStage === 'analysis')
  const result = forkDone
    ? Object.freeze({
        status: 'created' as const,
        kind: 'workspace' as const,
        source: forkPreview.source,
        destination: forkPreview.destination,
        receipt: 'env-fork-204 · checkpoint cp-88',
        detail: 'Independent workspace ready; source remains unchanged.',
      })
    : undefined
  const surface =
    selected.surface ??
    (fixture === 'demo' && demoStage === 'analysis' ? 'analysis' : view.selectedSurface)
  const notice = noticeFor(status)
  const selectedView = {
    ...view,
    conversationTitle: 'replay investigation',
    profileName: 'reviewer',
    profileDigest: 'sha256:91d2…',
    runner: 'pi',
    model: 'claude-sonnet',
    effort: 'high',
    connection: 'local / cli-bridge',
    branch: 'fix/replay',
    environment: 'local:/workspace',
    providerSession: 'pi-session-17',
    status,
    statusText: statusTextFor(status),
    elapsedMs: 37_000,
    queueCount: status === 'waiting' ? 1 : status === 'running' || status === 'streaming' ? 2 : 0,
    messages: messageSet(status),
    hiddenMessageCount: 2,
    runs: runSet(status),
    ...(status === 'streaming' ||
    status === 'running' ||
    status === 'waiting' ||
    status === 'cancelling'
      ? { activeRunId: 'run-review-17' }
      : {}),
    interactions: Object.freeze(interaction ? [interaction] : []),
    activity,
    graph,
    selectedNodeId: 'run-review-17',
    details: Object.freeze({
      title: 'replay proof',
      fields: Object.freeze([
        { label: 'run', value: 'run-review-17' },
        { label: 'provider session', value: 'pi-session-17' },
        { label: 'cursor', value: status === 'reconnecting' ? '18 · replaying' : '18 · committed' },
        { label: 'input / output', value: '8.4k / 1.2k tokens' },
        { label: 'cost / time', value: '$0.08 / 00:37' },
      ]),
    }),
    selectors: Object.freeze({
      profile: profileOptions,
      connection: connectionOptions,
      runner: runnerOptions,
      model: modelOptions,
      effort: effortOptions,
      graph: Object.freeze({
        id: 'graph',
        title: 'graph',
        query: '',
        loading: false,
        stale: false,
        selectedId: 'run-review-17',
        emptyMessage: 'No graph nodes.',
        items: graph.map((node) => ({
          id: node.id,
          label: node.title,
          description: `${node.type} · ${node.status}`,
        })),
      }),
    }),
    ...(setupValue ? { setup: setupValue } : {}),
    health: Object.freeze({
      status:
        status === 'loading'
          ? ('checking' as const)
          : status === 'failed'
            ? ('failed' as const)
            : ('healthy' as const),
      checkedAt: 'just now',
      checks: Object.freeze([
        {
          id: 'bridge',
          name: 'CLI Bridge',
          status: status === 'failed' ? ('failed' as const) : ('healthy' as const),
          detail:
            status === 'failed'
              ? 'connection refused · retry available'
              : 'loopback · interactive sessions',
        },
        {
          id: 'profile',
          name: 'Profile validation',
          status: 'healthy' as const,
          detail: 'reviewer · all required fields honored',
        },
        {
          id: 'workspace',
          name: 'Workspace',
          status: 'healthy' as const,
          detail: '/workspace · trusted',
        },
      ]),
      action: status === 'failed' ? 'retry health check' : 'refresh',
    }),
    ...(fixture === 'fork' ||
    fixture === 'fork-preview' ||
    fixture === 'fork-complete' ||
    fixture === 'demo'
      ? { forkPreview }
      : {}),
    ...(result ? { forkResult: result } : {}),
    ...(fixture === 'analysis' || (fixture === 'demo' && demoStage === 'analysis')
      ? { analysis: analysisView }
      : {}),
    ...(notice ? { notice } : {}),
    ...(fixture === 'demo'
      ? { demoStage: demoStage ?? 'profile' }
      : fixture === 'first-run'
        ? { demoStage: 'profile' as const }
        : fixture === 'profile' ||
            fixture === 'connection' ||
            fixture === 'runner' ||
            fixture === 'model' ||
            fixture === 'effort'
          ? { demoStage: fixture }
          : {}),
    selectedSurface: surface,
  }
  return freezeView(selectedView as BraidViewModel)
}

function demoFixtureStage(stage: NonNullable<BraidViewModel['demoStage']>): {
  status: ViewStatus
  surface?: BraidViewModel['selectedSurface']
} {
  if (stage === 'streaming') return { status: 'streaming' }
  if (stage === 'permission') return { status: 'waiting' }
  if (stage === 'cancelled') return { status: 'cancelled' }
  if (stage === 'fork' || stage === 'analysis')
    return { status: 'completed', surface: stage === 'analysis' ? 'analysis' : 'fork' }
  if (stage === 'fork-complete') return { status: 'completed', surface: 'fork' }
  if (stage === 'graph') return { status: 'completed', surface: 'graph' }
  return { status: 'ready' }
}

export {
  analysisView,
  connectionOptions,
  effortOptions,
  modelOptions,
  permission,
  profileOptions,
  question,
  runnerOptions,
}
