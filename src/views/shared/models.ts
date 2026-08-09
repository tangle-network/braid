export type ViewStatus =
  | 'empty'
  | 'loading'
  | 'ready'
  | 'starting'
  | 'streaming'
  | 'running'
  | 'waiting'
  | 'detached'
  | 'reconnecting'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'expired'
  | 'unknown'
  | 'storage-failure'

export type MessageViewStatus =
  | 'complete'
  | 'streaming'
  | 'failed'
  | 'cancelled'
  | 'aborted'
  | 'blocked'
  | 'expired'
  | 'unknown'
  | 'incomplete'
  /** Retention or a destroyed content key removed the stored text. */
  | 'redacted'

export type TranscriptPartKind =
  | 'text'
  | 'reasoning'
  | 'tool'
  | 'result'
  | 'artifact'
  | 'warning'
  | 'error'
  | 'analysis'
  | 'system'
  | 'unknown'

export interface TranscriptPartView {
  readonly id: string
  readonly kind: TranscriptPartKind
  readonly text: string
  readonly status?: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled' | 'unknown'
  readonly collapsed?: boolean
  readonly subject?: SubjectView
  readonly durationMs?: number
  readonly sourceEventId?: string
  readonly toolName?: string
  readonly callId?: string
  readonly input?: unknown
  readonly result?: unknown
  readonly error?: string
  readonly artifactId?: string
  readonly uri?: string
  readonly mimeType?: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly truncated?: boolean
}

export interface MessageView {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'system'
  readonly text: string
  readonly status: MessageViewStatus
  readonly runId?: string
  readonly parts: readonly TranscriptPartView[]
  readonly partsTruncated?: boolean
}

export interface UsageView {
  readonly input?: number
  readonly output?: number
  readonly costUsd?: number
  readonly model?: string
  readonly elapsedMs?: number
}

export interface RunView {
  readonly id: string
  readonly turnId?: string
  readonly status: ViewStatus
  readonly operationId?: string
  readonly usage?: UsageView
  readonly error?: string
  readonly cursor?: string
  readonly providerSessionId?: string
  readonly environmentId?: string
  readonly runner?: string
  readonly connection?: string
  readonly completeness:
    | 'complete'
    | 'incomplete'
    | 'missing-history'
    | 'unknown'
    | 'failed'
    | 'streaming'
    | 'unavailable'
  readonly contentBytes?: number
  readonly contentTruncated?: boolean
  readonly activityTruncated?: boolean
  readonly eventDetailsTruncated?: boolean
  readonly interactionsTruncated?: boolean
}

export interface SubjectView {
  readonly type: string
  readonly title: string
  readonly target?: string
  readonly detail?: string
  readonly preview?: readonly string[]
  readonly trustedWorkspace?: 'inside' | 'outside' | 'unknown'
}

export type InteractionOutcome =
  | 'once'
  | 'session'
  | 'persistent'
  | 'accept'
  | 'revise'
  | 'reject'
  | 'deny'
  | 'cancel'

export type AnswerSpecView =
  | {
      readonly kind: 'text'
      readonly required: boolean
      readonly secret: boolean
      readonly maxLength?: number
    }
  | {
      readonly kind: 'number'
      readonly required: boolean
      readonly minimum?: number
      readonly maximum?: number
    }
  | {
      readonly kind: 'boolean'
      readonly required: boolean
      readonly defaultValue?: boolean
    }
  | {
      readonly kind: 'select'
      readonly required: boolean
      readonly options: readonly { readonly value: string; readonly label: string }[]
    }
  | {
      readonly kind: 'secret'
      readonly required: boolean
    }
  | {
      readonly kind: 'unknown'
      readonly label: string
      readonly safeToCancel: boolean
    }
  | {
      readonly kind: 'form'
      readonly fields: readonly {
        readonly name: string
        readonly label: string
        readonly type: 'text' | 'number' | 'boolean' | 'select' | 'secret'
        readonly required: boolean
        readonly options?: readonly { readonly value: string; readonly label: string }[]
        readonly minimum?: number
        readonly maximum?: number
      }[]
    }

export interface InteractionView {
  readonly runId: string
  readonly interactionId: string
  readonly profileName?: string
  readonly runner?: string
  readonly kind: string
  readonly prompt: string
  readonly subject?: SubjectView
  readonly answerSpec: AnswerSpecView
  readonly allowedOutcomes: readonly InteractionOutcome[]
  readonly responseScopes: readonly import('../../domain/entities-interactions.js').AutomationRuleScope[]
  readonly remainingMs?: number
  readonly queuePosition: number
  readonly secret: boolean
  readonly providerSession?: string
}

export interface CapabilityView {
  readonly available: boolean
  readonly reason?: string
  readonly source: 'provider' | 'runtime' | 'application' | 'local'
}

export type CapabilityMap = Readonly<Record<string, CapabilityView>>

export interface SelectorView {
  readonly id: string
  readonly title: string
  readonly query: string
  readonly loading: boolean
  readonly stale: boolean
  readonly items: readonly {
    readonly id: string
    readonly label: string
    readonly description?: string
    readonly unavailableReason?: string
  }[]
  readonly selectedId?: string
  readonly emptyMessage: string
}

export interface ActivityItemView {
  readonly id: string
  readonly kind: 'run' | 'tool' | 'worker' | 'interaction' | 'analysis' | 'system'
  readonly title: string
  readonly status: ViewStatus | 'complete'
  readonly detail?: string
  readonly elapsedMs?: number
}

export interface GraphNodeView {
  readonly id: string
  readonly type:
    | 'conversation'
    | 'branch'
    | 'turn'
    | 'run'
    | 'analysis'
    | 'environment'
    | 'checkpoint'
    | 'supervisor'
    | 'worker'
  readonly title: string
  readonly status: ViewStatus | 'complete'
  readonly depth: number
  readonly edgeLabel?: string
}

export interface DetailsView {
  readonly title: string
  readonly fields: readonly { readonly label: string; readonly value: string }[]
  readonly sourceEventId?: string
}

export interface ProfileEditorView {
  readonly source: string
  readonly digest: string
  readonly readOnly: boolean
  readonly validation: 'valid' | 'warning' | 'invalid' | 'unknown'
  readonly fields: readonly {
    readonly path: string
    readonly value: string
    readonly secret: boolean
  }[]
  readonly error?: string
}

export interface ConnectionSetupView {
  readonly kind: 'cli-bridge' | 'tangle-inference' | 'tangle-sandbox'
  readonly fields: readonly {
    readonly label: string
    readonly value: string
    readonly secret: boolean
  }[]
  readonly health:
    | 'unknown'
    | 'checking'
    | 'healthy'
    | 'unauthorized'
    | 'unreachable'
    | 'incompatible'
    | 'rate-limited'
  readonly capabilities: readonly string[]
  readonly error?: string
}

export interface AnalysisFindingView {
  readonly id: string
  readonly title: string
  readonly severity?: string
  readonly confidence?: string
  readonly citationIds: readonly string[]
}

export interface AnalysisView {
  readonly source: string
  readonly analyst: string
  readonly recipe: string
  readonly status: ViewStatus
  readonly findings: readonly AnalysisFindingView[]
  readonly citations: readonly {
    readonly id: string
    readonly eventId: string
    readonly text: string
  }[]
  readonly footer: readonly { readonly label: string; readonly value: string }[]
  readonly error?: string
}

export interface ComparisonArmView {
  readonly label: 'baseline' | 'candidate'
  readonly runId: string
  readonly sourceDigest: string
  readonly outcome: string
  readonly cost: string
  readonly costProvenance: string
}

export interface ComparisonFieldView {
  readonly name: string
  readonly baseline: string
  readonly candidate: string
  readonly asymmetry: 'none' | 'baseline-only' | 'candidate-only' | 'both-missing'
}

export interface ComparisonView {
  readonly baseline: ComparisonArmView
  readonly candidate: ComparisonArmView
  readonly pairCount: number
  readonly unpairedBaseline: number
  readonly unpairedCandidate: number
  readonly sampleLimit: string
  readonly fields: readonly ComparisonFieldView[]
  readonly pairedFacts: readonly { readonly label: string; readonly value: string }[]
  readonly semantic: { readonly status: string; readonly reason: string }
  readonly replayed: boolean
}

export interface ForkPreviewView {
  readonly source: string
  readonly destination: string
  readonly kind: 'conversation' | 'workspace' | 'cross-runner'
  readonly fields: readonly {
    readonly label: string
    readonly source: string
    readonly destination: string
  }[]
  readonly allowed: boolean
  readonly unavailableReason?: string
}

export interface HelpView {
  readonly query: string
  readonly concepts: readonly { readonly title: string; readonly text: string }[]
}

export interface BraidViewModel {
  readonly revision: number
  readonly workspace: string | null
  readonly profileName: string
  readonly profileDigest?: string
  readonly runner: string
  readonly model: string
  readonly effort?: string
  readonly connection: string
  readonly conversationId: string
  readonly conversationTitle: string
  readonly conversations: readonly {
    readonly id: string
    readonly title: string
    readonly branchId: string
    readonly archived: boolean
    readonly active: boolean
    readonly updatedAt: string
  }[]
  readonly branch: string
  readonly status: ViewStatus
  readonly statusText: string
  readonly elapsedMs?: number
  readonly queueCount: number
  readonly messages: readonly MessageView[]
  readonly hiddenMessageCount: number
  readonly runs: readonly RunView[]
  readonly activeRunId?: string
  readonly interactions: readonly InteractionView[]
  readonly activity: readonly ActivityItemView[]
  readonly graph: readonly GraphNodeView[]
  readonly details?: DetailsView
  readonly profileEditor?: ProfileEditorView
  readonly connectionSetup?: ConnectionSetupView
  readonly analysis?: AnalysisView
  readonly forkPreview?: ForkPreviewView
  readonly help?: HelpView
  readonly capabilities: CapabilityMap
  readonly draft: string
  readonly queue?: readonly {
    readonly operationId: string
    readonly runId: string
    readonly text: string
    readonly position: number
    readonly status: 'queued' | 'blocked' | 'unknown'
  }[]
  readonly storageFailure?: string
  readonly cleanupUncertain?: string
  readonly notice?: string
  readonly selectedSurface:
    | 'transcript'
    | 'activity'
    | 'graph'
    | 'details'
    | 'fork'
    | 'help'
    | 'settings'
  readonly appearance: {
    readonly color: 'truecolor' | '256' | '16' | 'none'
    readonly highContrast: boolean
    readonly reducedMotion: boolean
  }
}

export interface HeadlessState {
  readonly schemaVersion: number
  readonly revision: number
  readonly sequence: number
  readonly workspace: string | null
  readonly conversationId: string
  readonly branchId: string
  readonly conversations: readonly {
    readonly id: string
    readonly title: string
    readonly branchId: string
    readonly archived: boolean
    readonly updatedAt: string
  }[]
  readonly profile: Readonly<Record<string, unknown>>
  readonly draft: string
  readonly messages: readonly {
    readonly id: string
    readonly role: string
    readonly text: string
    readonly status: string
    readonly runId?: string
    readonly parts: readonly TranscriptPartView[]
    readonly partsTruncated?: boolean
  }[]
  readonly runs: readonly {
    readonly id: string
    readonly turnId: string
    readonly operationId: string
    readonly status: string
    readonly inputTokens: number
    readonly outputTokens: number
    readonly costUsd?: number
    readonly model?: string
    readonly error?: string
    readonly completeness: RunView['completeness']
    readonly providerSessionId?: string
    readonly cursor?: string
    readonly contentBytes?: number
    readonly contentTruncated?: boolean
    readonly activityTruncated?: boolean
    readonly eventDetailsTruncated?: boolean
    readonly interactionsTruncated?: boolean
  }[]
  readonly interactions: readonly InteractionView[]
  readonly queue: readonly {
    readonly operationId: string
    readonly runId: string
    readonly text: string
    readonly position: number
    readonly status: 'queued' | 'blocked' | 'unknown'
  }[]
  readonly activeRunId: string | null
  readonly lastError: string | null
  readonly storageFailure?: string
  readonly cleanupUncertain?: string
}

export interface HeadlessSummary {
  readonly schemaVersion: number
  readonly revision: number
  readonly sequence: number
  readonly workspace: string | null
  readonly conversationId: string
  readonly branchId: string
  readonly profileName: string
  readonly status: ViewStatus
  readonly messageCount: number
  readonly runCount: number
  readonly interactionCount: number
  readonly queue: readonly {
    readonly operationId: string
    readonly runId: string
    readonly text: string
    readonly position: number
    readonly status: 'queued' | 'blocked' | 'unknown'
  }[]
  readonly queueCount: number
  readonly activeRunId: string | null
  readonly lastError: string | null
}

export function freezeView<T>(value: T): Readonly<T> {
  const seen = new WeakSet<object>()
  const freeze = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== 'object') return
    if (seen.has(candidate)) return
    seen.add(candidate)
    for (const child of Object.values(candidate)) freeze(child)
    Object.freeze(candidate)
  }
  freeze(value)
  return value as Readonly<T>
}
