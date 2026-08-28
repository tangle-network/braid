import type { AdmissionPort, AsyncAdmissionPort } from './application-ports.js'
import type { SendReceipt } from './application-types.js'
import { AppError } from './errors.js'
import { admitRun, admitRunAsync } from './run-admission-receipt.js'
import { RUN_EFFECT_KIND, runEffectRequest } from './run-admission-request.js'
import { validateContextPlan, validateNativeProof } from './run-admission-validation.js'
import type { RunExecutionSnapshot } from './run-execution-snapshot.js'
import { activeRunForBranch } from '../domain/state.js'

export function sendRun(context: AdmissionPort, input: RunExecutionSnapshot): SendReceipt {
  const state = context.currentState()
  if (state.workspace === null)
    throw new AppError('NOT_INITIALIZED', 'Initialize a workspace before sending')
  if (!input.operationId) throw new AppError('OPERATION_ID_REQUIRED', 'send requires operationId')
  if (!input.text.trim()) throw new AppError('EMPTY_MESSAGE', 'Message must not be empty')
  const conversationId = input.conversationId
  const branchId = input.branchId
  assertTargetBranch(state, conversationId, branchId)
  validateNativeProof(context, input)

  const request = runEffectRequest(input)
  const digest = context.fingerprint({ effectKind: RUN_EFFECT_KIND, request })
  const persisted = context.admitPersistedSend(input.operationId, digest)
  if (persisted) return persisted
  const active = activeRunForBranch(state, conversationId, branchId)
  if (active)
    throw new AppError(
      'RUN_ACTIVE',
      `Run ${active.id} is still active on this branch; queue the next input explicitly`,
    )
  validateContextPlan(input)

  const runId = context.ids.next('run')
  const turnId = context.ids.next('turn')
  if (input.contextTransfer && input.contextTransfer.destinationRunId !== runId)
    throw new AppError(
      'CONTEXT_RECEIPT_CONFLICT',
      'The context transfer receipt names a different destination run',
    )
  const admission = admitRun(
    context,
    {
      operationId: input.operationId,
      runId,
      text: input.text,
      profile: input.profile,
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
      ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
      signal: new AbortController().signal,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.contextPlan === undefined ? {} : { contextBoundary: input.contextPlan.digest }),
    },
    conversationId,
    branchId,
    input.contextTransfer,
    turnId,
    input.contextPlan?.digest,
    input.nativeContextBoundaryProof,
    input.contextPlan,
  )
  if (state.branchId === branchId && state.draft !== input.text)
    context.commit({ kind: 'draft.changed', text: input.text })
  context.commit({
    kind: 'run.requested',
    operationId: input.operationId,
    runId,
    turnId,
    userMessageId: context.ids.next('message'),
    assistantMessageId: context.ids.next('message'),
    text: input.text,
    requestDigest: digest,
    receipt: admission,
  })
  const abort = new AbortController()
  const operation = {
    digest,
    runId,
    admission,
    completion: Promise.resolve() as Promise<unknown>,
  }
  context.ledger.setOperation(operation)
  context.ledger.setAbort(runId, abort)
  operation.completion = context.startRun(input, admission, abort, digest)
  return {
    operationId: input.operationId,
    runId,
    revision: context.currentState().revision,
    replayed: false,
    admission,
    completion: operation.completion.then(() => structuredClone(context.currentState())),
  }
}

export async function sendRunAsync(
  context: AsyncAdmissionPort,
  input: RunExecutionSnapshot,
  ids: { readonly runId: string; readonly turnId: string },
  signal: AbortSignal = new AbortController().signal,
): Promise<SendReceipt> {
  assertAdmissionActive(signal)
  const state = context.currentState()
  if (state.workspace === null)
    throw new AppError('NOT_INITIALIZED', 'Initialize a workspace before sending')
  if (!input.operationId)
    throw new AppError('OPERATION_ID_REQUIRED', 'send requires a valid operationId')
  const conversationId = input.conversationId
  const branchId = input.branchId
  assertTargetBranch(state, conversationId, branchId)
  validateNativeProof(context, input)
  validateContextPlan(input)
  const request = runEffectRequest(input)
  const digest = context.fingerprint({ effectKind: RUN_EFFECT_KIND, request })
  const persisted = context.admitPersistedSend(input.operationId, digest)
  if (persisted) return persisted
  const active = activeRunForBranch(state, conversationId, branchId)
  if (active)
    throw new AppError(
      'RUN_ACTIVE',
      `Run ${active.id} is still active on this branch; queue the next input explicitly`,
    )
  if (input.contextTransfer && input.contextTransfer.destinationRunId !== ids.runId)
    throw new AppError(
      'CONTEXT_RECEIPT_CONFLICT',
      'The context transfer receipt names a different destination run',
    )
  const admission = await admitRunAsync(
    context,
    {
      operationId: input.operationId,
      runId: ids.runId,
      text: input.text,
      profile: input.profile,
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
      ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
      signal,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.contextPlan === undefined ? {} : { contextBoundary: input.contextPlan.digest }),
    },
    conversationId,
    branchId,
    input.contextTransfer,
    ids.turnId,
    input.contextPlan?.digest,
    input.nativeContextBoundaryProof,
    input.contextPlan,
  )
  assertAdmissionActive(signal)
  if (state.branchId === branchId && state.draft !== input.text)
    await context.commitAndWait({ kind: 'draft.changed', text: input.text })
  assertAdmissionActive(signal)
  await context.commitAndWait({
    kind: 'run.requested',
    operationId: input.operationId,
    runId: ids.runId,
    turnId: ids.turnId,
    userMessageId: context.ids.next('message'),
    assistantMessageId: context.ids.next('message'),
    text: input.text,
    requestDigest: digest,
    receipt: admission,
  })
  assertAdmissionActive(signal)
  const abort = new AbortController()
  const operation = {
    digest,
    runId: ids.runId,
    admission,
    completion: Promise.resolve() as Promise<unknown>,
  }
  context.ledger.setOperation(operation)
  context.ledger.setAbort(ids.runId, abort)
  operation.completion = context.startRun(input, admission, abort, digest)
  return {
    operationId: input.operationId,
    runId: ids.runId,
    revision: context.currentState().revision,
    replayed: false,
    admission,
    completion: operation.completion.then(() => structuredClone(context.currentState())),
  }
}

function assertAdmissionActive(signal: AbortSignal): void {
  if (signal.aborted)
    throw new AppError('APPLICATION_CLOSING', 'Braid is closing and cannot materialize a run')
}

function assertTargetBranch(
  state: ReturnType<AdmissionPort['currentState']>,
  conversationId: string,
  branchId: string,
): void {
  if (conversationId === state.conversationId && branchId === state.branchId) return
  const conversation = state.conversations.find(
    (candidate) => candidate.id === conversationId && candidate.deletedAt === undefined,
  )
  const branch = state.branches.find(
    (candidate) => candidate.id === branchId && candidate.conversationId === conversationId,
  )
  if (!conversation || !branch) {
    throw new AppError('UNKNOWN_BRANCH', 'The requested conversation branch is unavailable')
  }
}
