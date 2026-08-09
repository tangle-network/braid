import { snapshotAgentProfile } from '@tangle-network/agent-interface'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import type { AgentTurnBackend } from '@tangle-network/agent-runtime/kernel'
import type { SandboxInstance } from '@tangle-network/sandbox'
import { canonicalDigest } from '../../domain/canonical.js'
import { redactProfile } from '../../domain/redaction.js'
import type {
  CancelRunInput,
  CancelRunResult,
  ControlAcknowledgement,
  ExecuteTurnInput,
  ExecutionAdmission,
  ExecutionPort,
} from '../../ports/execution.js'
import {
  DEFAULT_RUN_CAPABILITIES,
  capabilitiesFromEnvironment,
  type RunCapabilities,
  UNKNOWN_RUN_CAPABILITIES,
} from '../../ports/execution.js'
import { isPreparedSandboxExecution, type PreparedExecution } from './prepared-execution.js'

export type AgentTurnBackendResolver = (
  input: ExecuteTurnInput,
) => PreparedExecution | Promise<PreparedExecution>

export type AgentTurnCancelResolver = (
  input: CancelRunInput,
) => CancelRunResult | Promise<CancelRunResult>

export interface AgentRuntimeExecutionOptions {
  readonly admissionMode?: 'sync' | 'async'
}

export class AgentRuntimeExecutionPort implements ExecutionPort {
  readonly admissionMode: 'sync' | 'async'
  readonly #resolveBackend: AgentTurnBackendResolver
  readonly #cancel: AgentTurnCancelResolver | undefined
  readonly #active = new Map<string, AbortController>()
  readonly #prepared = new Map<
    string,
    { readonly key: string; readonly execution: PreparedExecution }
  >()
  readonly #preparedOrder: string[] = []
  readonly #capabilitySnapshot: RunCapabilities

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

  #prepareAdmission(input: ExecuteTurnInput, execution: PreparedExecution): ExecutionAdmission {
    const profileDigest = canonicalDigest(redactProfile(snapshotAgentProfile(input.profile)))
    const prepared = isPreparedSandboxExecution(execution)
    const providerSessionId = prepared ? execution.providerSessionId : undefined
    const capabilities = prepared
      ? capabilitiesFromEnvironment(execution.capabilities)
      : this.#capabilitySnapshot
    const materializationReceipt = prepared
      ? execution.materializationReceipt
      : { backendKind: execution.kind, provider: 'agent-runtime' }
    this.#rememberPrepared(input.runId, {
      key: admissionKey(input, profileDigest),
      execution,
    })
    return {
      capabilities,
      provider: 'agent-runtime',
      ...(prepared ? { environmentId: execution.environmentId } : {}),
      ...(providerSessionId === undefined ? {} : { providerSessionId }),
      materializationReceipt,
      profileDigest,
      capabilitiesDigest: canonicalDigest(capabilities),
      materializationDigest: canonicalDigest(materializationReceipt),
    }
  }

  async cancelRun(input: {
    readonly runId: string
    readonly operationId: string
    readonly reason?: string
  }): Promise<ControlAcknowledgement> {
    if (this.#cancel) {
      const result = await this.#cancel({
        runId: input.runId,
        operationId: input.operationId,
        reason: input.reason ?? 'Cancelled by user',
      })
      return result.status === 'cancelled'
        ? { operationId: input.operationId, outcome: 'accepted' }
        : { operationId: input.operationId, outcome: 'unknown', detail: result.reason }
    }
    const controller = this.#active.get(input.runId)
    if (!controller)
      return {
        operationId: input.operationId,
        outcome: 'unknown',
        detail: 'The provider did not acknowledge cancellation',
      }
    controller.abort(new Error('Cancelled by user'))
    return {
      operationId: input.operationId,
      outcome: 'unknown',
      detail: 'Local abort occurred without provider acknowledgement',
    }
  }

  async respondInteraction(input: {
    readonly command: import('@tangle-network/agent-interface').InteractionResponseCommand
    readonly signal?: AbortSignal
  }): Promise<ControlAcknowledgement> {
    // agent-runtime 0.128 owns the live session but exposes no interaction
    // response operation. Keep this capability explicitly unknown until the
    // shared runtime contract provides one; never emulate it with a local
    // abort or a provider-private call.
    void input.command.binding.runId
    void input.command.response
    void input.signal
    return {
      operationId: input.command.operationId,
      outcome: 'unknown',
      detail: 'The current agent-runtime release has no response channel',
    }
  }

  async *streamTurn(input: ExecuteTurnInput): AsyncGenerator<RuntimeStreamEvent> {
    const localAbort = new AbortController()
    const stop = () => localAbort.abort(input.signal.reason)
    if (input.signal.aborted) stop()
    else input.signal.addEventListener('abort', stop, { once: true })
    this.#active.set(input.runId, localAbort)
    let ownedBox: SandboxInstance | undefined
    try {
      localAbort.signal.throwIfAborted()
      const profileDigest = canonicalDigest(redactProfile(snapshotAgentProfile(input.profile)))
      const prepared = this.#prepared.get(input.runId)
      const execution =
        prepared?.key === admissionKey(input, profileDigest)
          ? prepared.execution
          : await this.#resolveBackend(input)
      this.#forgetPrepared(input.runId)
      const materialized = await materializeExecution(execution)
      ownedBox = materialized.ownedBox
      const { streamAgentTurn } = await import('@tangle-network/agent-runtime/kernel')
      let terminal: Extract<RuntimeStreamEvent, { readonly type: 'final' }> | undefined
      for await (const event of streamAgentTurn(materialized.backend, input.text, {
        signal: localAbort.signal,
        preserveToolParts: true,
      })) {
        if (event.type === 'final') terminal = event
        else yield event
      }
      const cleanupError = ownedBox === undefined ? undefined : await deleteBox(ownedBox)
      ownedBox = undefined
      if (cleanupError !== undefined) {
        if (terminal === undefined) throw cleanupError
        const failedTerminal: Extract<RuntimeStreamEvent, { readonly type: 'final' }> = {
          ...terminal,
          status: 'failed',
          reason: 'Sandbox deletion was not acknowledged after retry; resource state is unknown',
          error: { kind: 'backend', message: cleanupError.message },
        }
        yield failedTerminal
      } else if (terminal !== undefined) {
        yield terminal
      }
    } catch (error) {
      if (ownedBox !== undefined) {
        const cleanupError = await deleteBox(ownedBox)
        ownedBox = undefined
        if (cleanupError !== undefined) {
          throw new AggregateError(
            [error, cleanupError],
            'Agent execution failed and sandbox deletion was not acknowledged',
          )
        }
      }
      throw error
    } finally {
      if (ownedBox !== undefined) {
        // Consumer-driven stream closure has no remaining event channel.
        // Cleanup is still attempted, but it must not replace the caller's return.
        await deleteBox(ownedBox)
        ownedBox = undefined
      }
      input.signal.removeEventListener('abort', stop)
      this.#active.delete(input.runId)
    }
  }

  #rememberPrepared(
    runId: string,
    binding: { readonly key: string; readonly execution: PreparedExecution },
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

async function materializeExecution(execution: PreparedExecution): Promise<{
  readonly backend: AgentTurnBackend
  readonly ownedBox?: SandboxInstance
}> {
  if (!isPreparedSandboxExecution(execution)) return { backend: execution }
  const box = await execution.client.create()
  return {
    backend: {
      kind: 'box',
      box,
      options: execution.turnOptions,
      agentRunName: execution.agentRunName,
    },
    ...(execution.lifecycle.cleanup === 'delete-after-turn' ? { ownedBox: box } : {}),
  }
}

async function deleteBox(box: SandboxInstance): Promise<Error | undefined> {
  let failure: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await box.delete()
      return undefined
    } catch (error) {
      failure = error
    }
  }
  return new Error(
    'Sandbox deletion was not acknowledged after retry; resource state is unknown',
    failure === undefined ? undefined : { cause: failure },
  )
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
    sessionId: input.sessionId ?? null,
    contextBoundary: input.contextBoundary ?? null,
  })
}
