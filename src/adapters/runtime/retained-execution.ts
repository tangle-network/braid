import type {
  AgentExactRunControlRef,
  InteractionAcknowledgementStatus,
  InteractionResponseCommand,
} from '@tangle-network/agent-interface'
import type { RetainedRunHandle } from '@tangle-network/agent-runtime/kernel'
import { canonicalDigest } from '../../domain/canonical.js'
import type { RuntimeEventEnvelope } from '../../domain/runtime-events.js'
import type {
  CancelRunInput,
  ControlAcknowledgement,
  ExecuteTurnInput,
  ExecutionAdmission,
  ExecutionPort,
  ProviderRunSnapshot,
  RetainedExecutionRecoveryContext,
  RetainedRunAdmissionRecord,
  RetainedRunAdmissionRecorder,
} from '../../ports/execution.js'
import { runSupportsNativeContinuation } from '../../ports/execution.js'
import { canonicalAgentProfileDigestHex } from '../agent-interface/profile-runtime.js'
import type {
  RetainedExecutionDriver,
  RetainedExecutionPlan,
} from './retained-execution-contract.js'
import { RetainedExecutionState, retainedExecutionKey } from './retained-execution-state.js'
import { streamRetainedExecution } from './retained-execution-stream.js'
import {
  continueRetainedNative,
  controlRefFromBoundaryProof,
  nativeContinuationInputFromRecovery,
} from './retained-native-continuation.js'

export type {
  RetainedExecutionDriver,
  RetainedExecutionPlan,
  RetainedResultProjection,
} from './retained-execution-contract.js'

interface ResolvedRetainedHandle {
  readonly handle: RetainedRunHandle
  readonly plan: RetainedExecutionPlan
  readonly wasStarting: boolean
}

/** Provider-neutral durable execution lifecycle used by Braid adapters. */
export class RetainedExecutionPort implements ExecutionPort {
  readonly admissionMode = 'async' as const
  readonly #driver: RetainedExecutionDriver
  readonly #state = new RetainedExecutionState()

  constructor(driver: RetainedExecutionDriver) {
    this.#driver = driver
  }

  async admit(input: ExecuteTurnInput): Promise<ExecutionAdmission> {
    const continueNative = this.#driver.continue
    let plan: RetainedExecutionPlan
    if (input.nativeContextBoundaryProof === undefined) {
      plan = await this.#driver.resolve(input)
    } else {
      if (continueNative === undefined) {
        throw new Error('Provider does not implement verified same-session continuation')
      }
      plan = await continueNative(
        input,
        controlRefFromBoundaryProof(input.nativeContextBoundaryProof),
      )
    }
    if (
      input.nativeContextBoundaryProof !== undefined &&
      !runSupportsNativeContinuation(plan.capabilities)
    ) {
      throw new Error('Provider does not support verified same-session continuation')
    }
    this.#state.rememberPrepared(input.runId, retainedExecutionKey(input, plan.capabilities), plan)
    return {
      capabilities: plan.capabilities,
      provider: plan.providerName,
      ...(plan.environmentId === undefined ? {} : { environmentId: plan.environmentId }),
      ...(plan.providerSessionId === undefined
        ? {}
        : { providerSessionId: plan.providerSessionId }),
      materializationReceipt: plan.materializationReceipt,
      profileDigest: canonicalAgentProfileDigestHex(input.profile),
      capabilitiesDigest: canonicalDigest(plan.capabilities),
      materializationDigest: canonicalDigest(plan.materializationReceipt),
    }
  }

  async *streamTurn(input: ExecuteTurnInput): AsyncGenerator<RuntimeEventEnvelope> {
    if (this.#state.isCancellationRequested(input.runId)) return
    const prepared = this.#state.preparedPlan(input.runId)
    const plan = this.#state.takePrepared(
      input.runId,
      retainedExecutionKey(input, prepared?.capabilities),
    )
    if (plan === undefined) {
      throw new Error('Retained run was not admitted with this exact request')
    }
    const starting = Promise.resolve().then(() =>
      input.nativeContextBoundaryProof === undefined
        ? plan.start(input)
        : continueRetainedNative(plan, input),
    )
    this.#state.rememberStartingHandle(input.runId, starting)
    let handle: RetainedRunHandle
    try {
      handle = await starting
      this.#state.rememberHandle(input.runId, plan, handle)
    } finally {
      this.#state.clearStartingHandle(input.runId, starting)
    }
    if (this.#state.isDetached(input.runId)) return
    this.#state.markDetached(input.runId, false)
    yield* streamRetainedExecution({
      runId: input.runId,
      handle,
      plan,
      state: this.#state,
      signal: input.signal,
      includeObservation: true,
      afterSequence: 0,
    })
  }

  async *reconnect(
    input: {
      readonly runId: string
      readonly after?: string
      readonly afterSequence?: number
      readonly providerSessionId?: string
      readonly controlRef?: AgentExactRunControlRef
      readonly signal: AbortSignal
    } & RetainedExecutionRecoveryContext & {
        readonly onRetainedAdmission?: RetainedRunAdmissionRecorder
      },
  ): AsyncGenerator<RuntimeEventEnvelope> {
    if (input.after !== undefined && input.afterSequence === undefined) {
      throw new Error('Retained reconnect requires the saved event sequence')
    }
    assertRecoveryIdentity(input.retainedAdmission, input.providerSessionId, input.controlRef)
    const persistedControlRef = controlRefFromAdmission(input.retainedAdmission)
    const suppliedControlRef = input.controlRef ?? persistedControlRef
    const continuationInput =
      suppliedControlRef === undefined
        ? nativeContinuationInputFromRecovery(input.runId, input, input.signal)
        : undefined
    const recoveryControlRef =
      continuationInput === undefined
        ? suppliedControlRef
        : controlRefFromBoundaryProof(continuationInput.nativeContextBoundaryProof)
    const providerSessionId = this.#recoverySessionId(input.providerSessionId, recoveryControlRef)
    const plan = await this.#planFor(
      input.runId,
      providerSessionId,
      recoveryControlRef,
      input,
      input.signal,
    )
    if (continuationInput !== undefined) {
      if (!runSupportsNativeContinuation(plan.capabilities)) {
        throw new Error('Provider does not support verified same-session continuation')
      }
      const handle = await continueRetainedNative(plan, continuationInput)
      this.#state.rememberHandle(input.runId, plan, handle)
      this.#state.markDetached(input.runId, false)
      yield* streamRetainedExecution({
        runId: input.runId,
        handle,
        plan,
        state: this.#state,
        signal: input.signal,
        includeObservation: true,
        afterSequence: 0,
      })
      return
    }
    const recovered = await this.#recoverHandle(plan, input, input.onRetainedAdmission)
    if (recovered !== undefined) {
      if (recovered === null) return
      assertRecoveredControlRef(this.#state, plan, suppliedControlRef, recovered)
      this.#state.rememberHandle(input.runId, plan, recovered)
      this.#state.markDetached(input.runId, false)
      yield* streamRetainedExecution({
        runId: input.runId,
        handle: recovered,
        plan,
        state: this.#state,
        signal: input.signal,
        includeObservation: (input.afterSequence ?? 0) === 0,
        afterSequence: input.afterSequence ?? 0,
        ...(input.after === undefined ? {} : { after: input.after }),
      })
      return
    }
    const controlRef = await this.#controlRefFor(
      input.runId,
      plan,
      suppliedControlRef,
      input.signal,
    )
    if (!controlRef) return
    const handle = await plan.reconnect(controlRef, input.signal)
    if (!handle) return
    this.#state.rememberHandle(input.runId, plan, handle)
    this.#state.markDetached(input.runId, false)
    yield* streamRetainedExecution({
      runId: input.runId,
      handle,
      plan,
      state: this.#state,
      signal: input.signal,
      includeObservation: (input.afterSequence ?? 0) === 0,
      afterSequence: input.afterSequence ?? 0,
      ...(input.after === undefined ? {} : { after: input.after }),
    })
  }

  async detachRun(
    input: {
      readonly runId: string
      readonly operationId: string
      readonly providerSessionId?: string
      readonly controlRef?: AgentExactRunControlRef
      readonly cursor?: string
      readonly signal?: AbortSignal
    } & RetainedExecutionRecoveryContext,
  ): Promise<ControlAcknowledgement> {
    assertRecoveryIdentity(input.retainedAdmission, input.providerSessionId, input.controlRef)
    const persistedControlRef = controlRefFromAdmission(input.retainedAdmission)
    const suppliedControlRef = input.controlRef ?? persistedControlRef
    const recoverySessionId = this.#recoverySessionId(input.providerSessionId, suppliedControlRef)
    if (
      this.#state.plan(input.runId) === undefined &&
      (input.retainedAdmission !== undefined || recoverySessionId !== undefined)
    ) {
      const plan = await this.#planFor(
        input.runId,
        recoverySessionId,
        suppliedControlRef,
        input,
        input.signal,
      )
      if (suppliedControlRef !== undefined) this.#state.validateControlRef(plan, suppliedControlRef)
    }
    this.#validateKnownControl(input.runId, input.providerSessionId, suppliedControlRef)
    if (this.#state.isDetached(input.runId)) {
      return { operationId: input.operationId, outcome: 'already-applied', detail: 'detached' }
    }
    const reader = this.#state.reader(input.runId)
    this.#state.markDetached(input.runId, true)
    reader?.abort(new DOMException('Braid detached from the retained run', 'AbortError'))
    return { operationId: input.operationId, outcome: 'accepted', detail: 'detached' }
  }

  async cancelRun(
    input: CancelRunInput & { readonly signal?: AbortSignal },
  ): Promise<ControlAcknowledgement> {
    this.#validateKnownControl(input.runId, input.providerSessionId, input.controlRef)
    if (this.#state.isCancellationRequested(input.runId)) {
      return {
        operationId: input.operationId,
        outcome: 'already-applied',
        detail: 'cancelled-before-start',
      }
    }
    if (this.#state.hasPrepared(input.runId)) {
      this.#state.markCancellationRequested(input.runId)
      this.#state.discardPrepared(input.runId)
      return {
        operationId: input.operationId,
        outcome: 'accepted',
        detail: 'cancelled-before-start',
      }
    }
    const retainedIntent =
      input.retainedAdmission?.phase === 'intent' ? input.retainedAdmission : undefined
    const active = this.#state.handle(input.runId)
    const starting = this.#state.startingHandle(input.runId)
    if (active === undefined && starting === undefined && retainedIntent !== undefined) {
      if (
        input.controlRef !== undefined ||
        (input.providerSessionId !== undefined &&
          input.providerSessionId !== retainedIntent.sessionId)
      ) {
        return {
          operationId: input.operationId,
          outcome: 'rejected',
          detail: 'retained-intent-control-mismatch',
        }
      }
      this.#state.markCancellationRequested(input.runId)
      return {
        operationId: input.operationId,
        outcome: 'accepted',
        detail: 'cancelled-before-start',
      }
    }
    const resolved = await this.#handleFor(
      input.runId,
      input.providerSessionId,
      input.controlRef,
      input.signal,
      input,
    )
    if (!resolved) {
      return {
        operationId: input.operationId,
        outcome: 'unknown',
        detail: 'Retained run was not found',
      }
    }
    const cancelSignal = resolved.wasStarting || input.signal?.aborted ? undefined : input.signal
    const result = await resolved.handle.cancel({
      operationId: input.operationId,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(cancelSignal === undefined ? {} : { signal: cancelSignal }),
    })
    if (result.status === 'conflict') {
      return { operationId: input.operationId, outcome: 'rejected', detail: result.effect }
    }
    if (result.status === 'unknown') {
      return { operationId: input.operationId, outcome: 'unknown', detail: result.effect }
    }
    if (result.effect === 'cancel_requested') {
      return {
        operationId: input.operationId,
        outcome: 'unknown',
        detail: 'cancel_requested',
      }
    }
    let effect = result.effect
    if (effect === 'unknown' || effect === 'not_live') {
      if (resolved.plan.exactStatus === false) {
        return { operationId: input.operationId, outcome: 'unknown', detail: result.effect }
      }
      const reconciled = await this.#reconcileCancelled(resolved, input)
      if (!reconciled) {
        return { operationId: input.operationId, outcome: 'unknown', detail: result.effect }
      }
      effect = 'cancelled'
    }
    if (effect !== 'cancelled') {
      return { operationId: input.operationId, outcome: 'unknown', detail: effect }
    }
    this.#state.reader(input.runId)?.abort(new DOMException('Retained run cancelled', 'AbortError'))
    this.#state.markDetached(input.runId, false)
    return {
      operationId: input.operationId,
      outcome: result.status === 'replayed' ? 'already-applied' : 'accepted',
      detail: effect,
    }
  }

  async status(
    input: {
      readonly runId: string
      readonly providerSessionId?: string
      readonly controlRef?: AgentExactRunControlRef
      readonly signal?: AbortSignal
    } & RetainedExecutionRecoveryContext,
  ): Promise<ProviderRunSnapshot | null> {
    if (
      input.controlRef === undefined &&
      controlRefFromAdmission(input.retainedAdmission) === undefined
    ) {
      const continuation = nativeContinuationInputFromRecovery(
        input.runId,
        input,
        input.signal ?? new AbortController().signal,
      )
      if (continuation !== undefined) {
        return {
          runId: input.runId,
          status: 'reconnecting',
          sessionId: continuation.nativeContextBoundaryProof.sessionId,
        }
      }
    }
    const resolved = await this.#handleFor(
      input.runId,
      input.providerSessionId,
      input.controlRef,
      input.signal,
      input,
    )
    if (!resolved) return null
    if (resolved.plan.exactStatus === false) return null
    const snapshot = await resolved.handle.status({
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    const snapshotControlRef = this.#state.validateControlRef(resolved.plan, snapshot.controlRef)
    this.#state.assertSameControlRef(resolved.handle.controlRef, snapshotControlRef)
    const status = resolved.plan.projectStatus({
      status: snapshot.status,
      detached: this.#state.isDetached(input.runId),
    })
    const base: ProviderRunSnapshot = {
      runId: input.runId,
      status,
      sessionId: resolved.handle.controlRef.sessionId,
    }
    if (!resolved.plan.isTerminalStatus(status)) return base
    if (status === 'cancelled' || status === 'expired') return base
    try {
      const projected = resolved.plan.projectResult(await resolved.handle.result())
      return {
        ...base,
        finalText: projected.text,
        usage: projected.usage,
        ...(projected.error === undefined ? {} : { error: projected.error }),
      }
    } catch (error) {
      return {
        ...base,
        error: error instanceof Error ? error.message : 'Retained result unavailable',
      }
    }
  }

  async respondInteraction(input: {
    readonly command: InteractionResponseCommand
    readonly signal?: AbortSignal
    readonly recovery?: RetainedExecutionRecoveryContext
  }): Promise<ControlAcknowledgement> {
    const { binding } = input.command
    const resolved = await this.#handleFor(
      binding.runId,
      binding.sessionId,
      undefined,
      input.signal,
      input.recovery,
    )
    if (!resolved) {
      return {
        operationId: input.command.operationId,
        outcome: 'unknown',
        detail: 'INTERACTION_RESPONSE_RUN_UNKNOWN',
      }
    }
    const exact = resolved.handle.controlRef
    if (
      binding.provider !== exact.provider ||
      binding.environmentId !== exact.environmentId ||
      binding.sessionId !== exact.sessionId ||
      binding.executionId !== exact.executionId
    ) {
      return {
        operationId: input.command.operationId,
        outcome: 'rejected',
        detail: 'INTERACTION_BINDING_MISMATCH',
      }
    }
    const acknowledgement = await resolved.handle.respondToInteraction(input.command, {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    if (
      acknowledgement.operationId !== input.command.operationId ||
      acknowledgement.commandDigest !== input.command.commandDigest ||
      canonicalDigest(acknowledgement.binding) !== canonicalDigest(input.command.binding)
    ) {
      return {
        operationId: input.command.operationId,
        outcome: 'rejected',
        detail: 'INTERACTION_ACKNOWLEDGEMENT_MISMATCH',
      }
    }
    return interactionAcknowledgement(input.command.operationId, acknowledgement.status)
  }

  async nativeBoundary(input: Parameters<NonNullable<ExecutionPort['nativeBoundary']>>[0]) {
    const resolved = await this.#handleFor(
      input.runId,
      input.sessionId,
      input.controlRef,
      input.signal,
      input,
    )
    if (!resolved) return null
    return resolved.handle.contextBoundary({
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
  }

  async #handleFor(
    runId: string,
    providerSessionId: string | undefined,
    supplied: AgentExactRunControlRef | undefined,
    signal: AbortSignal | undefined,
    recovery?: RetainedExecutionRecoveryContext & {
      readonly onRetainedAdmission?: RetainedRunAdmissionRecorder
    },
  ): Promise<ResolvedRetainedHandle | null> {
    assertRecoveryIdentity(recovery?.retainedAdmission, providerSessionId, supplied)
    const persistedControlRef = controlRefFromAdmission(recovery?.retainedAdmission)
    const suppliedControlRef = supplied ?? persistedControlRef
    const active = this.#state.handle(runId)
    const activePlan = this.#state.plan(runId)
    const starting = this.#state.startingHandle(runId)
    if (active !== undefined || starting !== undefined) {
      if (activePlan === undefined) throw new Error('Retained run state is incomplete')
      this.#state.assertProviderSession(activePlan, providerSessionId)
      let handle = active
      if (handle === undefined) {
        if (starting === undefined) throw new Error('Retained run state is incomplete')
        handle = await starting
      }
      if (suppliedControlRef !== undefined) {
        const exact = this.#state.validateControlRef(activePlan, suppliedControlRef)
        this.#state.assertSameControlRef(handle.controlRef, exact)
      }
      return { handle, plan: activePlan, wasStarting: starting !== undefined }
    }
    if (activePlan !== undefined) {
      if (this.#state.isCancellationRequested(runId)) return null
    }
    const recoverySessionId = this.#recoverySessionId(providerSessionId, suppliedControlRef)
    const plan = await this.#planFor(runId, recoverySessionId, suppliedControlRef, recovery, signal)
    const recovered = await this.#recoverHandle(plan, recovery, recovery?.onRetainedAdmission)
    if (recovered !== undefined) {
      if (recovered === null) return null
      assertRecoveredControlRef(this.#state, plan, suppliedControlRef, recovered)
      this.#state.rememberHandle(runId, plan, recovered)
      return { handle: recovered, plan, wasStarting: false }
    }
    const controlRef = await this.#controlRefFor(runId, plan, suppliedControlRef, signal)
    if (!controlRef) return null
    const handle = await plan.reconnect(controlRef, signal)
    if (handle) this.#state.rememberHandle(runId, plan, handle)
    return handle === null ? null : { handle, plan, wasStarting: false }
  }

  async #reconcileCancelled(
    resolved: ResolvedRetainedHandle,
    input: CancelRunInput & { readonly signal?: AbortSignal },
  ): Promise<boolean> {
    try {
      const signal = resolved.wasStarting || input.signal?.aborted ? undefined : input.signal
      const snapshot = await resolved.handle.status({
        ...(signal === undefined ? {} : { signal }),
      })
      const exact = this.#state.validateControlRef(resolved.plan, snapshot.controlRef)
      this.#state.assertSameControlRef(resolved.handle.controlRef, exact)
      return snapshot.status === 'cancelled'
    } catch {
      return false
    }
  }

  async #controlRefFor(
    runId: string,
    plan: RetainedExecutionPlan,
    supplied: AgentExactRunControlRef | undefined,
    signal: AbortSignal | undefined,
  ): Promise<AgentExactRunControlRef | null> {
    if (supplied !== undefined) return this.#state.validateControlRef(plan, supplied)
    const discovered = await plan.discover(runId, signal)
    if (discovered === null) return null
    return this.#state.validateControlRef(plan, discovered)
  }

  async #planFor(
    runId: string,
    providerSessionId?: string,
    controlRef?: AgentExactRunControlRef,
    recovery?: RetainedExecutionRecoveryContext,
    signal?: AbortSignal,
  ): Promise<RetainedExecutionPlan> {
    const cached = this.#state.plan(runId)
    if (cached !== undefined && !planNeedsRecoveryRefresh(cached, controlRef, recovery)) {
      this.#state.assertProviderSession(cached, providerSessionId)
      return cached
    }
    const plan = await this.#driver.recover({
      runId,
      ...(providerSessionId === undefined ? {} : { providerSessionId }),
      ...(controlRef === undefined ? {} : { controlRef }),
      ...(signal === undefined ? {} : { signal }),
      ...(recovery ?? {}),
    })
    this.#state.assertProviderSession(plan, providerSessionId)
    this.#state.rememberPlan(runId, plan)
    return plan
  }

  async #recoverHandle(
    plan: RetainedExecutionPlan,
    recovery:
      | (RetainedExecutionRecoveryContext & {
          readonly onRetainedAdmission?: RetainedRunAdmissionRecorder
        })
      | undefined,
    onRetainedAdmission: RetainedRunAdmissionRecorder | undefined,
  ): Promise<RetainedRunHandle | null | undefined> {
    const admission = recovery?.retainedAdmission
    if (
      admission === undefined ||
      plan.recover === undefined ||
      admission.phase === 'dispatched' ||
      admission.phase === 'interactive_intent' ||
      admission.phase === 'interactive_environment' ||
      admission.phase === 'interactive_started'
    ) {
      return undefined
    }
    const recovered = await plan.recover({
      ...recovery,
      admission,
      ...(onRetainedAdmission === undefined ? {} : { onRetainedAdmission }),
    })
    return admission.phase === 'environment' && recovered === null ? undefined : recovered
  }

  #recoverySessionId(
    providerSessionId: string | undefined,
    controlRef: AgentExactRunControlRef | undefined,
  ): string | undefined {
    if (
      providerSessionId !== undefined &&
      controlRef !== undefined &&
      providerSessionId !== controlRef.sessionId
    ) {
      throw new Error('retained provider session conflicts with the exact run reference')
    }
    return controlRef?.sessionId ?? providerSessionId
  }

  #validateKnownControl(
    runId: string,
    providerSessionId: string | undefined,
    controlRef: AgentExactRunControlRef | undefined,
  ): void {
    const plan = this.#state.plan(runId)
    if (plan === undefined) return
    this.#state.assertProviderSession(plan, providerSessionId)
    if (controlRef === undefined) return
    const exact = this.#state.validateControlRef(plan, controlRef)
    const active = this.#state.handle(runId)
    if (active !== undefined) this.#state.assertSameControlRef(active.controlRef, exact)
  }
}

function controlRefFromAdmission(
  admission: RetainedRunAdmissionRecord | undefined,
): AgentExactRunControlRef | undefined {
  return admission?.phase === 'dispatched' ? admission.controlRef : undefined
}

function assertRecoveryIdentity(
  admission: RetainedRunAdmissionRecord | undefined,
  providerSessionId: string | undefined,
  supplied: AgentExactRunControlRef | undefined,
): void {
  if (admission === undefined) return
  const persistedSessionId = admissionSessionId(admission)
  if (providerSessionId !== undefined && providerSessionId !== persistedSessionId) {
    throw new Error('retained provider session conflicts with the persisted admission')
  }
  if (admission.phase !== 'dispatched') {
    if (supplied !== undefined) {
      throw new Error('retained control reference conflicts with the pre-dispatch admission')
    }
    return
  }
  if (
    supplied !== undefined &&
    canonicalDigest(supplied) !== canonicalDigest(admission.controlRef)
  ) {
    throw new Error('retained control reference conflicts with the persisted run')
  }
}

function admissionSessionId(admission: RetainedRunAdmissionRecord): string {
  switch (admission.phase) {
    case 'intent':
    case 'environment':
    case 'interactive_intent':
      return admission.sessionId
    case 'dispatched':
      return admission.controlRef.sessionId
    case 'interactive_environment':
      return admission.request.run.sessionId
    case 'interactive_started':
      return admission.ref.run.sessionId
  }
}

function environmentIdFromRecovery(
  admission: RetainedRunAdmissionRecord | undefined,
): string | undefined {
  if (admission?.phase === 'environment') return admission.environmentId
  if (admission?.phase === 'dispatched') return admission.controlRef.environmentId
  return undefined
}

function planNeedsRecoveryRefresh(
  plan: RetainedExecutionPlan,
  controlRef: AgentExactRunControlRef | undefined,
  recovery: RetainedExecutionRecoveryContext | undefined,
): boolean {
  const admission = recovery?.retainedAdmission
  if (
    admission !== undefined &&
    admission.phase !== 'dispatched' &&
    admission.phase !== 'interactive_intent' &&
    admission.phase !== 'interactive_environment' &&
    admission.phase !== 'interactive_started' &&
    plan.recover === undefined
  ) {
    return true
  }
  const environmentId =
    controlRef?.environmentId ?? environmentIdFromRecovery(recovery?.retainedAdmission)
  return environmentId !== undefined && plan.environmentId !== environmentId
}

function assertRecoveredControlRef(
  state: RetainedExecutionState,
  plan: RetainedExecutionPlan,
  supplied: AgentExactRunControlRef | undefined,
  recovered: RetainedRunHandle,
): void {
  if (supplied === undefined) return
  const exact = state.validateControlRef(plan, supplied)
  state.assertSameControlRef(recovered.controlRef, exact)
}

function interactionAcknowledgement(
  operationId: string,
  status: InteractionAcknowledgementStatus,
): ControlAcknowledgement {
  switch (status) {
    case 'accepted':
      return { operationId, outcome: 'accepted', detail: 'INTERACTION_RESPONSE_ACCEPTED' }
    case 'already_resolved_same':
      return { operationId, outcome: 'already-applied', detail: 'INTERACTION_RESPONSE_REPLAYED' }
    case 'already_resolved_different':
    case 'binding_mismatch':
    case 'cancelled':
    case 'expired':
    case 'invalid_response':
      return { operationId, outcome: 'rejected', detail: `INTERACTION_${status.toUpperCase()}` }
    case 'transport_failure':
    case 'unknown_interaction':
    case 'unknown_run':
      return { operationId, outcome: 'unknown', detail: `INTERACTION_${status.toUpperCase()}` }
  }
}
