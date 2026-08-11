import type { ForkPlan } from '../../app/conversation-types.js'

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
  readonly reasoning?: number
  readonly tokenStatus?: 'complete' | 'observed-floor' | 'unknown'
  readonly costUsd?: number
  readonly estimatedCostUsd?: number
  readonly costStatus?: 'reported' | 'estimated' | 'observed-floor' | 'unknown'
  readonly promptCache?: Readonly<Record<string, number>>
  readonly llmCalls?: number
  readonly llmLatencyMs?: number
  readonly model?: string
  readonly elapsedMs?: number
}

export type UsageMeasurementStatus = 'complete' | 'partial' | 'unknown'

export interface UsageTotalsView extends UsageView {
  readonly sourceCount: number
  readonly unknownTokenSources: number
  readonly unknownCostSources: number
  readonly callStatus?: UsageMeasurementStatus
  readonly latencyStatus?: UsageMeasurementStatus
  readonly unknownCallSources?: number
  readonly unknownLatencySources?: number
}

export interface SessionUsageView {
  /** Direct Braid turns in the selected conversation. */
  readonly turns: UsageTotalsView
  /** /ask, /analyze, and /compare work in the selected conversation. */
  readonly analyses: UsageTotalsView
  /** Runtime-owned worker trees explicitly bound to those turns. */
  readonly delegated: UsageTotalsView
  /** Separate totals prevent double counting until Runtime exports shared call identities. */
  readonly attribution: 'complete' | 'separate-totals'
}

export interface EnvironmentView {
  readonly id: string
  readonly connectionId: string
  readonly kind?: 'local-process' | 'remote-service' | 'sandbox'
  readonly provider: string
  readonly providerEnvironmentId?: string
  readonly lifecycle: string
  readonly lifecycleMode?: 'request' | 'ephemeral' | 'retained'
  readonly cleanup?: 'delete-after-turn' | 'explicit' | 'not-applicable'
  readonly continuity?: 'session' | 'unavailable' | 'not-applicable'
  readonly location?: 'local' | 'remote' | 'unknown'
  readonly runtimeEndpointHost?: string
  readonly machineId?: string
  readonly requestedRegion?: string
  readonly verifiedRegion?: string
  readonly storagePersistence?: 'ephemeral-home' | 'persistent-home' | 'unknown'
  readonly requestedResources?: {
    readonly cpuCores?: number
    readonly memoryMB?: number
    readonly diskGB?: number
    readonly accelerator?: {
      readonly kind: string
      readonly count: number
      readonly memoryMB?: number
    }
  }
  readonly resourceSample?: {
    readonly cgroupVersion: number
    readonly memoryCurrentMb: number
    readonly memoryPeakMb?: number
    readonly memoryLimitMb?: number
    readonly cpuUsageUsec: number
    readonly sampledAt: string
  }
  readonly gpu?: {
    readonly provider: string
    readonly instanceType?: string
    readonly region?: string
    readonly accelerator: string
    readonly count: number
    readonly status: string
    readonly customerPricePerHourUsd?: number
    readonly estimatedCustomerCostUsd?: number
    readonly billedSeconds?: number
    readonly billedCustomerCostUsd?: number
  }
  readonly accountUsage?: {
    readonly completeness: string
    readonly customerId?: string
    readonly billingOwnerId?: string
    readonly computeMinutes?: number
    readonly gpuSeconds?: number
    readonly gpuCostUsd?: number
    readonly activeSandboxes?: number
    readonly totalSandboxes?: number
    readonly creditsAvailableUsd?: number
    readonly creditsUsedUsd?: number
    readonly monthlyBalanceUsd?: number
    readonly plan?: string
    readonly subscriptionStatus?: string
    readonly maximumConcurrentSandboxes?: number
    readonly maximumCpuCores?: number
    readonly maximumRamGB?: number
    readonly maximumStorageGB?: number
    readonly usagePeriodStart?: string
    readonly usagePeriodEnd?: string
    readonly subscriptionPeriodEnd?: string
    readonly sampledAt: string
  }
  readonly unavailableTelemetry: readonly string[]
  readonly createdAt: string
  readonly startedAt?: string
  readonly lastActivityAt?: string
  readonly expiresAt?: string
  readonly updatedAt: string
}

export interface RunView {
  readonly id: string
  readonly turnId?: string
  readonly status: ViewStatus
  readonly operationId?: string
  readonly profileName?: string
  readonly profileDigest?: string
  readonly model?: string
  readonly effort?: string
  readonly maxOutputTokens?: number
  readonly usage?: UsageView
  readonly error?: string
  readonly cursor?: string
  readonly providerSessionId?: string
  readonly requestedSessionId?: string
  readonly environmentId?: string
  readonly runner?: string
  readonly provider?: string
  readonly connection?: string
  readonly connectionId?: string
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
  readonly kind:
    | 'run'
    | 'tool'
    | 'supervisor'
    | 'worker'
    | 'interaction'
    | 'analysis'
    | 'environment'
    | 'system'
  readonly title: string
  readonly status: ViewStatus | 'complete'
  readonly detail?: string
  readonly elapsedMs?: number
  readonly startedAt?: string
  readonly occurredAt?: string
  readonly sourceEventId?: string
  readonly runId?: string
  readonly entityType?: GraphNodeType
  readonly entityId?: string
  readonly parentId?: string
  readonly depth?: number
}

export type GraphNodeType =
  | 'conversation'
  | 'branch'
  | 'turn'
  | 'run'
  | 'analysis'
  | 'environment'
  | 'checkpoint'
  | 'supervisor'
  | 'worker'

export interface GraphNodeView {
  readonly id: string
  readonly type: GraphNodeType
  readonly title: string
  readonly status: ViewStatus | 'complete'
  readonly depth: number
  readonly edgeLabel?: string
  readonly runner?: string
  readonly elapsedMs?: number
  readonly startedAt?: string
  readonly costUsd?: number
}

export interface DetailsView {
  readonly title: string
  readonly fields: readonly { readonly label: string; readonly value: string }[]
  readonly sourceEventId?: string
}

export interface EntityDetailView {
  readonly entityType: GraphNodeType
  readonly entityId: string
  readonly title: string
  readonly status: string
  readonly lines: readonly string[]
  readonly analysisExecution?: AnalysisExecutionView
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

export interface AnalysisModelCallView {
  readonly sequence: number
  readonly provider?: string
  readonly model: string
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly tokensKnown: boolean
  readonly costUsd?: number
  readonly costStatus: 'observed' | 'estimated' | 'unknown'
  readonly latencyMs?: number
  readonly outcome: 'succeeded' | 'failed'
}

export interface AnalysisExecutionView {
  readonly configuredModel?: string
  readonly runner?: string
  readonly observedModels: readonly string[]
  readonly modelCalls?: readonly AnalysisModelCallView[]
  readonly wallTimeMs?: number
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
  readonly execution?: AnalysisExecutionView
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
  readonly plan?: Readonly<ForkPlan>
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
  readonly maxOutputTokens?: number
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
  readonly sessionUsage: SessionUsageView
  readonly environments: readonly EnvironmentView[]
  readonly activeRunId?: string
  readonly interactions: readonly InteractionView[]
  readonly activity: readonly ActivityItemView[]
  readonly graph: readonly GraphNodeView[]
  readonly hiddenGraphNodeCount?: number
  readonly entityDetails?: readonly EntityDetailView[]
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
    readonly tokenStatus: NonNullable<UsageView['tokenStatus']>
    readonly reasoningTokens?: number
    readonly costUsd?: number
    readonly estimatedCostUsd?: number
    readonly costStatus: NonNullable<UsageView['costStatus']>
    readonly promptCache?: Readonly<Record<string, number>>
    readonly llmCalls?: number
    readonly llmLatencyMs?: number
    readonly model?: string
    readonly provider?: string
    readonly runner?: string
    readonly connectionId?: string
    readonly requestedSessionId?: string
    readonly error?: string
    readonly completeness: RunView['completeness']
    readonly providerSessionId?: string
    readonly environmentId?: string
    readonly materializationDigest?: string
    readonly cursor?: string
    readonly contentBytes?: number
    readonly contentTruncated?: boolean
    readonly activityTruncated?: boolean
    readonly eventDetailsTruncated?: boolean
    readonly interactionsTruncated?: boolean
  }[]
  readonly sessionUsage: SessionUsageView
  readonly environments: readonly EnvironmentView[]
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
