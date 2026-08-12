import type { AgentExactRunControlRef } from '@tangle-network/agent-interface'
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
} from '../../ports/execution.js'
import { canonicalAgentProfileDigestHex } from '../agent-interface/profile-runtime.js'
import type {
  RetainedExecutionDriver,
  RetainedExecutionPlan,
} from './retained-execution-contract.js'
import { RetainedExecutionState, retainedExecutionKey } from './retained-execution-state.js'
import { streamRetainedExecution } from './retained-execution-stream.js'

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
    const plan = await this.#driver.resolve(input)
    this.#state.rememberPrepared(input.runId, retainedExecutionKey(input), plan)
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
    const plan = this.#state.takePrepared(input.runId, retainedExecutionKey(input))
    if (plan === undefined) {
      throw new Error('Retained run was not admitted with this exact request')
    }
    const starting = Promise.resolve().then(() => plan.start(input))
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

  async *reconnect(input: {
    readonly runId: string
    readonly after?: string
    readonly afterSequence?: number
    readonly providerSessionId?: string
    readonly controlRef?: AgentExactRunControlRef
    readonly signal: AbortSignal
  }): AsyncGenerator<RuntimeEventEnvelope> {
    if (input.after !== undefined && input.afterSequence === undefined) {
      throw new Error('Retained reconnect requires the saved event sequence')
    }
    const providerSessionId = this.#recoverySessionId(input.providerSessionId, input.controlRef)
    const plan = await this.#planFor(input.runId, providerSessionId, input.controlRef)
    const controlRef = await this.#controlRefFor(input.runId, plan, input.controlRef, input.signal)
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

  async detachRun(input: {
    readonly runId: string
    readonly operationId: string
    readonly providerSessionId?: string
    readonly controlRef?: AgentExactRunControlRef
    readonly cursor?: string
    readonly signal?: AbortSignal
  }): Promise<ControlAcknowledgement> {
    this.#validateKnownControl(input.runId, input.providerSessionId, input.controlRef)
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
    const resolved = await this.#handleFor(
      input.runId,
      input.providerSessionId,
      input.controlRef,
      input.signal,
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

  async status(input: {
    readonly runId: string
    readonly providerSessionId?: string
    readonly controlRef?: AgentExactRunControlRef
    readonly signal?: AbortSignal
  }): Promise<ProviderRunSnapshot | null> {
    const resolved = await this.#handleFor(
      input.runId,
      input.providerSessionId,
      input.controlRef,
      input.signal,
    )
    if (!resolved) return null
    if (resolved.plan.exactStatus === false) return null
    const snapshot = await resolved.handle.status({
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    const snapshotControlRef = this.#state.validateControlRef(
      input.runId,
      resolved.plan,
      snapshot.controlRef,
    )
    this.#state.assertSameControlRef(resolved.handle.controlRef, snapshotControlRef)
    const status = resolved.plan.projectStatus({
      status: snapshot.status,
      detached: this.#state.isDetached(input.runId),
    })
    const cursor = this.#state.lastCursor(input.runId)
    const base: ProviderRunSnapshot = {
      runId: input.runId,
      status,
      sessionId: resolved.handle.controlRef.sessionId,
      ...(cursor === undefined ? {} : { cursor }),
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

  async #handleFor(
    runId: string,
    providerSessionId: string | undefined,
    supplied: AgentExactRunControlRef | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ResolvedRetainedHandle | null> {
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
      if (supplied !== undefined) {
        const exact = this.#state.validateControlRef(runId, activePlan, supplied)
        this.#state.assertSameControlRef(handle.controlRef, exact)
      }
      return { handle, plan: activePlan, wasStarting: starting !== undefined }
    }
    if (activePlan !== undefined) {
      if (this.#state.isCancellationRequested(runId)) return null
    }
    const recoverySessionId = this.#recoverySessionId(providerSessionId, supplied)
    const plan = await this.#planFor(runId, recoverySessionId, supplied)
    const controlRef = await this.#controlRefFor(runId, plan, supplied, signal)
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
      const exact = this.#state.validateControlRef(input.runId, resolved.plan, snapshot.controlRef)
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
    if (supplied !== undefined) return this.#state.rememberControlRef(runId, plan, supplied)
    const cached = this.#state.controlRef(runId)
    if (cached !== undefined) return this.#state.rememberControlRef(runId, plan, cached)
    const discovered = await plan.discover(runId, signal)
    if (discovered === null) return null
    return this.#state.rememberControlRef(runId, plan, discovered)
  }

  async #planFor(
    runId: string,
    providerSessionId?: string,
    controlRef?: AgentExactRunControlRef,
  ): Promise<RetainedExecutionPlan> {
    const cached = this.#state.plan(runId)
    if (cached !== undefined) {
      this.#state.assertProviderSession(cached, providerSessionId)
      return cached
    }
    const plan = await this.#driver.recover({
      runId,
      ...(providerSessionId === undefined ? {} : { providerSessionId }),
      ...(controlRef === undefined ? {} : { controlRef }),
    })
    this.#state.assertProviderSession(plan, providerSessionId)
    this.#state.rememberPlan(runId, plan)
    return plan
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
    const exact = this.#state.validateControlRef(runId, plan, controlRef)
    const saved = this.#state.controlRef(runId)
    if (saved !== undefined) this.#state.assertSameControlRef(saved, exact)
  }
}
