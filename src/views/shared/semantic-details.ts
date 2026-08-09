import type { AnalysisFinding } from '../../domain/entities.js'
import type { BraidState } from '../../domain/state.js'
import { sanitizeTerminalText, sanitizeTitle } from './sanitize.js'
import { ensureEntityExists, graphEdgesForEntity, queryGraph } from './semantic-graph.js'
import { assertNodeType, SemanticQueryError } from './semantic-query-scope.js'
import type {
  DetailsQueryResult,
  SemanticDetailField,
  SemanticNodeType,
} from './semantic-query-types.js'

function safe(value: string): string {
  return sanitizeTerminalText(value)
}

function title(value: string): string {
  return sanitizeTitle(value) || '[untitled]'
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return safe(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === undefined || value === null) return ''
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(', ')
  return '[structured value]'
}

function fields(data: Readonly<Record<string, unknown>>): SemanticDetailField[] {
  return Object.entries(data)
    .filter(([, value]) => value !== undefined)
    .map(([label, value]) => ({ label, value: textValue(value) }))
}

function safeFinding(finding: AnalysisFinding): Readonly<Record<string, unknown>> {
  return {
    id: finding.id,
    text: safe(finding.text),
    ...(finding.severity === undefined ? {} : { severity: finding.severity }),
    ...(finding.confidence === undefined ? {} : { confidence: finding.confidence }),
    supported: finding.supported,
    citations: finding.citations.map((citation) => ({
      id: citation.id,
      ...(citation.eventId === undefined ? {} : { eventId: citation.eventId }),
      ...(citation.messageId === undefined ? {} : { messageId: citation.messageId }),
      ...(citation.partId === undefined ? {} : { partId: citation.partId }),
      ...(citation.start === undefined ? {} : { start: citation.start }),
      ...(citation.end === undefined ? {} : { end: citation.end }),
      ...(citation.quote === undefined ? {} : { quote: safe(citation.quote) }),
    })),
  }
}

function dataFor(
  state: BraidState,
  type: SemanticNodeType,
  id: string,
): Readonly<Record<string, unknown>> | undefined {
  switch (type) {
    case 'conversation': {
      const conversation = state.conversations.find((candidate) => candidate.id === id)
      if (conversation === undefined) return undefined
      return {
        id: conversation.id,
        workspaceId: conversation.workspaceId,
        title: safe(conversation.title),
        activeBranchId: conversation.activeBranchId,
        ...(conversation.profileId === undefined ? {} : { profileId: conversation.profileId }),
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        archived: conversation.archived,
        ...(conversation.deletedAt === undefined ? {} : { deletedAt: conversation.deletedAt }),
        retention: conversation.retention,
      }
    }
    case 'branch': {
      const branch = state.branches.find((candidate) => candidate.id === id)
      if (branch === undefined) return undefined
      return {
        id: branch.id,
        conversationId: branch.conversationId,
        ...(branch.source === undefined ? {} : { source: branch.source }),
        ...(branch.profileId === undefined ? {} : { profileId: branch.profileId }),
        ...(branch.profileSnapshotId === undefined
          ? {}
          : { profileSnapshotId: branch.profileSnapshotId }),
        ...(branch.connectionId === undefined ? {} : { connectionId: branch.connectionId }),
        overrides: {
          ...(branch.overrides.runner === undefined
            ? {}
            : { runner: safe(branch.overrides.runner) }),
          ...(branch.overrides.model === undefined ? {} : { model: safe(branch.overrides.model) }),
          ...(branch.overrides.effort === undefined ? {} : { effort: branch.overrides.effort }),
          ...(branch.overrides.mode === undefined ? {} : { mode: safe(branch.overrides.mode) }),
        },
        ...(branch.bindingId === undefined ? {} : { bindingId: branch.bindingId }),
        ...(branch.environmentId === undefined ? {} : { environmentId: branch.environmentId }),
        draftId: branch.draftId,
        queueId: branch.queueId,
        ...(branch.tipMessageId === undefined ? {} : { tipMessageId: branch.tipMessageId }),
        status: branch.status,
        createdAt: branch.createdAt,
        updatedAt: branch.updatedAt,
      }
    }
    case 'turn': {
      const turn = state.turns.find((candidate) => candidate.id === id)
      if (turn === undefined) return undefined
      return {
        id: turn.id,
        conversationId: turn.conversationId,
        branchId: turn.branchId,
        userMessageId: turn.userMessageId,
        runIds: turn.runIds,
        ...(turn.selectedRunId === undefined ? {} : { selectedRunId: turn.selectedRunId }),
        ...(turn.queueEntryId === undefined ? {} : { queueEntryId: turn.queueEntryId }),
        status: turn.status,
        createdAt: turn.createdAt,
        updatedAt: turn.updatedAt,
      }
    }
    case 'run': {
      const run = state.runs.find((candidate) => candidate.id === id)
      if (run === undefined) return undefined
      return {
        id: run.id,
        conversationId: run.conversationId,
        branchId: run.branchId,
        turnId: run.turnId,
        operationId: run.operationId,
        status: run.status,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        capabilities: run.capabilities,
        ...(run.reasoningTokens === undefined ? {} : { reasoningTokens: run.reasoningTokens }),
        ...(run.costUsd === undefined ? {} : { costUsd: run.costUsd }),
        ...(run.model === undefined ? {} : { model: safe(run.model) }),
        ...(run.error === undefined ? {} : { error: safe(run.error) }),
        ...(run.profileSnapshotId === undefined
          ? {}
          : { profileSnapshotId: run.profileSnapshotId }),
        ...(run.connectionId === undefined ? {} : { connectionId: run.connectionId }),
        ...(run.providerSessionId === undefined
          ? {}
          : { providerSessionId: run.providerSessionId }),
        ...(run.environmentId === undefined ? {} : { environmentId: run.environmentId }),
        ...(run.bindingId === undefined ? {} : { bindingId: run.bindingId }),
        ...(run.receiptId === undefined ? {} : { receiptId: run.receiptId }),
        receipt: {
          profileDigest: run.receipt.profileDigest,
          requestDigest: run.receipt.requestDigest,
          capabilitiesDigest: run.receipt.capabilitiesDigest,
          admittedAt: run.receipt.admittedAt,
          ...(run.receipt.provider === undefined ? {} : { provider: safe(run.receipt.provider) }),
          ...(run.receipt.providerSessionId === undefined
            ? {}
            : { providerSessionId: safe(run.receipt.providerSessionId) }),
          ...(run.receipt.environmentId === undefined
            ? {}
            : { environmentId: run.receipt.environmentId }),
          ...(run.receipt.admissionStatus === undefined
            ? {}
            : { admissionStatus: run.receipt.admissionStatus }),
          digest: run.receipt.digest,
          ...(run.receipt.materializationDigest === undefined
            ? {}
            : { materializationDigest: run.receipt.materializationDigest }),
          ...(run.receipt.warnings === undefined
            ? {}
            : { warnings: run.receipt.warnings.map(safe) }),
        },
        ...(run.replayCursor === undefined ? {} : { replayCursor: run.replayCursor }),
        complete: run.complete,
        ...(run.terminalReason === undefined ? {} : { terminalReason: safe(run.terminalReason) }),
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
        ...(run.terminalAt === undefined ? {} : { terminalAt: run.terminalAt }),
        ...(run.lastCursor === undefined ? {} : { lastCursor: safe(run.lastCursor) }),
        lastProviderSequence: run.lastProviderSequence,
        eventCount: run.eventCount,
        ...(run.contentBytes === undefined ? {} : { contentBytes: run.contentBytes }),
        ...(run.contentTruncated === undefined ? {} : { contentTruncated: run.contentTruncated }),
        ...(run.missingSequence === undefined ? {} : { missingSequence: run.missingSequence }),
        ...(run.activityTruncated === undefined
          ? {}
          : { activityTruncated: run.activityTruncated }),
        ...(run.eventDetailsTruncated === undefined
          ? {}
          : { eventDetailsTruncated: run.eventDetailsTruncated }),
        ...(run.interactionsTruncated === undefined
          ? {}
          : { interactionsTruncated: run.interactionsTruncated }),
        activityCount: run.activity.length,
        eventDetailCount: run.eventDetails.length,
        interactionCount: run.interactions.length,
      }
    }
    case 'analysis': {
      const analysis = state.analyses.find((candidate) => candidate.id === id)
      if (analysis === undefined) return undefined
      return {
        id: analysis.id,
        ...(analysis.analysisRunId === undefined ? {} : { analysisRunId: analysis.analysisRunId }),
        source: {
          conversationId: analysis.source.conversationId,
          branchId: analysis.source.branchId,
          ...(analysis.source.runId === undefined ? {} : { runId: analysis.source.runId }),
          ...(analysis.source.throughMessageId === undefined
            ? {}
            : { throughMessageId: analysis.source.throughMessageId }),
          ...(analysis.source.trace === undefined
            ? {}
            : {
                trace: {
                  id: analysis.source.trace.id,
                  provider: analysis.source.trace.provider,
                  digest: analysis.source.trace.digest,
                },
              }),
          digest: analysis.source.digest,
          complete: analysis.source.complete,
          ...(analysis.source.missingHistory === undefined
            ? {}
            : { missingHistory: analysis.source.missingHistory }),
        },
        ...(analysis.question === undefined ? {} : { question: safe(analysis.question) }),
        ...(analysis.recipe === undefined ? {} : { recipe: safe(analysis.recipe) }),
        ...(analysis.analystProfileId === undefined
          ? {}
          : { analystProfileId: analysis.analystProfileId }),
        ...(analysis.analystProfileDigest === undefined
          ? {}
          : { analystProfileDigest: analysis.analystProfileDigest }),
        status: analysis.status,
        findings: analysis.findings.map(safeFinding),
        ...(analysis.usage === undefined
          ? {}
          : {
              usage: {
                input: analysis.usage.input,
                output: analysis.usage.output,
                ...(analysis.usage.reasoning === undefined
                  ? {}
                  : { reasoning: analysis.usage.reasoning }),
                ...(analysis.usage.costUsd === undefined
                  ? {}
                  : { costUsd: analysis.usage.costUsd }),
                ...(analysis.usage.model === undefined
                  ? {}
                  : { model: safe(analysis.usage.model) }),
              },
            }),
        ...(analysis.costUsd === undefined ? {} : { costUsd: analysis.costUsd }),
        ...(analysis.wallTimeMs === undefined ? {} : { wallTimeMs: analysis.wallTimeMs }),
        createdAt: analysis.createdAt,
        updatedAt: analysis.updatedAt,
      }
    }
    case 'environment': {
      const environment = state.environments.find((candidate) => candidate.id === id)
      if (environment === undefined) return undefined
      return {
        id: environment.id,
        workspaceId: environment.workspaceId,
        connectionId: environment.connectionId,
        lifecycle: environment.lifecycle,
        placement: {
          provider: safe(environment.placement.provider),
          ...(environment.placement.region === undefined
            ? {}
            : { region: safe(environment.placement.region) }),
          ...(environment.placement.account === undefined
            ? {}
            : { account: safe(environment.placement.account) }),
          confidentialRequested: environment.placement.confidentialRequested,
          confidentialVerified: environment.placement.confidentialVerified,
        },
        ...(environment.repository === undefined
          ? {}
          : { repository: safe(environment.repository) }),
        ...(environment.gitRef === undefined ? {} : { gitRef: safe(environment.gitRef) }),
        ...(environment.workingDirectory === undefined
          ? {}
          : { workingDirectory: safe(environment.workingDirectory) }),
        ...(environment.image === undefined ? {} : { image: safe(environment.image) }),
        secretNames: environment.secretNames.map(safe),
        createdAt: environment.createdAt,
        updatedAt: environment.updatedAt,
      }
    }
    case 'checkpoint': {
      const checkpoint = state.checkpoints.find((candidate) => candidate.id === id)
      if (checkpoint === undefined) return undefined
      return {
        id: checkpoint.id,
        sourceEnvironmentId: checkpoint.sourceEnvironmentId,
        sourceBranchId: checkpoint.sourceBranchId,
        ...(checkpoint.sourceRunId === undefined ? {} : { sourceRunId: checkpoint.sourceRunId }),
        ...(checkpoint.throughMessageId === undefined
          ? {}
          : { throughMessageId: checkpoint.throughMessageId }),
        requestDigest: checkpoint.requestDigest,
        operationId: checkpoint.operationId,
        ...(checkpoint.stateDigest === undefined ? {} : { stateDigest: checkpoint.stateDigest }),
        createdAt: checkpoint.createdAt,
        status: checkpoint.status,
      }
    }
    case 'supervisor': {
      const supervisor = state.supervisors.find((candidate) => candidate.id === id)
      if (supervisor === undefined) return undefined
      return {
        id: supervisor.id,
        rootRunId: supervisor.rootRunId,
        status: supervisor.status,
        createdAt: supervisor.createdAt,
        updatedAt: supervisor.updatedAt,
      }
    }
    case 'worker': {
      const worker = state.workers.find((candidate) => candidate.id === id)
      if (worker === undefined) return undefined
      return {
        id: worker.id,
        supervisorId: worker.supervisorId,
        ...(worker.parentWorkerId === undefined ? {} : { parentWorkerId: worker.parentWorkerId }),
        ...(worker.runId === undefined ? {} : { runId: worker.runId }),
        status: worker.status,
        ...(worker.title === undefined ? {} : { title: safe(worker.title) }),
        ...(worker.spendUsd === undefined ? {} : { spendUsd: worker.spendUsd }),
        ...(worker.inputTokens === undefined ? {} : { inputTokens: worker.inputTokens }),
        ...(worker.outputTokens === undefined ? {} : { outputTokens: worker.outputTokens }),
        ...(worker.latencyMs === undefined ? {} : { latencyMs: worker.latencyMs }),
        ...(worker.logTail === undefined ? {} : { logTail: safe(worker.logTail) }),
        createdAt: worker.createdAt,
        updatedAt: worker.updatedAt,
      }
    }
  }
}

function statusFor(state: BraidState, type: SemanticNodeType, id: string): string {
  const graph = queryGraph(state).nodes.find((node) => node.type === type && node.id === id)
  return graph?.status ?? 'unknown'
}

function titleFor(state: BraidState, type: SemanticNodeType, id: string): string {
  const graph = queryGraph(state).nodes.find((node) => node.type === type && node.id === id)
  return graph?.title ?? `${type} ${id}`
}

export function queryDetails(
  state: BraidState,
  input: { readonly entityType: string; readonly entityId: string },
): DetailsQueryResult {
  const type = assertNodeType(input.entityType)
  if (!input.entityId) throw new SemanticQueryError('INVALID_ENTITY', 'Entity id must not be empty')
  ensureEntityExists(state, type, input.entityId)
  const data = dataFor(state, type, input.entityId) ?? {
    id: input.entityId,
    type,
  }
  const detailFields = fields(data)
  return {
    entityType: type,
    entityId: input.entityId,
    title: title(titleFor(state, type, input.entityId)),
    status: statusFor(state, type, input.entityId),
    fields: detailFields,
    data,
    edges: graphEdgesForEntity(state, type, input.entityId),
  }
}

export function detailsForRun(
  state: BraidState,
  runId: string | undefined,
): DetailsQueryResult | undefined {
  if (runId === undefined) return undefined
  try {
    return queryDetails(state, { entityType: 'run', entityId: runId })
  } catch (error) {
    if (error instanceof SemanticQueryError && error.code === 'UNKNOWN_ENTITY') return undefined
    throw error
  }
}

export { assertNodeType }
