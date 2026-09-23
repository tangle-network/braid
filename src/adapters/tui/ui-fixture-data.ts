import type {
  ActivityItemView,
  AnalysisView,
  ForkPreviewView,
  GraphNodeView,
  InteractionView,
  MessageView,
  NoticeView,
  RunView,
  SelectorView,
  SetupView,
  ViewStatus,
} from '../../views/shared/models.js'

function selector(
  id: string,
  title: string,
  selectedId: string,
  items: SelectorView['items'],
  emptyMessage: string,
): SelectorView {
  return Object.freeze({
    id,
    title,
    query: '',
    loading: false,
    stale: false,
    selectedId,
    items: Object.freeze(items),
    emptyMessage,
  })
}

export const profileOptions = selector(
  'profiles',
  'profiles',
  'reviewer',
  [
    {
      id: 'reviewer',
      label: 'reviewer',
      description: 'Finds evidence, explains risk, and keeps changes narrow.',
    },
    {
      id: 'shipper',
      label: 'shipper',
      description: 'Turns an accepted plan into a tested release.',
    },
    {
      id: 'researcher',
      label: 'researcher',
      description: 'Freezes traces and returns cited findings.',
    },
  ],
  'No profiles found.',
)

export const connectionOptions = selector(
  'connections',
  'connections',
  'local',
  [
    { id: 'local', label: 'local / cli-bridge', description: 'loopback · healthy · interactive' },
    { id: 'inference', label: 'cloud / inference', description: 'tangle · healthy · text stream' },
    { id: 'sandbox', label: 'cloud / sandbox', description: 'tangle · setup needed · workspace' },
  ],
  'No connections configured.',
)

export const runnerOptions = selector(
  'runners',
  'runners',
  'pi',
  [
    { id: 'pi', label: 'pi', description: 'local subscription · model honored' },
    { id: 'codex', label: 'codex', description: 'local subscription · model reported by runner' },
    { id: 'opencode', label: 'opencode', description: 'daemon session · questions supported' },
  ],
  'No runners reported by this connection.',
)

export const modelOptions = selector(
  'models',
  'models',
  'claude-sonnet',
  [
    { id: 'claude-sonnet', label: 'claude-sonnet', description: 'balanced · context 200k' },
    { id: 'gpt-5.6', label: 'gpt-5.6', description: 'deep coding · context 272k' },
    { id: 'kimi-k2', label: 'kimi-k2', description: 'fast coding · subscription' },
  ],
  'No models reported by this connection.',
)

export const effortOptions = selector(
  'effort',
  'effort',
  'high',
  [
    { id: 'none', label: 'none', description: 'fast response, no reasoning trace' },
    { id: 'medium', label: 'medium', description: 'balanced reasoning budget' },
    { id: 'high', label: 'high', description: 'more time for difficult changes' },
  ],
  'No effort values reported by this connection.',
)

export const permission: InteractionView = Object.freeze({
  runId: 'run-review-17',
  interactionId: 'interaction-read-4',
  kind: 'permission',
  prompt: 'Allow this read for the current run?',
  subject: Object.freeze({
    type: 'file',
    title: 'Read file',
    target: 'src/runtime/replay.ts',
    detail: 'The agent wants to inspect the replay cursor before proposing a fix.',
    preview: Object.freeze([
      'export function resumeFromCursor(cursor: string) {',
      '  return journal.after(cursor)',
      '…',
    ]),
    trustedWorkspace: 'inside',
  }),
  answerSpec: Object.freeze({ kind: 'boolean', required: true }),
  allowedOutcomes: Object.freeze(['once', 'session', 'reject', 'cancel'] as const),
  remainingMs: 88_000,
  queuePosition: 0,
  secret: false,
  providerSession: 'pi-session-17',
})

export const question: InteractionView = Object.freeze({
  runId: 'run-review-17',
  interactionId: 'interaction-question-2',
  kind: 'question',
  prompt: 'Which boundary should the new branch use?',
  subject: Object.freeze({
    type: 'branch',
    title: 'replay failure',
    detail: 'The provider session is still available; no files have changed.',
  }),
  answerSpec: Object.freeze({
    kind: 'select',
    required: true,
    options: Object.freeze([
      { value: 'message-12', label: 'before the failing turn' },
      { value: 'message-18', label: 'after the replay fix' },
      { value: 'fresh', label: 'new session with copied context' },
    ]),
  }),
  allowedOutcomes: Object.freeze(['accept', 'cancel'] as const),
  queuePosition: 0,
  secret: false,
})

function textPart(id: string, text: string, status: 'running' | 'complete' = 'complete') {
  return Object.freeze({ id, kind: 'text' as const, text, status })
}

export function messageSet(status: ViewStatus): readonly MessageView[] {
  const active = status === 'streaming' || status === 'running' || status === 'waiting'
  return Object.freeze([
    Object.freeze({
      id: 'message-user-17',
      role: 'user' as const,
      text: 'Review the reconnect path and propose a safe fix.',
      status: 'complete' as const,
      parts: Object.freeze([
        textPart('message-user-17:text', 'Review the reconnect path and propose a safe fix.'),
      ]),
    }),
    Object.freeze({
      id: 'message-assistant-17',
      role: 'assistant' as const,
      text: 'The replay path advances its cursor before the event is durable.',
      status: active ? ('streaming' as const) : ('complete' as const),
      runId: 'run-review-17',
      parts: Object.freeze([
        Object.freeze({
          id: 'thinking-17',
          kind: 'reasoning' as const,
          text: 'Comparing the provider cursor with the committed event boundary.',
          status: active ? ('running' as const) : ('complete' as const),
          collapsed: true,
          durationMs: 1_420,
        }),
        Object.freeze({
          id: 'tool-17',
          kind: 'tool' as const,
          text: 'read  src/runtime/replay.ts',
          status: 'complete' as const,
          subject: Object.freeze({ type: 'file', title: 'src/runtime/replay.ts' }),
          durationMs: 218,
        }),
        Object.freeze({
          id: 'result-17',
          kind: 'result' as const,
          text: '24 lines · cursor commit happens before projection commit',
          status: 'complete' as const,
        }),
        textPart('answer-17', 'The replay path advances its cursor before the event is durable.'),
      ]),
    }),
  ])
}

export function runSet(status: ViewStatus): readonly RunView[] {
  const completeness =
    status === 'unknown'
      ? 'unavailable'
      : status === 'streaming' || status === 'waiting'
        ? 'incomplete'
        : 'complete'
  return Object.freeze([
    Object.freeze({
      id: 'run-review-17',
      turnId: 'turn-17',
      operationId: 'op-review-17',
      status,
      usage: Object.freeze({
        input: 8_412,
        output: 1_284,
        costUsd: 0.08,
        model: 'claude-sonnet',
        elapsedMs: 37_000,
      }),
      providerSessionId: 'pi-session-17',
      environmentId: 'local:/workspace',
      runner: 'pi',
      connection: 'local / cli-bridge',
      completeness,
    }),
  ])
}

export const graph: readonly GraphNodeView[] = Object.freeze([
  Object.freeze({
    id: 'conv-review',
    type: 'conversation' as const,
    title: 'replay investigation',
    status: 'completed' as const,
    depth: 0,
  }),
  Object.freeze({
    id: 'branch-main',
    type: 'branch' as const,
    title: 'fix/replay',
    status: 'completed' as const,
    depth: 1,
    edgeLabel: 'continued',
  }),
  Object.freeze({
    id: 'run-review-16',
    type: 'run' as const,
    title: 'failed attempt',
    status: 'failed' as const,
    depth: 2,
    edgeLabel: 'continued',
  }),
  Object.freeze({
    id: 'run-review-17',
    type: 'run' as const,
    title: 'replay proof',
    status: 'waiting' as const,
    depth: 2,
    edgeLabel: 'retried',
  }),
  Object.freeze({
    id: 'analysis-replay',
    type: 'analysis' as const,
    title: 'why did replay fail?',
    status: 'completed' as const,
    depth: 3,
    edgeLabel: 'analyzed',
  }),
  Object.freeze({
    id: 'worker-tests',
    type: 'worker' as const,
    title: 'replay tests',
    status: 'running' as const,
    depth: 3,
    edgeLabel: 'spawned',
  }),
])

export const activity: readonly ActivityItemView[] = Object.freeze([
  Object.freeze({
    id: 'activity-run',
    kind: 'run' as const,
    title: 'run  replay proof',
    status: 'running' as const,
    detail: 'pi · 00:37 · $0.08',
  }),
  Object.freeze({
    id: 'activity-tool',
    kind: 'tool' as const,
    title: 'read  src/runtime/replay.ts',
    status: 'complete' as const,
    detail: '218ms',
  }),
  Object.freeze({
    id: 'activity-worker',
    kind: 'worker' as const,
    title: 'worker  replay tests',
    status: 'running' as const,
    detail: '3 of 8 checks',
  }),
  Object.freeze({
    id: 'activity-interaction',
    kind: 'interaction' as const,
    title: 'interaction  permission',
    status: 'waiting' as const,
    detail: '1 waiting',
  }),
])

export const forkPreview: ForkPreviewView = Object.freeze({
  kind: 'workspace',
  source: 'fix/replay · run-review-17',
  destination: 'fix/replay-copy',
  fields: Object.freeze([
    {
      label: 'transcript',
      source: 'through replay proof',
      destination: 'copied through replay proof',
    },
    { label: 'profile', source: 'reviewer · sha256:91d2…', destination: 'same snapshot' },
    { label: 'provider session', source: 'pi-session-17', destination: 'new session' },
    { label: 'environment', source: 'local:/workspace', destination: 'new from checkpoint' },
    { label: 'pending input', source: 'none', destination: 'none' },
  ]),
  allowed: true,
})

export const setup: SetupView = Object.freeze({
  step: 'review',
  title: 'Set up your first run',
  summary: 'Choose an agent profile and where it should run. Nothing is saved until you confirm.',
  profiles: profileOptions,
  connections: connectionOptions,
  review: Object.freeze([
    { label: 'profile', value: 'reviewer · sha256:91d2…' },
    { label: 'connection', value: 'local / cli-bridge · healthy' },
    { label: 'runner', value: 'pi · model honored' },
    { label: 'model', value: 'claude-sonnet' },
    { label: 'workspace', value: '/workspace' },
  ]),
  warnings: Object.freeze(['Tangle sandbox is available but needs a separate connection check.']),
})

export const analysisView: AnalysisView = Object.freeze({
  source: 'run-review-16 · sha256:48be…',
  analyst: 'reviewer / trace analyst',
  recipe: 'failure',
  status: 'completed',
  findings: Object.freeze([
    {
      id: 'finding-1',
      title: 'Cursor is acknowledged before the local commit',
      severity: 'high',
      confidence: '0.94',
      citationIds: Object.freeze(['cite-1', 'cite-2']),
    },
    {
      id: 'finding-2',
      title: 'Reconnect can repeat the final assistant part',
      severity: 'medium',
      confidence: '0.88',
      citationIds: Object.freeze(['cite-3']),
    },
  ]),
  citations: Object.freeze([
    {
      id: 'cite-1',
      eventId: 'event-18',
      text: 'event 18 received; journal commit followed 42ms later',
    },
    { id: 'cite-2', eventId: 'event-19', text: 'cursor persisted before projection revision 27' },
    { id: 'cite-3', eventId: 'event-20', text: 'replay returned the same message part identifier' },
  ]),
  footer: Object.freeze([
    { label: 'source', value: 'frozen · complete' },
    { label: 'model', value: 'trace-analyst · high' },
    { label: 'tokens / cost', value: '4.2k / $0.02' },
    { label: 'wall time', value: '00:08' },
  ]),
})

export function statusTextFor(status: ViewStatus): string {
  const labels: Partial<Record<ViewStatus, string>> = {
    empty: 'ready for a message',
    loading: 'checking connections',
    ready: 'ready',
    starting: 'starting run',
    streaming: 'streaming',
    running: 'running',
    waiting: 'waiting for approval',
    detached: 'detached · run continues',
    reconnecting: 'reconnecting · cursor 18',
    cancelling: 'cancelling · waiting for provider',
    completed: 'completed · 00:37 · $0.08',
    cancelled: 'cancelled · partial output retained',
    failed: 'failed · safe to retry from turn boundary',
    expired: 'expired · environment is no longer available',
    unknown: 'unknown · provider state unavailable',
    'storage-failure': 'offline · local journal needs attention',
  }
  return labels[status] ?? status
}

export function noticeFor(status: ViewStatus): NoticeView | undefined {
  if (status === 'reconnecting')
    return {
      tone: 'warning',
      text: 'Transport dropped after event 18. Braid will replay from the last committed cursor.',
    }
  if (status === 'failed')
    return { tone: 'danger', text: 'The provider returned an error. No automatic retry was sent.' }
  if (status === 'unknown')
    return {
      tone: 'warning',
      text: 'The provider did not prove a terminal result. Refresh status or start a new run.',
    }
  if (status === 'cancelled')
    return {
      tone: 'info',
      text: 'Cancellation was confirmed by the provider. Partial output remains available.',
    }
  return undefined
}
