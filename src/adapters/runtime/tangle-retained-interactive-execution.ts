import type {
  AgentExactRunControlRef,
  AgentProfile,
  AgentWorkspaceBranchingProvider,
  ConfidentialAttestationVerifier,
} from '@tangle-network/agent-interface'
import {
  agentInteractiveSessionStopRequestDigest,
  canonicalCandidateDigest,
} from '@tangle-network/agent-interface'
import type {
  RetainedInteractiveAdmission,
  RetainedInteractiveRunHandle,
} from '@tangle-network/agent-runtime/kernel'
import {
  claimRetainedInteractiveControl,
  reconnectRetainedInteractiveRun,
  recoverRetainedInteractiveRun,
  startRetainedInteractiveRun,
} from '@tangle-network/agent-runtime/kernel'
import { canonicalDigest } from '../../domain/canonical.js'
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
import type { NativeInteractiveRunBroker } from './native-interactive-run-broker.js'
import { safeExecutionId } from './production-backend-common.js'
import type { PreparedTangleRetainedConnection } from './production-tangle-sandbox-backend.js'
import { retainedExecutionKey } from './retained-execution-state.js'
import {
  assertExactControl,
  assertInteractiveAdmissionMatchesInput,
  assertInteractiveProvider,
  assertStartedAdmissionMatchesInput,
  interactiveAdmissionOrUndefined,
  interactiveEnvironment,
  interactiveIdempotencyKey,
  interactiveMaterializationReceipt,
  interactiveRunCapabilities,
  requireAdmissionRecorder,
  requireInteractiveAdmission,
  requireRecoveryReceipt,
  type TangleInteractiveRecoveryInput,
} from './tangle-retained-interactive-contract.js'
import {
  interactiveStatus,
  interactiveStatusDetail,
  observedEnvelope,
  partialInteractiveStatus,
  replayBoundary,
  terminalEnvelope,
  terminalOutcome,
} from './tangle-retained-interactive-projection.js'

export interface TangleRetainedInteractiveExecutionOptions {
  readonly resolve: (input: ExecuteTurnInput) => Promise<PreparedTangleRetainedConnection>
  readonly recover?: (input: ExecuteTurnInput) => Promise<PreparedTangleRetainedConnection>
  readonly broker: Pick<NativeInteractiveRunBroker, 'open' | 'settle'>
  readonly holderId?: string
  readonly workspaceBranchingProvider?: AgentWorkspaceBranchingProvider
  readonly confidentialAttestationVerifier?: ConfidentialAttestationVerifier
}

interface PreparedInteractiveConnection {
  readonly key: string
  readonly prepared: PreparedTangleRetainedConnection
}

/** Runs one exact Tangle coding-agent TUI through Runtime's durable APIs. */
export class TangleRetainedInteractiveExecutionPort implements ExecutionPort {
  readonly admissionMode = 'async' as const
  readonly #resolve: TangleRetainedInteractiveExecutionOptions['resolve']
  readonly #recover: TangleRetainedInteractiveExecutionOptions['recover']
  readonly #broker: Pick<NativeInteractiveRunBroker, 'open' | 'settle'>
  readonly #holderId: string
  readonly #prepared = new Map<string, PreparedInteractiveConnection>()
  readonly #starting = new Map<string, Promise<RetainedInteractiveRunHandle>>()
  readonly #handles = new Map<string, RetainedInteractiveRunHandle>()
  readonly #activeRuns = new Set<string>()
  readonly #detachRequested = new Set<string>()
  readonly #cancelledRuns = new Set<string>()
  readonly workspaceBranchingProvider?: AgentWorkspaceBranchingProvider
  readonly confidentialAttestationVerifier?: ConfidentialAttestationVerifier

  constructor(options: TangleRetainedInteractiveExecutionOptions) {
    this.#resolve = options.resolve
    this.#recover = options.recover
    this.#broker = options.broker
    this.#holderId = options.holderId ?? 'braid'
    if (options.workspaceBranchingProvider !== undefined)
      this.workspaceBranchingProvider = options.workspaceBranchingProvider
    if (options.confidentialAttestationVerifier !== undefined)
      this.confidentialAttestationVerifier = options.confidentialAttestationVerifier
  }

  capabilities = (input: ExecuteTurnInput): RunCapabilities | Promise<RunCapabilities> =>
    this.#prepare(input).then((prepared) => interactiveRunCapabilities(prepared))

  async admit(input: ExecuteTurnInput): Promise<ExecutionAdmission> {
    const prepared = await this.#prepare(input)
    const capabilities = interactiveRunCapabilities(prepared)
    const materializationReceipt = interactiveMaterializationReceipt(prepared)
    return {
      capabilities,
      provider: prepared.provider.name,
      materializationReceipt,
      profileDigest: canonicalAgentProfileDigestHex(input.profile),
      capabilitiesDigest: canonicalDigest(capabilities),
      materializationDigest: canonicalDigest(materializationReceipt),
    }
  }

  async *streamTurn(input: ExecuteTurnInput): AsyncIterable<RuntimeEventEnvelope> {
    if (this.#cancelledRuns.has(input.runId)) return
    const prepared = await this.#prepare(input)
    if (this.#cancelledRuns.has(input.runId)) return
    const lease = this.#broker.open(input.runId)
    this.#activeRuns.add(input.runId)
    let terminal = false
    try {
      const handle = this.#handles.get(input.runId) ?? (await this.#startOnce(prepared, input))
      this.#rememberHandle(input.runId, handle)
      lease.publish(handle)
      if (this.#detachRequested.has(input.runId)) this.#settleDetached(input.runId)
      yield await observedEnvelope(input.runId, handle, prepared, 1)
      const providerOutcome = await terminalOutcome(handle, input.signal)
      if (providerOutcome !== undefined) {
        terminal = true
        yield terminalEnvelope(
          input.runId,
          handle,
          prepared,
          providerOutcome,
          2,
          this.#cancelledRuns.has(input.runId),
        )
        return
      }
      const outcome = await lease.outcome(
        input.signal === undefined ? undefined : { signal: input.signal },
      )
      if (outcome.kind === 'detached') return
      terminal = true
      yield terminalEnvelope(
        input.runId,
        handle,
        prepared,
        outcome,
        2,
        this.#cancelledRuns.has(input.runId),
      )
    } catch (error) {
      lease.fail(error)
      throw error
    } finally {
      this.#activeRuns.delete(input.runId)
      if (terminal) this.#forgetHandle(input.runId)
      lease.close()
    }
  }

  async *reconnect(input: TangleInteractiveRecoveryInput): AsyncIterable<RuntimeEventEnvelope> {
    const admission = requireInteractiveAdmission(input.retainedAdmission)
    assertInteractiveAdmissionMatchesInput(admission, input)
    const prepared = await this.#resolveRecovery(input, admission)
    assertInteractiveProvider(prepared)
    const lease = this.#broker.open(input.runId)
    this.#activeRuns.add(input.runId)
    let terminal = false
    try {
      const handle = await this.#recoverHandle(prepared, input, admission)
      if (handle === null) return
      this.#rememberHandle(input.runId, handle)
      this.#detachRequested.delete(input.runId)
      lease.publish(handle)
      const replayedSequence = replayBoundary(input, input.runId, handle)
      if (replayedSequence < 1) {
        yield await observedEnvelope(input.runId, handle, prepared, 1)
      }
      if (replayedSequence >= 2) {
        terminal = true
        return
      }
      const providerOutcome = await terminalOutcome(handle, input.signal)
      if (providerOutcome !== undefined) {
        terminal = true
        yield terminalEnvelope(
          input.runId,
          handle,
          prepared,
          providerOutcome,
          2,
          this.#cancelledRuns.has(input.runId),
        )
        return
      }
      const outcome = await lease.outcome(
        input.signal === undefined ? undefined : { signal: input.signal },
      )
      if (outcome.kind === 'detached') return
      terminal = true
      yield terminalEnvelope(
        input.runId,
        handle,
        prepared,
        outcome,
        2,
        this.#cancelledRuns.has(input.runId),
      )
    } catch (error) {
      lease.fail(error)
      throw error
    } finally {
      this.#activeRuns.delete(input.runId)
      if (terminal) this.#forgetHandle(input.runId)
      lease.close()
    }
  }

  async status(input: TangleInteractiveRecoveryInput): Promise<ProviderRunSnapshot | null> {
    const partial = interactiveAdmissionOrUndefined(input.retainedAdmission)
    if (partial !== undefined) assertInteractiveAdmissionMatchesInput(partial, input)
    if (
      this.#handles.get(input.runId) === undefined &&
      partial !== undefined &&
      partial.phase !== 'interactive_started'
    ) {
      return partialInteractiveStatus(input.runId, partial)
    }
    const handle = await this.#handleFor(input)
    if (handle === null) return null
    const status = await handle.status({
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    const mapped = interactiveStatus(status, this.#detachRequested.has(input.runId))
    if (status.state === 'exited') this.#forgetHandle(input.runId)
    return {
      runId: input.runId,
      status: mapped,
      sessionId: handle.ref.run.sessionId,
      ...(status.state === 'unknown' ? { error: status.message, detail: status.message } : {}),
      ...(status.state === 'exited' ? { detail: interactiveStatusDetail(status) } : {}),
    }
  }

  async detachRun(
    input: {
      readonly runId: string
      readonly operationId: string
      readonly providerSessionId?: string
      readonly controlRef?: AgentExactRunControlRef
      readonly cursor?: string
      readonly signal?: AbortSignal
    } & TangleInteractiveRecoveryInput,
  ): Promise<ControlAcknowledgement> {
    const admission = interactiveAdmissionOrUndefined(input.retainedAdmission)
    if (admission !== undefined) assertInteractiveAdmissionMatchesInput(admission, input)
    let handle = this.#handles.get(input.runId)
    if (
      handle === undefined &&
      !this.#prepared.has(input.runId) &&
      !this.#starting.has(input.runId) &&
      admission !== undefined &&
      admission.phase !== 'interactive_started'
    ) {
      this.#detachRequested.add(input.runId)
      return { operationId: input.operationId, outcome: 'accepted', detail: 'detached' }
    }
    if (handle === undefined && !this.#prepared.has(input.runId)) {
      handle = (await this.#handleFor(input)) ?? undefined
    } else if (handle === undefined && this.#starting.has(input.runId)) {
      handle = (await this.#handleFor(input)) ?? undefined
    }
    this.#assertControl(input.runId, input.providerSessionId, input.controlRef, handle?.ref.run)
    if (this.#detachRequested.has(input.runId)) {
      return { operationId: input.operationId, outcome: 'already-applied', detail: 'detached' }
    }
    this.#detachRequested.add(input.runId)
    this.#settleDetached(input.runId)
    return { operationId: input.operationId, outcome: 'accepted', detail: 'detached' }
  }

  async cancelRun(
    input: CancelRunInput & { readonly signal?: AbortSignal },
  ): Promise<ControlAcknowledgement> {
    if (this.#cancelledRuns.has(input.runId) && !this.#activeRuns.has(input.runId)) {
      return { operationId: input.operationId, outcome: 'already-applied', detail: 'cancelled' }
    }
    const startInFlight = this.#starting.has(input.runId)
    const controlSignal = startInFlight || input.signal?.aborted ? undefined : input.signal
    const { signal: _foregroundSignal, ...recoveryInputBase } = input
    const recoveryInput = {
      ...recoveryInputBase,
      ...(controlSignal === undefined ? {} : { signal: controlSignal }),
    }
    let handle = this.#handles.get(input.runId)
    const admissionPhase = input.retainedAdmission?.phase
    const interactiveIntent =
      input.retainedAdmission?.phase === 'interactive_intent' ? input.retainedAdmission : undefined
    if (
      handle === undefined &&
      !this.#starting.has(input.runId) &&
      interactiveIntent !== undefined &&
      input.controlRef === undefined
    ) {
      if (
        input.providerSessionId !== undefined &&
        input.providerSessionId !== interactiveIntent.sessionId
      ) {
        return {
          operationId: input.operationId,
          outcome: 'rejected',
          detail: 'interactive-intent-provider-session-mismatch',
        }
      }
      this.#cancelledRuns.add(input.runId)
      this.#prepared.delete(input.runId)
      this.#settleCancelled(input.runId)
      return {
        operationId: input.operationId,
        outcome: 'accepted',
        detail: 'cancelled-before-start',
      }
    }
    if (
      handle === undefined &&
      this.#prepared.has(input.runId) &&
      !this.#starting.has(input.runId) &&
      input.providerSessionId === undefined &&
      input.controlRef === undefined &&
      admissionPhase !== 'interactive_started'
    ) {
      this.#cancelledRuns.add(input.runId)
      this.#prepared.delete(input.runId)
      this.#settleCancelled(input.runId)
      return {
        operationId: input.operationId,
        outcome: 'accepted',
        detail: 'cancelled-before-start',
      }
    }
    if (handle === undefined && this.#starting.has(input.runId)) {
      this.#cancelledRuns.add(input.runId)
      try {
        handle = (await this.#handleFor(recoveryInput)) ?? undefined
      } catch {
        return {
          operationId: input.operationId,
          outcome: 'unknown',
          detail: 'interactive-start-could-not-be-cancelled',
        }
      }
    }
    if (handle === undefined) {
      try {
        handle = (await this.#handleFor(recoveryInput)) ?? undefined
      } catch {
        return {
          operationId: input.operationId,
          outcome: 'unknown',
          detail: 'interactive-run-missing',
        }
      }
    }
    if (handle === undefined) {
      return {
        operationId: input.operationId,
        outcome: 'unknown',
        detail: 'interactive-run-missing',
      }
    }
    this.#assertControl(input.runId, input.providerSessionId, input.controlRef)
    const control = await claimRetainedInteractiveControl({
      handle,
      holderId: this.#holderId,
      ...(controlSignal === undefined ? {} : { signal: controlSignal }),
    })
    const material = { operationId: input.operationId, ref: handle.ref, control }
    const acknowledgement = await handle.stop(
      { ...material, requestDigest: agentInteractiveSessionStopRequestDigest(material) },
      controlSignal === undefined ? undefined : { signal: controlSignal },
    )
    if (acknowledgement.status === 'accepted' || acknowledgement.status === 'replayed') {
      this.#cancelledRuns.add(input.runId)
      this.#settleCancelled(input.runId)
      this.#forgetHandle(input.runId)
      return {
        operationId: input.operationId,
        outcome: acknowledgement.status === 'replayed' ? 'already-applied' : 'accepted',
        detail: acknowledgement.effect,
      }
    }
    return {
      operationId: input.operationId,
      outcome:
        acknowledgement.status === 'conflict'
          ? 'rejected'
          : acknowledgement.status === 'unknown'
            ? 'unknown'
            : 'rejected',
      detail: acknowledgement.effect,
    }
  }

  async #start(
    prepared: PreparedTangleRetainedConnection,
    input: ExecuteTurnInput,
  ): Promise<RetainedInteractiveRunHandle> {
    const onAdmission = requireAdmissionRecorder(input.onRetainedAdmission)
    return startRetainedInteractiveRun({
      provider: prepared.provider,
      environment: interactiveEnvironment(prepared, input.runId),
      interactiveIdempotencyKey: interactiveIdempotencyKey(input.runId),
      ...(input.text.trim() === '' ? {} : { initialPrompt: input.text }),
      // workspaceRoot identifies Braid's local checkout. The provider owns its remote cwd.
      onAdmission,
      signal: input.signal,
    })
  }

  async #startOnce(
    prepared: PreparedTangleRetainedConnection,
    input: ExecuteTurnInput,
  ): Promise<RetainedInteractiveRunHandle> {
    const current = this.#starting.get(input.runId)
    if (current !== undefined) return current
    const starting = this.#start(prepared, input)
    this.#starting.set(input.runId, starting)
    starting.then(
      () => this.#clearStarting(input.runId, starting),
      () => this.#clearStarting(input.runId, starting),
    )
    return starting
  }

  async #prepare(input: ExecuteTurnInput): Promise<PreparedTangleRetainedConnection> {
    const current = this.#prepared.get(input.runId)
    if (current !== undefined) {
      if (
        current.key !== retainedExecutionKey(input, interactiveRunCapabilities(current.prepared))
      ) {
        throw new Error('Interactive run admission received a different request')
      }
      return current.prepared
    }
    const prepared = await this.#resolve(input)
    assertInteractiveProvider(prepared)
    this.#prepared.set(input.runId, {
      key: retainedExecutionKey(input, interactiveRunCapabilities(prepared)),
      prepared,
    })
    return prepared
  }

  async #recoverHandle(
    prepared: PreparedTangleRetainedConnection,
    input: TangleInteractiveRecoveryInput,
    admission: RetainedInteractiveAdmission,
  ): Promise<RetainedInteractiveRunHandle | null> {
    if (admission.phase === 'interactive_started') {
      assertStartedAdmissionMatchesInput(admission, input)
      return reconnectRetainedInteractiveRun({
        provider: prepared.provider,
        ref: admission.ref,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
    }
    const onAdmission = requireAdmissionRecorder(input.onRetainedAdmission)
    if (admission.phase === 'interactive_environment') {
      return recoverRetainedInteractiveRun({
        provider: prepared.provider,
        admission,
        onAdmission,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
    }
    const receipt = requireRecoveryReceipt(input.receipt)
    const profile = receipt.requested.profile
    return recoverRetainedInteractiveRun({
      provider: prepared.provider,
      admission,
      replay: {
        environment: interactiveEnvironment(
          prepared,
          input.runId,
          admission.idempotencyKey,
          profile,
        ),
        interactiveIdempotencyKey: admission.interactiveIdempotencyKey,
        ...(receipt.requested.text.trim() === '' ? {} : { initialPrompt: receipt.requested.text }),
      },
      onAdmission,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
  }

  async #handleFor(
    input: TangleInteractiveRecoveryInput,
  ): Promise<RetainedInteractiveRunHandle | null> {
    const admissionForInput = interactiveAdmissionOrUndefined(input.retainedAdmission)
    if (admissionForInput !== undefined) {
      assertInteractiveAdmissionMatchesInput(admissionForInput, input)
    }
    const active = this.#handles.get(input.runId)
    if (active !== undefined) {
      this.#assertControl(input.runId, input.providerSessionId, input.controlRef, active.ref.run)
      return active
    }
    const starting = this.#starting.get(input.runId)
    if (starting !== undefined) {
      const handle = await starting
      this.#rememberHandle(input.runId, handle)
      this.#assertControl(input.runId, input.providerSessionId, input.controlRef, handle.ref.run)
      return handle
    }
    const admission = requireInteractiveAdmission(input.retainedAdmission)
    const prepared = await this.#resolveRecovery(input, admission)
    assertInteractiveProvider(prepared)
    const handle = await this.#recoverHandle(prepared, input, admission)
    if (handle !== null) this.#rememberHandle(input.runId, handle)
    return handle
  }

  async #resolveRecovery(
    input: TangleInteractiveRecoveryInput,
    admission: RetainedInteractiveAdmission,
  ): Promise<PreparedTangleRetainedConnection> {
    const receipt = input.receipt
    const profile = (
      admission.phase === 'interactive_environment'
        ? admission.request.profile
        : receipt?.requested.profile
    ) as Readonly<AgentProfile> | undefined
    if (profile === undefined) {
      throw new Error('Interactive recovery requires the original run receipt')
    }
    const text =
      admission.phase === 'interactive_environment'
        ? (admission.request.initialPrompt ?? '')
        : (receipt?.requested.text ?? '')
    const recoveredInput: ExecuteTurnInput = {
      operationId: `recover-${safeExecutionId(input.runId)}`,
      runId: input.runId,
      text,
      profile,
      mode: 'interactive',
      ...(receipt?.requested.connectionId === undefined
        ? {}
        : { connectionId: receipt.requested.connectionId }),
      ...(receipt === undefined
        ? input.workspaceRequest === undefined
          ? {}
          : { workspaceRequest: input.workspaceRequest }
        : receipt.requested.workspaceRequest === undefined
          ? {}
          : { workspaceRequest: receipt.requested.workspaceRequest }),
      ...(receipt?.requested.workspaceRoot === undefined
        ? input.workspaceRoot === undefined
          ? {}
          : { workspaceRoot: input.workspaceRoot }
        : { workspaceRoot: receipt.requested.workspaceRoot }),
      signal: input.signal ?? new AbortController().signal,
    }
    return (this.#recover ?? this.#resolve)(recoveredInput)
  }

  #rememberHandle(runId: string, handle: RetainedInteractiveRunHandle): void {
    const previous = this.#handles.get(runId)
    if (
      previous !== undefined &&
      canonicalCandidateDigest(previous.ref) !== canonicalCandidateDigest(handle.ref)
    ) {
      throw new Error('Interactive run recovered with a different process reference')
    }
    this.#handles.set(runId, handle)
  }

  #clearStarting(runId: string, starting: Promise<RetainedInteractiveRunHandle>): void {
    if (this.#starting.get(runId) === starting) this.#starting.delete(runId)
  }

  #assertControl(
    runId: string,
    providerSessionId?: string,
    controlRef?: AgentExactRunControlRef,
    expected?: AgentExactRunControlRef,
  ): void {
    const actual = expected ?? this.#handles.get(runId)?.ref.run
    assertExactControl(
      {
        ...(providerSessionId === undefined ? {} : { providerSessionId }),
        ...(controlRef === undefined ? {} : { controlRef }),
      },
      actual,
    )
  }

  #settleDetached(runId: string): void {
    if (!this.#activeRuns.has(runId)) return
    switch (this.#broker.settle(runId, { kind: 'detached' })) {
      case 'settled':
      case 'absent':
      case 'already-settled':
        return
    }
  }

  #settleCancelled(runId: string): void {
    if (!this.#activeRuns.has(runId)) return
    switch (this.#broker.settle(runId, { kind: 'exited', exitSignal: 'SIGTERM' })) {
      case 'settled':
      case 'absent':
      case 'already-settled':
        return
    }
  }

  #forgetHandle(runId: string): void {
    this.#handles.delete(runId)
    this.#prepared.delete(runId)
    if (!this.#activeRuns.has(runId)) this.#cancelledRuns.delete(runId)
  }
}
