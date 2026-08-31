import { snapshotAgentProfile } from '../adapters/agent-interface/profile-runtime.js'
import { canonicalDigest } from '../domain/canonical.js'
import type { PortableContextPlan } from '../domain/receipts.js'
import type { ExecuteTurnInput } from '../ports/execution.js'
import type { RunExecutionSnapshot } from './run-execution-snapshot.js'
import { snapshotWorkspaceRequest } from './workspace-request.js'

export const RUN_EFFECT_KIND = 'run.execute'

export function runEffectRequest(input: RunExecutionSnapshot): Readonly<Record<string, unknown>> {
  const workspaceRequest = snapshotWorkspaceRequest(input.workspaceRequest)
  return {
    conversationId: input.conversationId,
    branchId: input.branchId,
    text: input.text,
    profile: input.profile,
    connectionId: input.connectionId ?? null,
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(workspaceRequest === undefined ? {} : { workspaceRequest }),
    ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
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
}

export function exactAdmissionRequestDigest(
  input: ExecuteTurnInput,
  conversationId: string,
  branchId: string,
  contextPlan?: PortableContextPlan,
): string {
  const workspaceRequest = snapshotWorkspaceRequest(input.workspaceRequest)
  return canonicalDigest({
    effectKind: RUN_EFFECT_KIND,
    request: {
      conversationId,
      branchId,
      text: input.text,
      profile: snapshotAgentProfile(input.profile),
      connectionId: input.connectionId ?? null,
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      ...(workspaceRequest === undefined ? {} : { workspaceRequest }),
      ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
      ...(input.interactions === undefined ? {} : { interactions: input.interactions }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(contextPlan === undefined ? {} : { contextPlan }),
      ...(input.nativeContextBoundaryProof === undefined
        ? {}
        : { nativeContextBoundaryProof: input.nativeContextBoundaryProof }),
      ...(input.contextTransfer === undefined ? {} : { contextTransfer: input.contextTransfer }),
    },
  })
}
