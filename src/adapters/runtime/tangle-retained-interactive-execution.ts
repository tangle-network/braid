import type {
  AgentExactRunControlRef,
  AgentInteractiveSessionStatus,
  AgentProfile,
} from '@tangle-network/agent-interface'
import {
  agentInteractiveSessionStopRequestDigest,
  canonicalCandidateDigest,
} from '@tangle-network/agent-interface'
import type {
  RetainedInteractiveAdmission,
  RetainedInteractiveAdmissionHook,
  RetainedInteractiveRunHandle,
  RetainedInteractiveStartedAdmission,
} from '@tangle-network/agent-runtime/kernel'
import {
  claimRetainedInteractiveControl,
  reconnectRetainedInteractiveRun,
  recoverRetainedInteractiveRun,
  startRetainedInteractiveRun,
} from '@tangle-network/agent-runtime/kernel'
import { canonicalDigest } from '../../domain/canonical.js'
import { publicMaterializationReceipt } from '../../domain/materialization-receipt.js'
import type { RuntimeEventEnvelope } from '../../domain/runtime-events.js'
import type { RunAdmissionReceipt } from '../../domain/receipts.js'
import type {
  CancelRunInput,
  ControlAcknowledgement,
  ExecuteTurnInput,
  ExecutionAdmission,
  ExecutionPort,
  ProviderRunSnapshot,
  RunCapabilities,
} from '../../ports/execution.js'
import type { NativeInteractiveRunOutcome } from '../../ports/native-interactive-execution.js'
import type { NativeInteractiveRunBroker } from './native-interactive-run-broker.js'
import { canonicalAgentProfileDigestHex } from '../agent-interface/profile-runtime.js'
import { safeExecutionId } from './production-backend-common.js'
import type { PreparedTangleRetainedConnection } from './production-tangle-sandbox-backend.js'

type StatusInput = Parameters<NonNullable<ExecutionPort['status']>>[0]
type RecoveryInput = Omit<StatusInput, 'retainedAdmission'> & {
  readonly after?: string
  readonly afterSequence?: number
  readonly retainedAdmission?: unknown
  readonly receipt?: RunAdmissionReceipt
  readonly workspaceRoot?: string
  readonly onRetainedAdmission?: unknown
}

export interface TangleRetainedInteractiveExecutionOptions {
  readonly resolve: (input: ExecuteTurnInput) => Promise<PreparedTangleRetainedConnection>
  readonly recover?: (input: ExecuteTurnInput) => Promise<PreparedTangleRetainedConnection>
  readonly broker: Pick<NativeInteractiveRunBroker, 'open' | 'settle'>
  readonly holderId?: string
}

/** Runs one exact Tangle coding-agent TUI through Runtime's durable APIs. */
export class TangleRetainedInteractiveExecutionPort implements ExecutionPort {
  readonly admissionMode = 'async' as const
  readonly #resolve: TangleRetainedInteractiveExecutionOptions['resolve']
  readonly #recover: TangleRetainedInteractiveExecutionOptions['recover']
  readonly #broker: Pick<NativeInteractiveRunBroker, 'open' | 'settle'>
  readonly #holderId: string
  readonly #prepared = new Map<string, PreparedTangleRetainedConnection>()
  readonly #handles = new Map<string, RetainedInteractiveRunHandle>()
  readonly #activeRuns = new Set<string>()
  readonly #detachRequested = new Set<string>()
  readonly #cancelledRuns = new Set<string>()

  constructor(options: TangleRetainedInteractiveExecutionOptions) {
    this.#resolve = options.resolve
    this.#recover = options.recover
    this.#broker = options.broker
    this.#holderId = options.holderId ?? 'braid'
  }

  capabilities = (input: ExecuteTurnInput): RunCapabilities | Promise<RunCapabilities> =>
    this.#resolve(input).then((prepared) => interactiveRunCapabilities(prepared))

  async admit(input: ExecuteTurnInput): Promise<ExecutionAdmission> {
    const prepared = await this.#resolve(input)
    assertInteractiveProvider(prepared)
    this.#prepared.set(input.runId, prepared)
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
    const prepared = this.#prepared.get(input.runId) ?? (await this.#resolve(input))
    assertInteractiveProvider(prepared)
    const lease = this.#broker.open(input.runId)
    this.#activeRuns.add(input.runId)
    let terminal = false
    try {
      const handle = this.#handles.get(input.runId) ?? (await this.#start(prepared, input))
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

  async *reconnect(input: RecoveryInput): AsyncIterable<RuntimeEventEnvelope> {
    const admission = requireInteractiveAdmission(input.retainedAdmission)
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

  async status(input: RecoveryInput): Promise<ProviderRunSnapshot | null> {
    const partial = interactiveAdmissionOrUndefined(input.retainedAdmission)
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

  async detachRun(input: {
    readonly runId: string
    readonly operationId: string
    readonly providerSessionId?: string
    readonly controlRef?: AgentExactRunControlRef
    readonly cursor?: string
    readonly signal?: AbortSignal
  }): Promise<ControlAcknowledgement> {
    this.#assertControl(input.runId, input.providerSessionId, input.controlRef)
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
    const handle = this.#handles.get(input.runId)
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
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    const material = { operationId: input.operationId, ref: handle.ref, control }
    const acknowledgement = await handle.stop(
      { ...material, requestDigest: agentInteractiveSessionStopRequestDigest(material) },
      input.signal === undefined ? undefined : { signal: input.signal },
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
      ...(input.workspaceRoot === undefined ? {} : { cwd: input.workspaceRoot }),
      onAdmission,
      signal: input.signal,
    })
  }

  async #recoverHandle(
    prepared: PreparedTangleRetainedConnection,
    input: RecoveryInput,
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
        ...(input.workspaceRoot === undefined ? {} : { cwd: input.workspaceRoot }),
      },
      onAdmission,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
  }

  async #handleFor(input: RecoveryInput): Promise<RetainedInteractiveRunHandle | null> {
    const active = this.#handles.get(input.runId)
    if (active !== undefined) {
      this.#assertControl(input.runId, input.providerSessionId, input.controlRef, active.ref.run)
      return active
    }
    const admission = requireInteractiveAdmission(input.retainedAdmission)
    const prepared = await this.#resolveRecovery(input, admission)
    assertInteractiveProvider(prepared)
    const handle = await this.#recoverHandle(prepared, input, admission)
    if (handle !== null) this.#rememberHandle(input.runId, handle)
    return handle
  }

  async #resolveRecovery(
    input: RecoveryInput,
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
      ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
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

  #assertControl(
    runId: string,
    providerSessionId?: string,
    controlRef?: AgentExactRunControlRef,
    expected?: AgentExactRunControlRef,
  ): void {
    const actual = expected ?? this.#handles.get(runId)?.ref.run
    if (
      providerSessionId !== undefined &&
      actual !== undefined &&
      providerSessionId !== actual.sessionId
    ) {
      throw new Error('Interactive provider session conflicts with the saved run')
    }
    if (
      controlRef !== undefined &&
      actual !== undefined &&
      canonicalDigest(controlRef) !== canonicalDigest(actual)
    ) {
      throw new Error('Interactive control reference conflicts with the saved run')
    }
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
    if (!this.#activeRuns.has(runId)) this.#cancelledRuns.delete(runId)
  }
}

function assertInteractiveProvider(prepared: PreparedTangleRetainedConnection): void {
  const interactive = prepared.capabilities.interactiveAgent
  if (
    interactive?.start !== true ||
    interactive.control !== true ||
    interactive.status !== true ||
    interactive.attach !== true ||
    interactive.reattach !== true ||
    interactive.stop !== true
  ) {
    throw new Error('Tangle retained connection does not support exact interactive agents')
  }
}

function interactiveRunCapabilities(prepared: PreparedTangleRetainedConnection): RunCapabilities {
  return Object.freeze({
    streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
    sessions: { continue: true, messages: false },
    controls: { cancel: true, steer: false, queue: false, status: true, recreate: true },
    events: { stableIdentity: true, sequence: true, cursor: true },
    usage: false,
    environment: prepared.capabilities,
  })
}

function interactiveMaterializationReceipt(
  prepared: PreparedTangleRetainedConnection,
): Readonly<Record<string, unknown>> {
  return publicMaterializationReceipt({
    provider: prepared.provider.name,
    backend: 'environment-provider',
    surface: 'interactive-agent',
    lifecycle: 'retained',
    execution: 'agent-runtime-retained-interactive',
    cleanup: 'explicit',
    continuity: 'session',
    idleTtlSeconds: prepared.idleTtlSeconds,
    model: prepared.model,
    runner: prepared.runner,
  })
}

function interactiveEnvironment(
  prepared: PreparedTangleRetainedConnection,
  _runId: string,
  idempotencyKey = interactiveEnvironmentIdempotencyKey(_runId),
  profile = prepared.profile,
) {
  return {
    profile,
    backend: prepared.runner,
    name: `braid-interactive-${safeExecutionId(_runId)}`,
    metadata: {
      owner: 'braid',
      lifecycle: 'retained',
      surface: 'interactive-agent',
    },
    idempotencyKey,
  }
}

function interactiveIdempotencyKey(runId: string): string {
  return `interactive-braid-${safeExecutionId(runId)}`.slice(0, 128)
}

function interactiveEnvironmentIdempotencyKey(runId: string): string {
  return `env-braid-interactive-${safeExecutionId(runId)}`.slice(0, 128)
}

function requireAdmissionRecorder(recorder: unknown): RetainedInteractiveAdmissionHook {
  if (typeof recorder !== 'function') {
    throw new Error('Retained Tangle interactive execution requires a durable admission recorder')
  }
  return (admission) =>
    (recorder as (value: RetainedInteractiveAdmission) => Promise<void>)(admission)
}

function requireRecoveryReceipt(input: RunAdmissionReceipt | undefined): RunAdmissionReceipt {
  if (input === undefined)
    throw new Error('Interactive intent recovery requires the original run receipt')
  return input
}

function requireInteractiveAdmission(value: unknown): RetainedInteractiveAdmission {
  if (value === undefined || typeof value !== 'object' || value === null || !('phase' in value)) {
    throw new Error('Interactive recovery requires a canonical interactive admission')
  }
  const phase = (value as { readonly phase?: unknown }).phase
  if (typeof phase !== 'string' || !phase.startsWith('interactive_')) {
    throw new Error('Interactive recovery requires a canonical interactive admission')
  }
  return value as RetainedInteractiveAdmission
}

function interactiveAdmissionOrUndefined(value: unknown): RetainedInteractiveAdmission | undefined {
  if (value === undefined) return undefined
  return requireInteractiveAdmission(value)
}

function partialInteractiveStatus(
  runId: string,
  admission: Exclude<RetainedInteractiveAdmission, RetainedInteractiveStartedAdmission>,
): ProviderRunSnapshot {
  const sessionId = interactiveSessionId(admission)
  return sessionId === undefined
    ? { runId, status: 'unknown', detail: `replayable:${admission.phase}` }
    : { runId, status: 'unknown', sessionId, detail: `replayable:${admission.phase}` }
}

function interactiveStatusDetail(status: AgentInteractiveSessionStatus): string {
  if (status.state === 'unknown') return status.message
  if (!('reason' in status)) return 'interactive session running'
  return !('exitCode' in status) || status.exitCode === undefined
    ? `interactive session ${status.reason}`
    : `interactive session ${status.reason} with code ${status.exitCode}`
}

function interactiveSessionId(admission: RetainedInteractiveAdmission): string | undefined {
  if (admission.phase === 'interactive_intent') return admission.sessionId
  return admission.phase === 'interactive_environment'
    ? admission.request.run.sessionId
    : admission.ref.run.sessionId
}

function assertStartedAdmissionMatchesInput(
  admission: RetainedInteractiveStartedAdmission,
  input: RecoveryInput,
): void {
  if (
    input.providerSessionId !== undefined &&
    input.providerSessionId !== admission.ref.run.sessionId
  ) {
    throw new Error('Interactive provider session conflicts with the saved process reference')
  }
  if (
    input.controlRef !== undefined &&
    canonicalDigest(input.controlRef) !== canonicalDigest(admission.ref.run)
  ) {
    throw new Error('Interactive control reference conflicts with the saved process reference')
  }
}

function interactiveStatus(
  status: AgentInteractiveSessionStatus,
  detached: boolean,
): ProviderRunSnapshot['status'] {
  if (detached && status.state === 'running') return 'detached'
  if (status.state === 'running') return 'streaming'
  if (status.state === 'exited' && status.reason !== 'lost') return 'completed'
  return 'unknown'
}

async function terminalOutcome(
  handle: RetainedInteractiveRunHandle,
  signal?: AbortSignal,
): Promise<Extract<NativeInteractiveRunOutcome, { readonly kind: 'exited' }> | undefined> {
  const status = await handle.status(signal === undefined ? undefined : { signal })
  if (status.state !== 'exited') return undefined
  return {
    kind: 'exited',
    ...(status.exitCode === undefined ? {} : { exitCode: status.exitCode }),
    ...(status.exitSignal === undefined ? {} : { exitSignal: status.exitSignal }),
  }
}

function replayBoundary(
  input: RecoveryInput,
  runId: string,
  handle: RetainedInteractiveRunHandle,
): number {
  const cursorSequence =
    input.after === undefined
      ? undefined
      : sequenceFromCursor(input.after, runId, handle.ref.incarnationId)
  if (
    cursorSequence !== undefined &&
    input.afterSequence !== undefined &&
    cursorSequence !== input.afterSequence
  ) {
    throw new Error('Interactive replay cursor conflicts with the saved sequence')
  }
  return input.afterSequence ?? cursorSequence ?? 0
}

function sequenceFromCursor(cursor: string, runId: string, incarnationId: string): number {
  const prefix = `${runId}:interactive:${incarnationId}:`
  if (!cursor.startsWith(prefix)) {
    throw new Error('Interactive replay cursor belongs to another process')
  }
  const sequence = Number(cursor.slice(prefix.length))
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error('Interactive replay cursor is malformed')
  }
  return sequence
}

async function observedEnvelope(
  runId: string,
  handle: RetainedInteractiveRunHandle,
  prepared: PreparedTangleRetainedConnection,
  sequence: number,
): Promise<RuntimeEventEnvelope> {
  const observation = await prepared.observation.snapshot()
  if (observation === undefined) throw new Error('Tangle interactive observation is unavailable')
  const receivedAt = new Date().toISOString()
  return {
    runId,
    eventId: `${runId}:interactive:${handle.ref.incarnationId}:observed`,
    sequence,
    cursor: interactiveCursor(runId, handle, sequence),
    occurredAt: receivedAt,
    receivedAt,
    event: {
      type: 'braid.execution.observed',
      observation,
      controlRef: handle.ref.run,
      timestamp: receivedAt,
    },
  }
}

function terminalEnvelope(
  runId: string,
  handle: RetainedInteractiveRunHandle,
  prepared: PreparedTangleRetainedConnection,
  outcome: Exclude<NativeInteractiveRunOutcome, { readonly kind: 'detached' }>,
  sequence: number,
  cancelled: boolean,
): RuntimeEventEnvelope {
  const timestamp = new Date().toISOString()
  const failed = outcome.kind === 'failed'
  const reason = cancelled
    ? 'Interactive agent stopped'
    : failed
      ? outcome.message
      : outcome.exitCode === undefined
        ? 'Interactive agent exited'
        : `Interactive agent exited with code ${outcome.exitCode}`
  return {
    runId,
    eventId: `${runId}:interactive:${handle.ref.incarnationId}:final`,
    sequence,
    cursor: interactiveCursor(runId, handle, sequence),
    occurredAt: timestamp,
    receivedAt: timestamp,
    event: {
      type: 'final',
      task: { id: runId, intent: 'Run the retained Tangle interactive agent' },
      status: cancelled ? 'cancelled' : failed ? 'failed' : 'completed',
      reason,
      text: '',
      metadata: { model: prepared.model, tokensKnown: false, usdKnown: false },
      ...(failed ? { error: { kind: 'backend', message: outcome.message } } : {}),
      timestamp,
    },
  }
}

function interactiveCursor(
  runId: string,
  handle: RetainedInteractiveRunHandle,
  sequence: number,
): string {
  return `${runId}:interactive:${handle.ref.incarnationId}:${sequence}`
}
