import { canonicalDigest } from '../domain/canonical.js'
import type { OperationKind, OperationRecord } from '../domain/entities.js'
import {
  type BranchId,
  type ConnectionId,
  type ConversationId,
  createBranchId,
  createConversationId,
  createDraftId,
  createOperationId,
  createQueueId,
  type DraftId,
  type OperationId,
  type ProfileId,
  parseConnectionId,
  parseProfileId,
  type QueueId,
} from '../domain/ids.js'
import { redactSensitiveText } from '../domain/redaction.js'
import type { BraidState } from '../domain/state.js'
import { operationId as parseApplicationOperationId } from './application-guards.js'
import type { ConversationHost } from './conversation-types.js'
import { AppError } from './errors.js'

export interface StableConversationIds {
  readonly conversationId: ConversationId
  readonly branchId: BranchId
  readonly draftId: DraftId
  readonly queueId: QueueId
}

export function normalizedTitle(value: string | undefined, fallback = 'New conversation'): string {
  const title = redactSensitiveText(value?.trim() || fallback, 1024).trim()
  if (!title) throw new AppError('INVALID_TITLE', 'Conversation title must not be empty')
  return title
}

export function requestDigest(command: string, request: Readonly<Record<string, unknown>>) {
  return canonicalDigest({ command, request })
}

function stableSuffix(operationId: OperationId, digest: string, label: string): string {
  return canonicalDigest({ operationId, digest, label }).slice(0, 32)
}

export function stableConversationIds(
  operationId: OperationId,
  digest: string,
  label = 'conversation',
): StableConversationIds {
  const suffix = stableSuffix(operationId, digest, label)
  return {
    conversationId: createConversationId(`conversation-${suffix}`),
    branchId: createBranchId(`branch-${suffix}`),
    draftId: createDraftId(`draft-${suffix}`),
    queueId: createQueueId(`queue-${suffix}`),
  }
}

export function stableBranchIds(
  operationId: OperationId,
  digest: string,
): Pick<StableConversationIds, 'branchId' | 'draftId' | 'queueId'> {
  const suffix = stableSuffix(operationId, digest, 'branch')
  return {
    branchId: createBranchId(`branch-${suffix}`),
    draftId: createDraftId(`draft-${suffix}`),
    queueId: createQueueId(`queue-${suffix}`),
  }
}

export function parseOperation(value: string, command: string): OperationId {
  return parseApplicationOperationId(value, command)
}

export function operationReplay(
  state: BraidState,
  id: OperationId,
  kind: OperationKind,
  digest: string,
): OperationRecord | undefined {
  const existing = state.operations.find((operation) => operation.id === id)
  if (!existing) return undefined
  if (existing.kind !== kind || existing.requestDigest !== digest) {
    throw new AppError(
      'OPERATION_ID_CONFLICT',
      `Operation ${id} was already used with different input`,
    )
  }
  return existing
}

export function acknowledgedOperation(input: {
  readonly id: OperationId
  readonly kind: OperationKind
  readonly digest: ReturnType<typeof canonicalDigest>
  readonly at: string
  readonly target?: OperationRecord['target']
  readonly result?: OperationRecord['result']
}): OperationRecord {
  return {
    id: input.id,
    kind: input.kind,
    requestDigest: input.digest,
    status: 'acknowledged',
    ...(input.target === undefined ? {} : { target: input.target }),
    ...(input.result === undefined ? {} : { result: input.result }),
    createdAt: input.at,
    updatedAt: input.at,
    acknowledgedAt: input.at,
  }
}

export function requireWorkspace(state: BraidState): NonNullable<BraidState['workspaceId']> {
  if (state.workspaceId === null || state.workspace === null) {
    throw new AppError('NOT_INITIALIZED', 'Initialize a workspace first')
  }
  return state.workspaceId
}

export function selectedProfile(
  state: BraidState,
  value: string | undefined,
): ProfileId | undefined {
  if (value === undefined) return state.selectedProfileId ?? undefined
  const id = parseProfileId(value)
  if (!state.profiles.some((profile) => profile.id === id)) {
    throw new AppError('UNKNOWN_PROFILE', `Profile ${id} does not exist`)
  }
  return id
}

export function selectedConnection(
  state: BraidState,
  value: string | undefined,
): ConnectionId | undefined {
  if (value === undefined) return state.selectedConnectionId ?? undefined
  const id = parseConnectionId(value)
  if (!state.connections.some((connection) => connection.id === id)) {
    throw new AppError('UNKNOWN_CONNECTION', `Connection ${id} does not exist`)
  }
  return id
}

export function derivedOperationId(value: string): OperationId {
  return createOperationId(`operation-${canonicalDigest(value).slice(0, 32)}`)
}

export function coordinateConversationOperation<T>(
  host: ConversationHost,
  command: string,
  input: object & { readonly operationId: string },
  action: () => Promise<T>,
): Promise<T> {
  const operationId = parseOperation(input.operationId, command)
  const request = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  )
  const digest = requestDigest(`in-flight:${command}`, request)
  return host.coordinate?.({ operationId, digest }, action) ?? action()
}
