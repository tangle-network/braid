import type {
  AgentProfile,
  PortableContextPlan as CanonicalPortableContextPlan,
  ContextTransferReceipt as PortableContextTransferReceipt,
  ContextTransferRequest as PortableContextTransferRequest,
} from '@tangle-network/agent-interface'
import { snapshotAgentProfile } from '../adapters/agent-interface/profile-runtime.js'
import type {
  ContextTransferReceipt,
  NativeContextBoundaryProof,
  PortableContextPlan,
} from '../domain/receipts.js'
import type { BraidState } from '../domain/state.js'
import type { SendInput } from './application-types.js'
import { continuationSessionFor } from './run-continuation.js'
import { snapshotWorkspaceRequest, type WorkspaceRequest } from './workspace-request.js'

/**
 * The private execution payload captured before a run can cross an async
 * boundary.  Its profile and all caller-owned nested values are independent
 * frozen copies; the durable receipt is intentionally a separate redacted
 * audit record.
 */
export interface RunExecutionSnapshot {
  readonly operationId: string
  readonly text: string
  readonly conversationId: string
  readonly branchId: string
  readonly profile: Readonly<AgentProfile>
  readonly mode?: string
  readonly connectionId?: string
  /** Provider-neutral remote workspace request. Separate from local workspaceRoot. */
  readonly workspaceRequest?: Readonly<WorkspaceRequest>
  readonly workspaceRoot?: string
  readonly sessionId?: string
  /** Distinguishes the private linear continuation from caller-supplied reuse. */
  readonly sessionSource?: 'caller' | 'continuation'
  readonly contextPlan?: PortableContextPlan
  readonly contextTransfer?: ContextTransferReceipt
  readonly portableContextPlan?: CanonicalPortableContextPlan
  readonly portableContextTransferRequest?: PortableContextTransferRequest
  readonly portableContextTransferReceipt?: PortableContextTransferReceipt
  readonly nativeContextBoundaryProof?: NativeContextBoundaryProof
}

export function snapshotRunExecution(
  input: SendInput,
  state: BraidState,
  profile: Readonly<AgentProfile>,
  connectionId: string | undefined,
  mode?: string,
  workspaceRequest?: WorkspaceRequest,
): RunExecutionSnapshot {
  const workspaceSnapshot = snapshotWorkspaceRequest(workspaceRequest)
  const snapshot = {
    operationId: input.operationId,
    text: input.text,
    conversationId: input.conversationId ?? state.conversationId,
    branchId: input.branchId ?? state.branchId,
    profile: snapshotAgentProfile(profile),
    ...(mode === undefined ? {} : { mode }),
    ...(connectionId === undefined ? {} : { connectionId }),
    ...(workspaceSnapshot === undefined ? {} : { workspaceRequest: workspaceSnapshot }),
    ...(state.workspace === null ? {} : { workspaceRoot: state.workspace }),
    ...(input.sessionId === undefined
      ? (() => {
          const sessionId = continuationSessionFor({
            state,
            conversationId: input.conversationId ?? state.conversationId,
            branchId: input.branchId ?? state.branchId,
            profile,
            ...(connectionId === undefined ? {} : { connectionId }),
          })
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
    ...(input.portableContextTransferRequest === undefined
      ? {}
      : { portableContextTransferRequest: input.portableContextTransferRequest }),
    ...(input.portableContextTransferReceipt === undefined
      ? {}
      : { portableContextTransferReceipt: input.portableContextTransferReceipt }),
    ...(input.nativeContextBoundaryProof === undefined
      ? {}
      : { nativeContextBoundaryProof: input.nativeContextBoundaryProof }),
  }
  return freezeDeep(structuredClone(snapshot))
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}
