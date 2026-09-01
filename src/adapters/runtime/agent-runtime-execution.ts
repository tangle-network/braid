import type {
  AgentWorkspaceBranchingProvider,
  ConfidentialAttestationVerifier,
} from '@tangle-network/agent-interface'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import type { AgentTurnBackend, Executor } from '@tangle-network/agent-runtime/kernel'
import { canonicalDigest } from '../../domain/canonical.js'
import { publicMaterializationReceipt } from '../../domain/materialization-receipt.js'
import {
  redactSensitiveText,
  redactStructuredValueWithNumericTelemetry,
} from '../../domain/redaction.js'
import {
  BRAID_SANDBOX_CLEANUP_UNCONFIRMED,
  BRAID_SANDBOX_INTERACTION_UNSUPPORTED,
} from '../../domain/runtime-diagnostics.js'
import type { BraidRuntimeEvent } from '../../domain/runtime-events.js'
import type {
  CancelRunInput,
  CancelRunResult,
  ControlAcknowledgement,
  ExecuteTurnInput,
  ExecutionAdmission,
  ExecutionPort,
} from '../../ports/execution.js'
import {
  capabilitiesFromEnvironment,
  DEFAULT_RUN_CAPABILITIES,
  type RunCapabilities,
  UNKNOWN_RUN_CAPABILITIES,
} from '../../ports/execution.js'
import { canonicalAgentProfileDigestHex } from '../agent-interface/profile-runtime.js'
import {
  type ExecutionResolution,
  isPreparedExecution,
  type PreparedExecution,
  type RuntimeCancellationCapability,
} from './prepared-execution.js'

export type AgentTurnBackendResolver = (
  input: ExecuteTurnInput,
) => ExecutionResolution | Promise<ExecutionResolution>

export type AgentTurnCancelResolver = (
  input: CancelRunInput & { readonly signal?: AbortSignal },
) => CancelRunResult | Promise<CancelRunResult>

export interface AgentRuntimeExecutionOptions {
  readonly admissionMode?: 'sync' | 'async'
  readonly workspaceBranchingProvider?: AgentWorkspaceBranchingProvider
  readonly confidentialAttestationVerifier?: ConfidentialAttestationVerifier
}

export class AgentRuntimeExecutionPort implements ExecutionPort {
  readonly admissionMode: 'sync' | 'async'
  readonly #resolveBackend: AgentTurnBackendResolver
  readonly #cancel: AgentTurnCancelResolver | undefined
  readonly #active = new Map<string, ActiveExecution>()
  readonly #prepared = new Map<
    string,
    { readonly key: string; readonly execution: ExecutionResolution }
  >()
  readonly #preparedOrder: string[] = []
  readonly #capabilitySnapshot: RunCapabilities
  readonly workspaceBranchingProvider?: AgentWorkspaceBranchingProvider
  readonly confidentialAttestationVerifier?: ConfidentialAttestationVerifier

  static readonly #MAX_PREPARED = 128

  constructor(
    resolveBackend: AgentTurnBackendResolver,
    cancelOrCapabilities?: AgentTurnCancelResolver | RunCapabilities,
    options: AgentRuntimeExecutionOptions = {},
  ) {
    this.#resolveBackend = resolveBackend
    this.admissionMode = options.admissionMode ?? 'async'
    if (typeof cancelOrCapabilities === 'function') {
      this.#cancel = cancelOrCapabilities
      this.#capabilitySnapshot = {
        ...DEFAULT_RUN_CAPABILITIES,
        controls: { ...DEFAULT_RUN_CAPABILITIES.controls, cancel: true },
      }
    } else {
      this.#capabilitySnapshot = cancelOrCapabilities ?? {
        ...UNKNOWN_RUN_CAPABILITIES,
        streaming: { ...UNKNOWN_RUN_CAPABILITIES.streaming, live: true },
      }
    }
    if (options.workspaceBranchingProvider !== undefined)
      this.workspaceBranchingProvider = options.workspaceBranchingProvider
    if (options.confidentialAttestationVerifier !== undefined)
      this.confidentialAttestationVerifier = options.confidentialAttestationVerifier
  }

  capabilities(): RunCapabilities {
    return this.#capabilitySnapshot
  }

  admit(input: ExecuteTurnInput): ExecutionAdmission | Promise<ExecutionAdmission> {
    const backend = this.#resolveBackend(input)
    if (isPromiseLike(backend))
      return backend.then((resolved) => this.#prepareAdmission(input, resolved))
    return this.#prepareAdmission(input, backend)
  }

  #prepareAdmission(input: ExecuteTurnInput, execution: ExecutionResolution): ExecutionAdmission {
    const profileDigest = canonicalAgentProfileDigestHex(input.profile)
    const prepared = isPreparedExecution(execution)
    const providerSessionId = prepared ? execution.providerSessionId : undefined
    const capabilities =
      prepared && execution.capabilities !== undefined
        ? capabilitiesFromEnvironment(execution.capabilities, execution.cancellation !== undefined)
        : this.#capabilitySnapshot
    const materializationReceipt = publicMaterializationReceipt(
      prepared
        ? execution.materializationReceipt
        : { backendKind: execution.kind, provider: 'agent-runtime' },
    )
    const provider =
      typeof materializationReceipt.provider === 'string'
        ? materializationReceipt.provider
        : 'agent-runtime'
    if (prepared && execution.cancellation !== undefined && !this.#active.has(input.runId)) {
      this.#active.set(input.runId, {
        localAbort: new AbortController(),
        cancellation: execution.cancellation,
      })
    }
    this.#rememberPrepared(input.runId, {
      key: admissionKey(input, profileDigest),
      execution,
    })
    return {
      capabilities,
      provider,
      ...(prepared && execution.environmentId !== undefined
        ? { environmentId: execution.environmentId }
        : {}),
      ...(providerSessionId === undefined ? {} : { providerSessionId }),
      materializationReceipt,
      profileDigest,
      capabilitiesDigest: canonicalDigest(capabilities),
      materializationDigest: canonicalDigest(materializationReceipt),
    }
  }

  async cancelRun(
    input: CancelRunInput & { readonly signal?: AbortSignal },
  ): Promise<ControlAcknowledgement> {
    if (this.#cancel) {
      const result = await this.#cancel({
        runId: input.runId,
        operationId: input.operationId,
        reason: input.reason ?? 'Cancelled by user',
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      return result.status === 'cancelled'
        ? { operationId: input.operationId, outcome: 'accepted' }
        : { operationId: input.operationId, outcome: 'unknown', detail: result.reason }
    }
    const active = this.#active.get(input.runId)
    if (!active)
      return {
        operationId: input.operationId,
        outcome: 'unknown',
        detail: 'The provider did not acknowledge cancellation',
      }
    if (active.cancellation?.kind !== 'runtime-executor-teardown') {
      active.localAbort.abort(new Error(input.reason ?? 'Cancelled by user'))
      return {
        operationId: input.operationId,
        outcome: 'unknown',
        detail: 'Provider cancellation is unsupported; only the local iterator was stopped',
      }
    }
    if (active.executor === undefined) {
      active.localAbort.abort(new Error(input.reason ?? 'Cancelled by user'))
      return {
        operationId: input.operationId,
        outcome: 'unknown',
        detail: 'Runtime did not create an executor before cancellation was requested',
      }
    }

    const acknowledgement = await cancelRuntimeExecutor(active.executor, input.operationId)
    if (acknowledgement.outcome === 'accepted' || acknowledgement.outcome === 'already-applied') {
      active.localAbort.abort(new Error(input.reason ?? 'Cancelled by user'))
    } else if (acknowledgement.outcome === 'unknown') {
      active.localAbort.abort(new Error(input.reason ?? 'Cancellation outcome is unknown'))
    }
    return acknowledgement
  }

  async *streamTurn(input: ExecuteTurnInput): AsyncGenerator<BraidRuntimeEvent> {
    const existing = this.#active.get(input.runId)
    const localAbort = existing?.localAbort ?? new AbortController()
    const stop = () => localAbort.abort(input.signal.reason)
    if (input.signal.aborted) stop()
    else input.signal.addEventListener('abort', stop, { once: true })
    const active = existing ?? { localAbort }
    if (existing === undefined) this.#active.set(input.runId, active)
    try {
      localAbort.signal.throwIfAborted()
      const profileDigest = canonicalAgentProfileDigestHex(input.profile)
      const prepared = this.#prepared.get(input.runId)
      const execution =
        prepared?.key === admissionKey(input, profileDigest)
          ? prepared.execution
          : await this.#resolveBackend(input)
      this.#forgetPrepared(input.runId)
      const preparedExecution = isPreparedExecution(execution) ? execution : undefined
      active.cancellation = preparedExecution?.cancellation
      const backend = isPreparedExecution(execution) ? execution.backend : execution
      const observation = isPreparedExecution(execution) ? execution.observation : undefined
      const cleanupExpected =
        preparedExecution?.materializationReceipt.cleanup === 'delete-after-turn'
      const runtimeBackend =
        active.cancellation === undefined
          ? backend
          : captureExecutor(backend, (executor) => {
              active.executor = executor
            })
      const { streamAgentTurn } = await import('@tangle-network/agent-runtime/kernel')
      try {
        let terminal: Extract<RuntimeStreamEvent, { readonly type: 'final' }> | undefined
        for await (const event of streamAgentTurn(
          runtimeBackend,
          {
            prompt: input.text,
            ...(input.contextTransfer === undefined
              ? {}
              : { contextTransfer: input.contextTransfer }),
          },
          {
            signal: localAbort.signal,
            preserveToolParts: true,
          },
        )) {
          if (event.type === 'final') terminal = event
          else yield event
        }
        const observed = observation === undefined ? undefined : await observationEvent(observation)
        if (observed !== undefined) yield observed
        if (terminal !== undefined) {
          yield redactedTerminal(
            terminalAfterCleanup(
              terminalAfterInteractionRequest(terminal),
              observed,
              cleanupExpected,
            ),
          )
        }
      } catch (error) {
        if (observation !== undefined) {
          const observed = await observationEvent(observation)
          if (observed !== undefined) yield observed
        }
        throw error
      }
    } finally {
      input.signal.removeEventListener('abort', stop)
      this.#active.delete(input.runId)
    }
  }

  #rememberPrepared(
    runId: string,
    binding: { readonly key: string; readonly execution: ExecutionResolution },
  ): void {
    if (!this.#prepared.has(runId)) this.#preparedOrder.push(runId)
    this.#prepared.set(runId, binding)
    while (this.#preparedOrder.length > AgentRuntimeExecutionPort.#MAX_PREPARED) {
      const expired = this.#preparedOrder.shift()
      if (expired !== undefined) this.#prepared.delete(expired)
    }
  }

  #forgetPrepared(runId: string): void {
    this.#prepared.delete(runId)
    const index = this.#preparedOrder.indexOf(runId)
    if (index >= 0) this.#preparedOrder.splice(index, 1)
  }
}

/**
 * Remove provider secrets from runtime failure text at Braid's boundary.
 *
 * The runtime fails a sandbox turn inside its executor and reports the
 * provider's own message, which can carry a credential. Every consumer of this
 * event, not only the journal, must see the redacted text.
 */
function redactedTerminal(
  terminal: Extract<RuntimeStreamEvent, { readonly type: 'final' }>,
): Extract<RuntimeStreamEvent, { readonly type: 'final' }> {
  const reason = terminal.reason === undefined ? undefined : redactSensitiveText(terminal.reason)
  const message =
    terminal.error?.message === undefined ? undefined : redactSensitiveText(terminal.error.message)
  // The runtime carries the provider's own terminal payload, including its raw
  // events, so the metadata takes the same structured rules that guard every
  // other provider value Braid keeps.
  const metadata =
    terminal.metadata === undefined
      ? undefined
      : (redactStructuredValueWithNumericTelemetry(terminal.metadata, undefined, {
          maxDepth: 8,
          maxItems: 256,
          maxBytes: 64 * 1024,
        }) as Record<string, unknown>)
  return {
    ...terminal,
    ...(reason === undefined ? {} : { reason }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(terminal.error === undefined || message === undefined
      ? {}
      : { error: { ...terminal.error, message } }),
  }
}

/**
 * Refuse a turn that ends waiting for a user response on this route.
 *
 * Runtime reports a blocked turn when the agent asks for a permission, a
 * question, or a plan decision. This route deletes its environment after the
 * turn, so no response can reach the agent and the run fails closed.
 */
function terminalAfterInteractionRequest(
  terminal: Extract<RuntimeStreamEvent, { readonly type: 'final' }>,
): Extract<RuntimeStreamEvent, { readonly type: 'final' }> {
  if (terminal.status !== 'blocked') return terminal
  return {
    ...terminal,
    status: 'failed',
    reason: BRAID_SANDBOX_INTERACTION_UNSUPPORTED,
    error: { kind: 'backend', message: BRAID_SANDBOX_INTERACTION_UNSUPPORTED },
  }
}

function terminalAfterCleanup(
  terminal: Extract<RuntimeStreamEvent, { readonly type: 'final' }>,
  observed: Extract<BraidRuntimeEvent, { readonly type: 'braid.execution.observed' }> | undefined,
  cleanupExpected: boolean,
): Extract<RuntimeStreamEvent, { readonly type: 'final' }> {
  const cleanupRequired = cleanupExpected || observed?.observation.cleanup === 'delete-after-turn'
  if (
    terminal.status !== 'completed' ||
    !cleanupRequired ||
    (observed?.observation.cleanup === 'delete-after-turn' &&
      observed.observation.lifecycle === 'destroyed')
  )
    return terminal
  return {
    ...terminal,
    status: 'failed',
    reason: BRAID_SANDBOX_CLEANUP_UNCONFIRMED,
    error: {
      kind: 'backend',
      message: BRAID_SANDBOX_CLEANUP_UNCONFIRMED,
    },
  }
}

interface ActiveExecution {
  readonly localAbort: AbortController
  cancellation?: RuntimeCancellationCapability | undefined
  executor?: Executor<unknown>
}

function captureExecutor(
  backend: AgentTurnBackend,
  onExecutor: (executor: Executor<unknown>) => void,
): AgentTurnBackend {
  return {
    ...backend,
    factory: (spec, context) => {
      const executor = backend.factory(spec, context)
      onExecutor(executor)
      return executor
    },
  }
}

async function cancelRuntimeExecutor(
  executor: Executor<unknown>,
  operationId: string,
): Promise<ControlAcknowledgement> {
  return Promise.resolve()
    .then(() => executor.teardown('infinity'))
    .then(({ destroyed }) =>
      destroyed
        ? {
            operationId,
            outcome: 'accepted' as const,
            detail: 'Provider cancellation acknowledged',
          }
        : {
            operationId,
            outcome: 'unknown' as const,
            detail: 'Runtime did not confirm executor teardown; provider state is unknown',
          },
    )
    .catch(() => ({
      operationId,
      outcome: 'unknown' as const,
      detail: 'Provider cancellation failed before acknowledgement',
    }))
}

async function observationEvent(
  source: NonNullable<PreparedExecution['observation']>,
): Promise<Extract<BraidRuntimeEvent, { readonly type: 'braid.execution.observed' }> | undefined> {
  try {
    const observation = await source.snapshot()
    return observation === undefined
      ? undefined
      : { type: 'braid.execution.observed', observation, timestamp: observation.observedAt }
  } catch {
    return undefined
  }
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === 'object' && value !== null && 'then' in value
}

function admissionKey(input: ExecuteTurnInput, profileDigest: string): string {
  return canonicalDigest({
    operationId: input.operationId,
    runId: input.runId,
    text: input.text,
    profileDigest,
    connectionId: input.connectionId ?? null,
    mode: input.mode ?? null,
    workspaceRequest: input.workspaceRequest ?? null,
    workspaceRoot: input.workspaceRoot ?? null,
    sessionId: input.sessionId ?? null,
    contextBoundary: input.contextBoundary ?? null,
    contextTransfer: input.contextTransfer ?? null,
  })
}
