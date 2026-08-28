import { snapshotAgentProfile } from '../adapters/agent-interface/profile-runtime.js'
import { canonicalDigest } from '../domain/canonical.js'
import type { PortableContextPlan } from '../domain/receipts.js'
import type { ExecuteTurnInput } from '../ports/execution.js'
import type { RunExecutionSnapshot } from './run-execution-snapshot.js'

export const RUN_EFFECT_KIND = 'run.execute'

export function runEffectRequest(input: RunExecutionSnapshot): Readonly<Record<string, unknown>> {
  return {
    conversationId: input.conversationId,
    branchId: input.branchId,
    text: input.text,
    profile: input.profile,
    connectionId: input.connectionId ?? null,
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.contextPlan === undefined ? {} : { contextPlan: input.contextPlan }),
    ...(input.contextTransfer === undefined ? {} : { contextTransfer: input.contextTransfer }),
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
  return canonicalDigest({
    effectKind: RUN_EFFECT_KIND,
    request: {
      conversationId,
      branchId,
      text: input.text,
      profile: snapshotAgentProfile(input.profile),
      connectionId: input.connectionId ?? null,
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      ...(input.interactions === undefined ? {} : { interactions: input.interactions }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(contextPlan === undefined ? {} : { contextPlan }),
      ...(input.nativeContextBoundaryProof === undefined
        ? {}
        : { nativeContextBoundaryProof: input.nativeContextBoundaryProof }),
    },
  })
}
