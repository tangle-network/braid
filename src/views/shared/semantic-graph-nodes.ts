import type { GraphNodeRecord, GraphNodeReference } from '../../domain/entities.js'
import type { BraidState } from '../../domain/state.js'
import { sanitizeTerminalText, sanitizeTitle } from './sanitize.js'
import { SEMANTIC_NODE_TYPES, type SemanticNodeType } from './semantic-query-types.js'

export interface NodeDescriptor {
  readonly type: SemanticNodeType
  readonly id: string
  readonly title: string
  readonly status: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly runner?: string
  readonly elapsedMs?: number
  readonly costUsd?: number
  readonly searchText: string
}

interface NodeFallback {
  readonly title: string
  readonly status: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly runner?: string | undefined
  readonly elapsedMs?: number | undefined
  readonly costUsd?: number | undefined
  readonly searchText: string
}

export function semanticNodeKey(type: SemanticNodeType, id: string): string {
  return `${type}:${id}`
}

export function semanticReference(type: SemanticNodeType, id: string): GraphNodeReference {
  return { kind: type, id } as GraphNodeReference
}

export function safeGraphText(value: string): string {
  return sanitizeTerminalText(value)
}

function safeTitle(value: string): string {
  return sanitizeTitle(value) || '[untitled]'
}

function elapsedMs(startedAt: string, endedAt: string | undefined): number | undefined {
  if (endedAt === undefined) return undefined
  const elapsed = Date.parse(endedAt) - Date.parse(startedAt)
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined
}

function joined(values: readonly (string | undefined)[]): string {
  return values.filter((value): value is string => value !== undefined).join(' ')
}

function turnStatusForProjection(state: BraidState, turn: BraidState['turns'][number]): string {
  const runs = state.runs.filter((run) => turn.runIds.includes(run.id))
  if (runs.length === 0) return turn.status
  const active = runs.find(
    (run) =>
      !['completed', 'failed', 'aborted', 'cancelled', 'blocked', 'expired', 'unknown'].includes(
        run.status,
      ),
  )
  if (active !== undefined) return active.status
  const selected =
    (turn.selectedRunId === undefined
      ? undefined
      : runs.find((run) => run.id === turn.selectedRunId)) ?? runs.at(-1)
  if (selected === undefined) return turn.status
  if (selected.status === 'aborted' || selected.status === 'cancelled') return 'cancelled'
  return selected.status
}

function descriptor(
  type: SemanticNodeType,
  id: string,
  fallback: NodeFallback,
  metadata: GraphNodeRecord | undefined,
): NodeDescriptor {
  const nodeTitle = safeTitle(metadata?.title ?? fallback.title)
  const metadataStatus = type === 'turn' ? undefined : metadata?.status
  const nodeStatus = metadataStatus === undefined ? fallback.status : safeGraphText(metadataStatus)
  return {
    type,
    id,
    title: nodeTitle,
    status: nodeStatus,
    createdAt: metadata?.createdAt ?? fallback.createdAt,
    updatedAt: metadata?.updatedAt ?? fallback.updatedAt,
    ...(fallback.runner === undefined ? {} : { runner: safeGraphText(fallback.runner) }),
    ...(fallback.elapsedMs === undefined ? {} : { elapsedMs: fallback.elapsedMs }),
    ...(fallback.costUsd === undefined ? {} : { costUsd: fallback.costUsd }),
    searchText: joined([
      type,
      id,
      nodeTitle,
      nodeStatus,
      fallback.runner,
      fallback.searchText,
    ]).toLowerCase(),
  }
}

function metadataFor(state: BraidState): ReadonlyMap<string, GraphNodeRecord> {
  const output = new Map<string, GraphNodeRecord>()
  for (const node of state.graphNodes) {
    if (!(SEMANTIC_NODE_TYPES as readonly string[]).includes(node.reference.kind)) continue
    output.set(semanticNodeKey(node.reference.kind as SemanticNodeType, node.reference.id), node)
  }
  return output
}

export function descriptorsFor(state: BraidState): NodeDescriptor[] {
  const metadata = metadataFor(state)
  const output: NodeDescriptor[] = []
  const add = (type: SemanticNodeType, id: string, fallback: NodeFallback): void => {
    output.push(descriptor(type, id, fallback, metadata.get(semanticNodeKey(type, id))))
  }

  for (const conversation of state.conversations) {
    add('conversation', conversation.id, {
      title: conversation.title,
      status:
        conversation.deletedAt === undefined
          ? conversation.archived
            ? 'archived'
            : 'active'
          : 'deleted',
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      searchText: joined([conversation.workspaceId, conversation.activeBranchId]),
    })
  }
  for (const branch of state.branches) {
    add('branch', branch.id, {
      title: `branch ${branch.id}`,
      status: branch.status,
      createdAt: branch.createdAt,
      updatedAt: branch.updatedAt,
      runner: branch.overrides.runner,
      searchText: joined([
        branch.conversationId,
        branch.profileId,
        branch.profileSnapshotId,
        branch.connectionId,
        branch.environmentId,
        branch.overrides.model,
        branch.overrides.effort,
        branch.overrides.mode,
      ]),
    })
  }
  for (const turn of state.turns) {
    add('turn', turn.id, {
      title: `turn ${turn.id}`,
      status: turnStatusForProjection(state, turn),
      createdAt: turn.createdAt,
      updatedAt: turn.updatedAt,
      searchText: joined([turn.conversationId, turn.branchId, turn.userMessageId, ...turn.runIds]),
    })
  }
  for (const run of state.runs) {
    add('run', run.id, {
      title: `run ${run.id}`,
      status: run.status,
      createdAt: run.startedAt,
      updatedAt: run.updatedAt,
      runner: run.receipt.requested.runner ?? run.receipt.provider,
      elapsedMs: elapsedMs(run.startedAt, run.terminalAt),
      costUsd: run.costUsd,
      searchText: joined([
        run.conversationId,
        run.branchId,
        run.turnId,
        run.operationId,
        run.model,
        run.connectionId,
        run.environmentId,
        run.providerSessionId,
        run.error,
      ]),
    })
  }
  for (const analysis of state.analyses) {
    add('analysis', analysis.id, {
      title: analysis.recipe ?? `analysis ${analysis.id}`,
      status: analysis.status,
      createdAt: analysis.createdAt,
      updatedAt: analysis.updatedAt,
      searchText: joined([
        analysis.source.conversationId,
        analysis.source.branchId,
        analysis.source.runId,
        analysis.question,
        analysis.recipe,
        analysis.analystProfileId,
      ]),
    })
  }
  for (const environment of state.environments) {
    add('environment', environment.id, {
      title: `environment ${environment.id}`,
      status: environment.lifecycle,
      createdAt: environment.createdAt,
      updatedAt: environment.updatedAt,
      runner: environment.placement.provider,
      searchText: joined([
        environment.workspaceId,
        environment.connectionId,
        environment.placement.provider,
        environment.placement.region,
        environment.placement.account,
        environment.repository,
        environment.gitRef,
        environment.workingDirectory,
        environment.image,
      ]),
    })
  }
  for (const checkpoint of state.checkpoints) {
    add('checkpoint', checkpoint.id, {
      title: `checkpoint ${checkpoint.id}`,
      status: checkpoint.status,
      createdAt: checkpoint.createdAt,
      updatedAt: checkpoint.createdAt,
      searchText: joined([
        checkpoint.sourceEnvironmentId,
        checkpoint.sourceBranchId,
        checkpoint.sourceRunId,
        checkpoint.throughMessageId,
        checkpoint.requestDigest,
        checkpoint.stateDigest,
      ]),
    })
  }
  for (const supervisor of state.supervisors) {
    add('supervisor', supervisor.id, {
      title: supervisor.title ?? `supervisor ${supervisor.id}`,
      status: supervisor.status,
      createdAt: supervisor.createdAt,
      updatedAt: supervisor.updatedAt,
      ...(supervisor.driverModel === undefined ? {} : { runner: supervisor.driverModel }),
      searchText: joined([
        supervisor.runtimeId,
        supervisor.runtimeRoot,
        supervisor.rootRunId,
        supervisor.title,
        supervisor.driverModel,
        supervisor.workerModel,
      ]),
    })
  }
  for (const worker of state.workers) {
    add('worker', worker.id, {
      title: worker.title ?? `worker ${worker.id}`,
      status: worker.status,
      createdAt: worker.createdAt,
      updatedAt: worker.updatedAt,
      elapsedMs: elapsedMs(worker.createdAt, worker.updatedAt),
      costUsd: worker.spendUsd,
      ...(worker.runner === undefined ? {} : { runner: worker.runner }),
      searchText: joined([
        worker.runtimeId,
        worker.supervisorId,
        worker.parentRuntimeRef,
        worker.parentWorkerId,
        worker.runId,
        worker.title,
        worker.runner,
        worker.logTail,
      ]),
    })
  }

  const existing = new Set(output.map((node) => semanticNodeKey(node.type, node.id)))
  for (const node of state.graphNodes) {
    if (!(SEMANTIC_NODE_TYPES as readonly string[]).includes(node.reference.kind)) continue
    const type = node.reference.kind as SemanticNodeType
    if (existing.has(semanticNodeKey(type, node.reference.id))) continue
    output.push(
      descriptor(
        type,
        node.reference.id,
        {
          title: node.title ?? `${type} ${node.reference.id}`,
          status: node.status ?? 'unknown',
          createdAt: node.createdAt,
          updatedAt: node.updatedAt,
          searchText: '',
        },
        node,
      ),
    )
  }
  return output
}
