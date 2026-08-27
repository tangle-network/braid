import {
  type AgentExactRunControlRef,
  AgentExactRunControlRefSchema,
} from '@tangle-network/agent-interface'
import type { RetainedRunHandle } from '@tangle-network/agent-runtime/kernel'
import { canonicalDigest } from '../../domain/canonical.js'
import type { RunCapabilities } from '../../domain/run-contracts.js'
import { requestedInteractionsForRun } from '../../domain/run-interactions.js'
import type { ExecuteTurnInput } from '../../ports/execution.js'
import { canonicalAgentProfileDigestHex } from '../agent-interface/profile-runtime.js'
import type { RetainedExecutionPlan } from './retained-execution-contract.js'

const MAX_RETAINED_CLIENTS = 128

export function retainedExecutionKey(
  input: ExecuteTurnInput,
  capabilities?: Pick<RunCapabilities, 'environment'>,
): string {
  return canonicalDigest({
    runId: input.runId,
    operationId: input.operationId,
    text: input.text,
    profile: canonicalAgentProfileDigestHex(input.profile),
    connectionId: input.connectionId ?? null,
    mode: input.mode ?? null,
    interactions:
      input.interactions ??
      (capabilities === undefined ? {} : requestedInteractionsForRun(input.mode, capabilities)),
    workspaceRoot: input.workspaceRoot ?? null,
    sessionId: input.sessionId ?? null,
    contextBoundary: input.contextBoundary ?? null,
    nativeContextBoundaryProof: input.nativeContextBoundaryProof ?? null,
  })
}

/** Process-local coordination around one Braid retained run. */
export class RetainedExecutionState {
  readonly #prepared = new Map<string, string>()
  readonly #startingHandles = new Map<string, Promise<RetainedRunHandle>>()
  readonly #handles = new Map<string, RetainedRunHandle>()
  readonly #plans = new Map<string, RetainedExecutionPlan>()
  readonly #readers = new Map<string, AbortController>()
  readonly #cancellationRequested = new Set<string>()
  readonly #detached = new Set<string>()
  readonly #retainedOrder: string[] = []

  rememberPrepared(runId: string, key: string, plan: RetainedExecutionPlan): void {
    this.#assertAdmissionCapacity(runId)
    this.#prepared.set(runId, key)
    this.rememberPlan(runId, plan)
  }

  takePrepared(runId: string, key: string): RetainedExecutionPlan | undefined {
    const preparedKey = this.#prepared.get(runId)
    if (preparedKey === undefined || preparedKey !== key) return undefined
    this.#prepared.delete(runId)
    return this.#plans.get(runId)
  }

  hasPrepared(runId: string): boolean {
    return this.#prepared.has(runId)
  }

  discardPrepared(runId: string): void {
    this.#prepared.delete(runId)
  }

  plan(runId: string): RetainedExecutionPlan | undefined {
    return this.#plans.get(runId)
  }

  preparedPlan(runId: string): RetainedExecutionPlan | undefined {
    return this.#prepared.has(runId) ? this.#plans.get(runId) : undefined
  }

  rememberPlan(runId: string, plan: RetainedExecutionPlan): void {
    this.#plans.set(runId, plan)
    this.#touch(runId)
  }

  handle(runId: string): RetainedRunHandle | undefined {
    return this.#handles.get(runId)
  }

  rememberStartingHandle(runId: string, starting: Promise<RetainedRunHandle>): void {
    const existing = this.#startingHandles.get(runId)
    if (existing !== undefined && existing !== starting) {
      throw new Error('retained run already has an in-flight start')
    }
    this.#startingHandles.set(runId, starting)
    this.#touch(runId)
  }

  startingHandle(runId: string): Promise<RetainedRunHandle> | undefined {
    return this.#startingHandles.get(runId)
  }

  clearStartingHandle(runId: string, starting: Promise<RetainedRunHandle>): void {
    if (this.#startingHandles.get(runId) === starting) this.#startingHandles.delete(runId)
  }

  markCancellationRequested(runId: string): void {
    this.#cancellationRequested.add(runId)
  }

  isCancellationRequested(runId: string): boolean {
    return this.#cancellationRequested.has(runId)
  }

  rememberHandle(runId: string, plan: RetainedExecutionPlan, handle: RetainedRunHandle): void {
    this.validateControlRef(plan, handle.controlRef)
    this.#handles.set(runId, handle)
    this.rememberPlan(runId, plan)
  }

  validateControlRef(
    plan: RetainedExecutionPlan,
    controlRef: AgentExactRunControlRef,
  ): AgentExactRunControlRef {
    const exact = AgentExactRunControlRefSchema.parse(controlRef)
    if (exact.provider !== plan.providerName) {
      throw new Error('retained control reference names another provider')
    }
    if (plan.environmentId !== undefined && exact.environmentId !== plan.environmentId) {
      throw new Error('retained control reference names another environment')
    }
    if (plan.providerSessionId !== undefined && exact.sessionId !== plan.providerSessionId) {
      throw new Error('retained control reference names another provider session')
    }
    return exact
  }

  assertProviderSession(plan: RetainedExecutionPlan, providerSessionId: string | undefined): void {
    if (
      providerSessionId !== undefined &&
      plan.providerSessionId !== undefined &&
      providerSessionId !== plan.providerSessionId
    ) {
      throw new Error('retained provider session conflicts with the saved run')
    }
  }

  assertSameControlRef(expected: AgentExactRunControlRef, actual: AgentExactRunControlRef): void {
    if (canonicalDigest(expected) !== canonicalDigest(actual)) {
      throw new Error('retained control reference conflicts with the saved run')
    }
  }

  reader(runId: string): AbortController | undefined {
    return this.#readers.get(runId)
  }

  replaceReader(runId: string, reader: AbortController): AbortController | undefined {
    const previous = this.#readers.get(runId)
    this.#readers.set(runId, reader)
    return previous
  }

  clearReader(runId: string, reader: AbortController): void {
    if (this.#readers.get(runId) === reader) this.#readers.delete(runId)
  }

  markDetached(runId: string, detached: boolean): void {
    if (detached) this.#detached.add(runId)
    else this.#detached.delete(runId)
  }

  isDetached(runId: string): boolean {
    return this.#detached.has(runId)
  }

  #touch(runId: string): void {
    const index = this.#retainedOrder.indexOf(runId)
    if (index >= 0) this.#retainedOrder.splice(index, 1)
    this.#retainedOrder.push(runId)
    while (this.#retainedOrder.length > MAX_RETAINED_CLIENTS) {
      const evictedIndex = this.#retainedOrder.findIndex(
        (candidate) =>
          !this.#prepared.has(candidate) &&
          !this.#readers.has(candidate) &&
          !this.#startingHandles.has(candidate),
      )
      if (evictedIndex < 0) break
      const [evicted] = this.#retainedOrder.splice(evictedIndex, 1)
      if (evicted === undefined) break
      this.#prepared.delete(evicted)
      this.#startingHandles.delete(evicted)
      this.#handles.delete(evicted)
      this.#plans.delete(evicted)
      this.#cancellationRequested.delete(evicted)
      this.#detached.delete(evicted)
    }
  }

  #assertAdmissionCapacity(runId: string): void {
    if (this.#retainedOrder.includes(runId)) return
    if (this.#retainedOrder.length < MAX_RETAINED_CLIENTS) return
    const evictable = this.#retainedOrder.some(
      (candidate) =>
        !this.#prepared.has(candidate) &&
        !this.#readers.has(candidate) &&
        !this.#startingHandles.has(candidate),
    )
    if (!evictable) throw new Error('Retained execution admission capacity reached')
  }
}
