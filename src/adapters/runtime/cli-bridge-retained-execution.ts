import {
  AgentExactRunControlRefSchema,
  type AgentExactRunControlRef,
} from '@tangle-network/agent-interface'
import type { RetainedRunHandle } from '@tangle-network/agent-runtime/kernel'
import { canonicalDigest } from '../../domain/canonical.js'
import { publicMaterializationReceipt } from '../../domain/materialization-receipt.js'
import type { RuntimeEventEnvelope } from '../../domain/runtime-events.js'
import type {
  CancelRunInput,
  ControlAcknowledgement,
  ExecuteTurnInput,
  ExecutionAdmission,
  ExecutionPort,
  ProviderRunSnapshot,
  RunCapabilities,
} from '../../ports/execution.js'
import { canonicalAgentProfileDigestHex } from '../agent-interface/profile-runtime.js'
import {
  createCliBridgeRetainedPlan,
  discoverCliBridgeControlRef,
  reconnectCliBridgeRetainedRun,
  startCliBridgeRetainedRun,
  type CliBridgeRetainedPlan,
} from './cli-bridge-retained-run.js'
import {
  finalRetainedEnvelope,
  isTerminalRetainedStatus,
  modelRequestsFromResult,
  retainedCapabilities,
  retainedExecutionKey,
  retainedStatus,
  retainedTurnUsage,
} from './cli-bridge-retained-projection.js'
import type { PreparedCliBridgeConnection } from './production-cli-bridge-backend.js'

export interface CliBridgeRetainedExecutionOptions {
  readonly resolve: (input: ExecuteTurnInput) => Promise<PreparedCliBridgeConnection>
  readonly recover: (input: {
    readonly runId: string
    readonly providerSessionId?: string
  }) => Promise<PreparedCliBridgeConnection>
}

interface PreparedRun {
  readonly key: string
  readonly plan: CliBridgeRetainedPlan
  readonly capabilities: RunCapabilities
  readonly materializationReceipt: Readonly<Record<string, unknown>>
}

const MAX_RETAINED_CLIENTS = 128

/** Braid's durable CLI-Bridge path. CLI-Bridge owns the job; this port owns readers. */
export class CliBridgeRetainedExecutionPort implements ExecutionPort {
  readonly admissionMode = 'async' as const
  readonly #options: CliBridgeRetainedExecutionOptions
  readonly #prepared = new Map<string, PreparedRun>()
  readonly #handles = new Map<string, RetainedRunHandle>()
  readonly #plans = new Map<string, CliBridgeRetainedPlan>()
  readonly #controlRefs = new Map<string, AgentExactRunControlRef>()
  readonly #readers = new Map<string, AbortController>()
  readonly #detached = new Set<string>()
  readonly #lastCursors = new Map<string, string>()
  readonly #retainedOrder: string[] = []

  constructor(options: CliBridgeRetainedExecutionOptions) {
    this.#options = options
  }

  async admit(input: ExecuteTurnInput): Promise<ExecutionAdmission> {
    const prepared = await this.#options.resolve(input)
    const plan = await createCliBridgeRetainedPlan(prepared, input.runId)
    const capabilities = retainedCapabilities(prepared)
    const materializationReceipt = publicMaterializationReceipt({
      ...prepared.materializationReceipt,
      backend: 'environment-provider',
      environmentId: plan.environmentId,
      providerRunId: plan.executionId,
      retainedControl: 'exact-after-dispatch',
    })
    const run = {
      key: retainedExecutionKey(input),
      plan,
      capabilities,
      materializationReceipt,
    }
    this.#prepared.set(input.runId, run)
    this.#rememberPlan(input.runId, plan)
    return {
      capabilities,
      provider: plan.provider.name,
      environmentId: plan.environmentId,
      providerSessionId: prepared.providerSessionId,
      materializationReceipt,
      profileDigest: canonicalAgentProfileDigestHex(input.profile),
      capabilitiesDigest: canonicalDigest(capabilities),
      materializationDigest: canonicalDigest(materializationReceipt),
    }
  }

  async *streamTurn(input: ExecuteTurnInput): AsyncGenerator<RuntimeEventEnvelope> {
    const prepared = this.#prepared.get(input.runId)
    if (!prepared || prepared.key !== retainedExecutionKey(input)) {
      throw new Error('CLI Bridge retained run was not admitted with this exact request')
    }
    this.#prepared.delete(input.runId)
    const handle = await startCliBridgeRetainedRun(prepared.plan, input)
    this.#rememberHandle(input.runId, handle, prepared.plan)
    this.#detached.delete(input.runId)
    yield* this.#streamHandle({
      runId: input.runId,
      handle,
      plan: prepared.plan,
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
      throw new Error('CLI Bridge reconnect requires the saved event sequence')
    }
    const providerSessionId = this.#recoverySessionId(
      input.runId,
      input.providerSessionId,
      input.controlRef,
    )
    const plan = await this.#planFor(input.runId, providerSessionId)
    const controlRef = await this.#controlRefFor(input.runId, plan, input.controlRef, input.signal)
    if (!controlRef) return
    const handle = await reconnectCliBridgeRetainedRun(plan, controlRef)
    if (!handle) return
    this.#rememberHandle(input.runId, handle, plan)
    this.#detached.delete(input.runId)
    yield* this.#streamHandle({
      runId: input.runId,
      handle,
      plan,
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
  }): Promise<ControlAcknowledgement> {
    const reader = this.#readers.get(input.runId)
    this.#detached.add(input.runId)
    if (!reader) {
      return { operationId: input.operationId, outcome: 'already-applied', detail: 'detached' }
    }
    reader.abort(new DOMException('Braid detached from the retained run', 'AbortError'))
    return { operationId: input.operationId, outcome: 'accepted', detail: 'detached' }
  }

  async cancelRun(
    input: CancelRunInput & { readonly signal?: AbortSignal },
  ): Promise<ControlAcknowledgement> {
    const handle = await this.#handleFor(
      input.runId,
      input.providerSessionId,
      input.controlRef,
      input.signal,
    )
    if (!handle) {
      return {
        operationId: input.operationId,
        outcome: 'unknown',
        detail: 'CLI Bridge retained run was not found',
      }
    }
    const result = await handle.cancel({
      operationId: input.operationId,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    if (result.status === 'conflict') {
      return { operationId: input.operationId, outcome: 'rejected', detail: result.effect }
    }
    if (result.status === 'unknown') {
      return { operationId: input.operationId, outcome: 'unknown', detail: result.effect }
    }
    this.#readers.get(input.runId)?.abort(new DOMException('Retained run cancelled', 'AbortError'))
    this.#detached.delete(input.runId)
    return {
      operationId: input.operationId,
      outcome: result.status === 'replayed' ? 'already-applied' : 'accepted',
      detail: result.effect,
    }
  }

  async status(input: {
    readonly runId: string
    readonly providerSessionId?: string
    readonly controlRef?: AgentExactRunControlRef
    readonly signal?: AbortSignal
  }): Promise<ProviderRunSnapshot | null> {
    const handle = await this.#handleFor(
      input.runId,
      input.providerSessionId,
      input.controlRef,
      input.signal,
    )
    if (!handle) return null
    const snapshot = await handle.status({
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    const status = retainedStatus(snapshot.status, this.#detached.has(input.runId))
    const cursor = this.#lastCursors.get(input.runId)
    const base: ProviderRunSnapshot = {
      runId: input.runId,
      status,
      sessionId: handle.controlRef.sessionId,
      ...(cursor === undefined ? {} : { cursor }),
    }
    if (!isTerminalRetainedStatus(status)) return base
    if (status === 'cancelled' || status === 'expired') return base
    try {
      const result = await handle.result()
      return {
        ...base,
        finalText: result.text,
        usage: retainedTurnUsage(
          result.usage,
          this.#plans.get(input.runId)?.prepared.route,
          modelRequestsFromResult(result),
        ),
        ...(result.error === undefined ? {} : { error: result.error }),
      }
    } catch (error) {
      return {
        ...base,
        error: error instanceof Error ? error.message : 'CLI Bridge retained result unavailable',
      }
    }
  }

  async *#streamHandle(input: {
    readonly runId: string
    readonly handle: RetainedRunHandle
    readonly plan: CliBridgeRetainedPlan
    readonly signal: AbortSignal
    readonly includeObservation: boolean
    readonly afterSequence: number
    readonly after?: string
  }): AsyncGenerator<RuntimeEventEnvelope> {
    const reader = new AbortController()
    this.#readers.get(input.runId)?.abort(new DOMException('Reader replaced', 'AbortError'))
    this.#readers.set(input.runId, reader)
    const signal = AbortSignal.any([input.signal, reader.signal])
    let sequence = input.afterSequence
    try {
      if (input.includeObservation) {
        sequence += 1
        const observedAt = new Date().toISOString()
        const observation = await input.plan.prepared.observation.snapshot()
        if (observation === undefined) {
          throw new Error('CLI Bridge execution observation is unavailable')
        }
        yield {
          runId: input.runId,
          eventId: `${input.runId}:execution-bound`,
          sequence,
          receivedAt: observedAt,
          event: {
            type: 'braid.execution.observed',
            observation,
            controlRef: input.handle.controlRef,
            timestamp: observedAt,
          },
        }
      }
      signal.throwIfAborted()
      const providerSequence = Math.max(0, input.afterSequence - 1)
      for await (const envelope of input.handle.events({
        ...(input.after === undefined
          ? {}
          : { after: { cursor: input.after, sequence: providerSequence } }),
        signal,
      })) {
        sequence = envelope.sequence + 1
        if (envelope.cursor !== undefined) this.#lastCursors.set(input.runId, envelope.cursor)
        yield { ...envelope, sequence }
      }
      const result = await input.handle.result()
      sequence += 1
      yield finalRetainedEnvelope(input.runId, sequence, input.plan.prepared.route, result)
    } finally {
      if (this.#readers.get(input.runId) === reader) this.#readers.delete(input.runId)
    }
  }

  async #handleFor(
    runId: string,
    providerSessionId: string | undefined,
    supplied: AgentExactRunControlRef | undefined,
    signal: AbortSignal | undefined,
  ): Promise<RetainedRunHandle | null> {
    const active = this.#handles.get(runId)
    if (active) {
      this.#recoverySessionId(runId, providerSessionId, active.controlRef)
      if (supplied !== undefined) {
        const exact = this.#validatedControlRef(runId, supplied)
        if (canonicalDigest(exact) !== canonicalDigest(active.controlRef)) {
          throw new Error('retained control reference conflicts with the active run')
        }
      }
      return active
    }
    const recoverySessionId = this.#recoverySessionId(runId, providerSessionId, supplied)
    const plan = await this.#planFor(runId, recoverySessionId)
    const controlRef = await this.#controlRefFor(runId, plan, supplied, signal)
    if (!controlRef) return null
    const handle = await reconnectCliBridgeRetainedRun(plan, controlRef)
    if (handle) this.#rememberHandle(runId, handle, plan)
    return handle
  }

  async #controlRefFor(
    runId: string,
    plan: CliBridgeRetainedPlan,
    supplied: AgentExactRunControlRef | undefined,
    signal: AbortSignal | undefined,
  ): Promise<AgentExactRunControlRef | null> {
    if (supplied !== undefined) {
      const exact = this.#validatedControlRef(runId, supplied)
      const cached = this.#controlRefs.get(runId)
      if (cached !== undefined && canonicalDigest(cached) !== canonicalDigest(exact)) {
        throw new Error('retained control reference conflicts with the saved run')
      }
      this.#rememberControlRef(runId, exact)
      return exact
    }
    const cached = this.#controlRefs.get(runId)
    if (cached) return cached
    const discovered = await discoverCliBridgeControlRef(plan, runId, signal)
    if (discovered) this.#rememberControlRef(runId, discovered)
    return discovered
  }

  async #planFor(runId: string, providerSessionId?: string): Promise<CliBridgeRetainedPlan> {
    const cached = this.#plans.get(runId)
    if (cached) {
      if (
        providerSessionId !== undefined &&
        cached.prepared.providerSessionId !== providerSessionId
      ) {
        throw new Error('retained provider session conflicts with the saved run')
      }
      return cached
    }
    const prepared = await this.#options.recover({
      runId,
      ...(providerSessionId === undefined ? {} : { providerSessionId }),
    })
    const plan = await createCliBridgeRetainedPlan(prepared, runId)
    this.#rememberPlan(runId, plan)
    return plan
  }

  #recoverySessionId(
    runId: string,
    providerSessionId: string | undefined,
    controlRef: AgentExactRunControlRef | undefined,
  ): string | undefined {
    if (controlRef !== undefined) this.#validatedControlRef(runId, controlRef)
    if (
      providerSessionId !== undefined &&
      controlRef !== undefined &&
      providerSessionId !== controlRef.sessionId
    ) {
      throw new Error('retained provider session conflicts with the exact run reference')
    }
    return controlRef?.sessionId ?? providerSessionId
  }

  #rememberHandle(runId: string, handle: RetainedRunHandle, plan: CliBridgeRetainedPlan): void {
    this.#handles.set(runId, handle)
    this.#rememberControlRef(runId, handle.controlRef)
    this.#rememberPlan(runId, plan)
  }

  #rememberControlRef(runId: string, controlRef: AgentExactRunControlRef): void {
    this.#controlRefs.set(runId, structuredClone(controlRef))
    this.#touch(runId)
  }

  #rememberPlan(runId: string, plan: CliBridgeRetainedPlan): void {
    this.#plans.set(runId, plan)
    this.#touch(runId)
  }

  #validatedControlRef(
    runId: string,
    controlRef: AgentExactRunControlRef,
  ): AgentExactRunControlRef {
    const exact = AgentExactRunControlRefSchema.parse(controlRef)
    if (exact.runId !== runId) throw new Error('retained control reference names another run')
    return exact
  }

  #touch(runId: string): void {
    const index = this.#retainedOrder.indexOf(runId)
    if (index >= 0) this.#retainedOrder.splice(index, 1)
    this.#retainedOrder.push(runId)
    while (this.#retainedOrder.length > MAX_RETAINED_CLIENTS) {
      const evictedIndex = this.#retainedOrder.findIndex(
        (candidate) => !this.#readers.has(candidate),
      )
      if (evictedIndex < 0) break
      const [evicted] = this.#retainedOrder.splice(evictedIndex, 1)
      if (evicted === undefined) break
      this.#handles.delete(evicted)
      this.#plans.delete(evicted)
      this.#controlRefs.delete(evicted)
      this.#lastCursors.delete(evicted)
      this.#detached.delete(evicted)
    }
  }
}
