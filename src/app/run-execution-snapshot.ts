import type { AgentProfile } from '@tangle-network/agent-interface'
import { snapshotAgentProfile } from '@tangle-network/agent-interface/profile-snapshot'
import type { BraidState } from '../domain/state.js'
import type { RunExecutionSnapshot, SendInput } from './application-types.js'
import { continuationSessionFor } from './run-continuation.js'
import { firstTurnHandoffContext } from './run-handoff-context.js'
import { resolveConversationTarget } from './run-targets.js'
import { snapshotWorkspaceRequest, type WorkspaceRequest } from './workspace-request.js'

export type { RunExecutionSnapshot } from './application-types.js'

export function snapshotRunExecution(
  input: SendInput,
  state: BraidState,
  profile: Readonly<AgentProfile>,
  connectionId: string | undefined,
  mode?: string,
  workspaceRequest?: WorkspaceRequest,
): RunExecutionSnapshot {
  const original = state.runs.find((run) => run.operationId === input.operationId)?.receipt
  const target = {
    conversationId: input.conversationId ?? original?.conversationId ?? state.conversationId,
    branchId: input.branchId ?? original?.branchId ?? state.branchId,
  }
  const handoff =
    original === undefined
      ? firstTurnHandoffContext(state, input, target.branchId, profile, connectionId)
      : undefined
  const transferRequest =
    input.portableContextTransferRequest ??
    original?.requested.portableContextTransferRequest ??
    handoff?.request
  const transferReceipt =
    input.portableContextTransferReceipt ??
    original?.requested.portableContextTransferReceipt ??
    handoff?.receipt
  const workspaceSnapshot = snapshotWorkspaceRequest(
    original?.requested.workspaceRequest ??
      input.workspaceRequest ??
      handoff?.request.workspace ??
      workspaceRequest,
  )
  const workspaceRoot = original === undefined ? state.workspace : original.requested.workspaceRoot
  const selectedConnection = original === undefined ? connectionId : original.requested.connectionId
  const expectedConnectionDigest =
    input.expectedConnectionDigest ??
    original?.requested.expectedConnectionDigest ??
    handoff?.connectionDigest
  const selectedMode = input.mode ?? (original === undefined ? mode : original.requested.mode)
  const nativeProof = input.nativeContextBoundaryProof ?? original?.nativeContextBoundaryProof
  const snapshot = {
    operationId: input.operationId,
    text: input.text,
    ...target,
    profile: snapshotAgentProfile(profile),
    ...(selectedMode === undefined ? {} : { mode: selectedMode }),
    ...(selectedConnection === undefined ? {} : { connectionId: selectedConnection }),
    ...(expectedConnectionDigest === undefined ? {} : { expectedConnectionDigest }),
    ...(workspaceSnapshot === undefined ? {} : { workspaceRequest: workspaceSnapshot }),
    ...(workspaceRoot == null ? {} : { workspaceRoot }),
    ...(input.sessionId === undefined
      ? (() => {
          const sessionId =
            transferReceipt?.sessionId ??
            (original === undefined
              ? continuationSessionFor({
                  state,
                  ...target,
                  profile,
                  ...(connectionId === undefined ? {} : { connectionId }),
                })
              : original.requestedSessionId)
          return sessionId === undefined
            ? {}
            : { sessionId, sessionSource: 'continuation' as const }
        })()
      : { sessionId: input.sessionId, sessionSource: 'caller' as const }),
    ...(input.contextPlan === undefined ? {} : { contextPlan: input.contextPlan }),
    ...(input.contextTransfer === undefined ? {} : { contextTransfer: input.contextTransfer }),
    ...(input.portableContextPlan === undefined
      ? {}
      : { portableContextPlan: input.portableContextPlan }),
    ...(transferRequest === undefined ? {} : { portableContextTransferRequest: transferRequest }),
    ...(transferReceipt === undefined ? {} : { portableContextTransferReceipt: transferReceipt }),
    ...(nativeProof === undefined ? {} : { nativeContextBoundaryProof: nativeProof }),
  }
  return freezeDeep(structuredClone(snapshot))
}

export function snapshotRunRetry(
  input: SendInput,
  state: BraidState,
  original: RunExecutionSnapshot,
): RunExecutionSnapshot {
  const target = resolveConversationTarget(state, input, original)
  const supplied = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  )
  return freezeDeep(structuredClone({ ...original, ...supplied, ...target }))
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}
