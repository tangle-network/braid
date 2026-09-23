/** Branded identifiers for the durable Braid graph projection. */

declare const ID_BRAND: unique symbol

export type BrandedId<Name extends string> = string & {
  readonly [ID_BRAND]: Name
}

export type ConversationId = BrandedId<'ConversationId'>
export type BranchId = BrandedId<'BranchId'>
export type TurnId = BrandedId<'TurnId'>
export type RunId = BrandedId<'RunId'>
export type AnalysisId = BrandedId<'AnalysisId'>
export type EnvironmentId = BrandedId<'EnvironmentId'>
export type CheckpointId = BrandedId<'CheckpointId'>
export type SupervisorId = BrandedId<'SupervisorId'>
export type WorkerId = BrandedId<'WorkerId'>
export type GraphNodeId = BrandedId<'GraphNodeId'>
export type OperationId = BrandedId<'OperationId'>
export type GraphEdgeId = BrandedId<'GraphEdgeId'>
export type EventId = BrandedId<'EventId'>
export type Digest = BrandedId<'Digest'>

const idPattern = /^[A-Za-z][A-Za-z0-9._:-]{0,255}$/u

const prefixes = {
  conversation: ['conversation-', 'conv-'],
  branch: ['branch-'],
  turn: ['turn-'],
  run: ['run-'],
  analysis: ['analysis-'],
  environment: ['environment-', 'env-'],
  checkpoint: ['checkpoint-'],
  supervisor: ['supervisor-'],
  worker: ['worker-'],
  graphNode: ['node-'],
  operation: ['operation-', 'op-'],
  graphEdge: ['edge-'],
  event: ['event-'],
} as const

type IdKind = keyof typeof prefixes
type IdForKind = {
  conversation: ConversationId
  branch: BranchId
  turn: TurnId
  run: RunId
  analysis: AnalysisId
  environment: EnvironmentId
  checkpoint: CheckpointId
  supervisor: SupervisorId
  worker: WorkerId
  graphNode: GraphNodeId
  operation: OperationId
  graphEdge: GraphEdgeId
  event: EventId
}

function parseId<K extends IdKind>(kind: K, value: unknown): IdForKind[K] {
  if (
    typeof value !== 'string' ||
    !idPattern.test(value) ||
    (kind !== 'operation' && !prefixes[kind].some((prefix) => value.startsWith(prefix)))
  ) {
    throw new TypeError(`Invalid ${kind} identifier`)
  }
  return value as IdForKind[K]
}

export const conversationId = (value: string): ConversationId => parseId('conversation', value)
export const branchId = (value: string): BranchId => parseId('branch', value)
export const turnId = (value: string): TurnId => parseId('turn', value)
export const runId = (value: string): RunId => parseId('run', value)
export const analysisId = (value: string): AnalysisId => parseId('analysis', value)
export const environmentId = (value: string): EnvironmentId => parseId('environment', value)
export const checkpointId = (value: string): CheckpointId => parseId('checkpoint', value)
export const supervisorId = (value: string): SupervisorId => parseId('supervisor', value)
export const workerId = (value: string): WorkerId => parseId('worker', value)
export const graphNodeId = (value: string): GraphNodeId => parseId('graphNode', value)
export const operationId = (value: string): OperationId => parseId('operation', value)
export const graphEdgeId = (value: string): GraphEdgeId => parseId('graphEdge', value)
export const eventId = (value: string): EventId => parseId('event', value)

export const createConversationId = conversationId
export const createBranchId = branchId
export const createTurnId = turnId
export const createRunId = runId
export const createAnalysisId = analysisId
export const createEnvironmentId = environmentId
export const createCheckpointId = checkpointId
export const createSupervisorId = supervisorId
export const createWorkerId = workerId
export const createGraphNodeId = graphNodeId
export const createGraphEdgeId = graphEdgeId
export const createOperationId = operationId
export const createEventId = eventId

export function digest(value: string): Digest {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new TypeError('Invalid SHA-256 digest')
  return value as Digest
}

export const createDigest = digest

export function assertIdForKind(kind: IdKind, value: unknown): void {
  parseId(kind, value)
}
