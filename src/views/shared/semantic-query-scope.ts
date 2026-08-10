import type { BraidState } from '../../domain/state.js'
import { SEMANTIC_NODE_TYPES, type SemanticNodeType } from './semantic-query-types.js'

export class SemanticQueryError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SemanticQueryError'
    this.code = code
  }
}

export interface SemanticQueryScope {
  readonly conversationId?: string
  readonly branchId?: string
}

export function resolveScope(
  state: BraidState,
  input: { readonly conversationId?: string; readonly branchId?: string },
): SemanticQueryScope {
  const conversation =
    input.conversationId === undefined
      ? undefined
      : state.conversations.find((candidate) => candidate.id === input.conversationId)
  if (input.conversationId !== undefined && conversation === undefined) {
    throw new SemanticQueryError('UNKNOWN_CONVERSATION', 'The requested conversation is unknown')
  }

  const branch =
    input.branchId === undefined
      ? undefined
      : state.branches.find((candidate) => candidate.id === input.branchId)
  if (input.branchId !== undefined && branch === undefined) {
    throw new SemanticQueryError('UNKNOWN_BRANCH', 'The requested branch is unknown')
  }
  if (
    conversation !== undefined &&
    branch !== undefined &&
    conversation.id !== branch.conversationId
  ) {
    throw new SemanticQueryError(
      'BRANCH_SCOPE_CONFLICT',
      'The requested branch does not belong to the requested conversation',
    )
  }

  const conversationId = conversation?.id ?? branch?.conversationId
  const branchId = branch?.id
  return {
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(branchId === undefined ? {} : { branchId }),
  }
}

export function assertNodeType(value: string): SemanticNodeType {
  if ((SEMANTIC_NODE_TYPES as readonly string[]).includes(value)) {
    return value as SemanticNodeType
  }
  throw new SemanticQueryError('UNKNOWN_ENTITY_TYPE', `Unsupported entity type ${value}`)
}

export function assertRunScope(
  state: BraidState,
  runId: string,
  scope: SemanticQueryScope,
): BraidState['runs'][number] {
  const run = state.runs.find((candidate) => candidate.id === runId)
  if (run === undefined) throw new SemanticQueryError('UNKNOWN_RUN', 'The requested run is unknown')
  if (
    (scope.conversationId !== undefined && run.conversationId !== scope.conversationId) ||
    (scope.branchId !== undefined && run.branchId !== scope.branchId)
  ) {
    throw new SemanticQueryError(
      'RUN_SCOPE_CONFLICT',
      'The requested run is outside the query scope',
    )
  }
  return run
}

export function isInScope(
  state: BraidState,
  type: SemanticNodeType,
  id: string,
  scope: SemanticQueryScope,
): boolean {
  if (scope.conversationId === undefined && scope.branchId === undefined) return true
  switch (type) {
    case 'conversation':
      return scope.conversationId === undefined || id === scope.conversationId
    case 'branch': {
      const branch = state.branches.find((candidate) => candidate.id === id)
      return (
        branch !== undefined &&
        (scope.conversationId === undefined || branch.conversationId === scope.conversationId) &&
        (scope.branchId === undefined || branch.id === scope.branchId)
      )
    }
    case 'turn': {
      const turn = state.turns.find((candidate) => candidate.id === id)
      return (
        turn !== undefined &&
        (scope.conversationId === undefined || turn.conversationId === scope.conversationId) &&
        (scope.branchId === undefined || turn.branchId === scope.branchId)
      )
    }
    case 'run': {
      const run = state.runs.find((candidate) => candidate.id === id)
      return (
        run !== undefined &&
        (scope.conversationId === undefined || run.conversationId === scope.conversationId) &&
        (scope.branchId === undefined || run.branchId === scope.branchId)
      )
    }
    case 'analysis': {
      const analysis = state.analyses.find((candidate) => candidate.id === id)
      return (
        analysis !== undefined &&
        (scope.conversationId === undefined ||
          analysis.source.conversationId === scope.conversationId) &&
        (scope.branchId === undefined || analysis.source.branchId === scope.branchId)
      )
    }
    case 'environment': {
      const environment = state.environments.find((candidate) => candidate.id === id)
      if (environment === undefined) return false
      if (scope.branchId !== undefined) {
        return (
          state.branches.some(
            (branch) => branch.id === scope.branchId && branch.environmentId === environment.id,
          ) ||
          state.runs.some(
            (run) => run.branchId === scope.branchId && run.environmentId === environment.id,
          )
        )
      }
      return state.conversations.some(
        (conversation) =>
          conversation.id === scope.conversationId &&
          conversation.workspaceId === environment.workspaceId,
      )
    }
    case 'checkpoint': {
      const checkpoint = state.checkpoints.find((candidate) => candidate.id === id)
      return (
        checkpoint !== undefined &&
        (scope.conversationId === undefined ||
          state.branches.some(
            (branch) =>
              branch.id === checkpoint.sourceBranchId &&
              branch.conversationId === scope.conversationId,
          )) &&
        (scope.branchId === undefined || checkpoint.sourceBranchId === scope.branchId)
      )
    }
    case 'supervisor': {
      const supervisor = state.supervisors.find((candidate) => candidate.id === id)
      if (supervisor?.rootRunId === undefined) return false
      const run = state.runs.find((candidate) => candidate.id === supervisor.rootRunId)
      return (
        run !== undefined &&
        (scope.conversationId === undefined || run.conversationId === scope.conversationId) &&
        (scope.branchId === undefined || run.branchId === scope.branchId)
      )
    }
    case 'worker': {
      const worker = state.workers.find((candidate) => candidate.id === id)
      if (worker === undefined) return false
      return isInScope(state, 'supervisor', worker.supervisorId, scope)
    }
  }
}
