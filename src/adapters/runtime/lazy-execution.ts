import type {
  AgentEnvironmentCapabilities,
  NativeContextBoundaryProof,
} from '@tangle-network/agent-interface'
import type { BraidRuntimeEvent, RuntimeEventEnvelope } from '../../domain/runtime-events.js'
import {
  type CancelRunInput,
  type ControlAcknowledgement,
  type ExecuteTurnInput,
  type ExecutionAdmission,
  type ExecutionPort,
  type ProviderRunSnapshot,
  type RetainedExecutionRecoveryContext,
  type RunCapabilities,
  UNKNOWN_RUN_CAPABILITIES,
} from '../../ports/execution.js'

type StatusInput = Parameters<NonNullable<ExecutionPort['status']>>[0]
type ReconnectInput = Parameters<NonNullable<ExecutionPort['reconnect']>>[0]
type ReconnectEvent =
  Awaited<ReturnType<NonNullable<ExecutionPort['reconnect']>>> extends AsyncIterable<infer Event>
    ? Event
    : never
type DetachInput = Parameters<NonNullable<ExecutionPort['detachRun']>>[0]
type SteerInput = Parameters<NonNullable<ExecutionPort['steerRun']>>[0]
type NativeBoundaryInput = Parameters<NonNullable<ExecutionPort['nativeBoundary']>>[0]

export interface LazyExecutionOptions {
  readonly load: () => Promise<ExecutionPort>
}

/**
 * Defers provider construction until a run needs it.
 *
 * Terminal startup can restore local state without loading provider packages.
 * The first provider operation still uses the exact production port.
 */
export class LazyExecutionPort implements ExecutionPort {
  readonly admissionMode = 'async' as const
  readonly #loadPort: () => Promise<ExecutionPort>
  #portPromise: Promise<ExecutionPort> | undefined
  #loadedPort: ExecutionPort | undefined

  constructor(options: LazyExecutionOptions) {
    this.#loadPort = options.load
  }

  readonly capabilities = (input: ExecuteTurnInput): RunCapabilities | Promise<RunCapabilities> =>
    this.#load().then((port) => {
      const capabilities = port.capabilities
      if (capabilities === undefined) return UNKNOWN_RUN_CAPABILITIES
      if (typeof capabilities === 'function') return capabilities(input)
      return {
        ...UNKNOWN_RUN_CAPABILITIES,
        controls: { ...UNKNOWN_RUN_CAPABILITIES.controls, cancel: capabilities.cancel },
      }
    })

  async admit(input: ExecuteTurnInput): Promise<ExecutionAdmission> {
    const port = await this.#load()
    if (port.admit === undefined)
      throw new Error('The selected execution port does not support admission')
    return port.admit(input)
  }

  async *streamTurn(
    input: ExecuteTurnInput,
  ): AsyncGenerator<BraidRuntimeEvent | RuntimeEventEnvelope> {
    const port = await this.#load()
    yield* port.streamTurn(input)
  }

  async cancelRun(
    input: CancelRunInput & { readonly reason?: string; readonly signal?: AbortSignal },
  ): Promise<ControlAcknowledgement | import('../../ports/execution.js').CancelRunResult> {
    const port = await this.#load()
    if (port.cancelRun === undefined)
      throw new Error('The selected execution port does not support cancellation')
    return port.cancelRun(input)
  }

  async detachRun(input: DetachInput): Promise<ControlAcknowledgement> {
    const port = await this.#load()
    if (port.detachRun === undefined)
      throw new Error('The selected execution port does not support detachment')
    return port.detachRun(input)
  }

  async steerRun(input: SteerInput): Promise<ControlAcknowledgement> {
    const port = await this.#load()
    if (port.steerRun === undefined)
      throw new Error('The selected execution port does not support steering')
    return port.steerRun(input)
  }

  async status(input: StatusInput): Promise<ProviderRunSnapshot | null> {
    const port = await this.#load()
    if (port.status === undefined)
      throw new Error('The selected execution port does not support status')
    return port.status(input)
  }

  async respondInteraction(input: {
    readonly command: import('@tangle-network/agent-interface').InteractionResponseCommand
    readonly signal?: AbortSignal
    readonly recovery?: RetainedExecutionRecoveryContext
  }): Promise<ControlAcknowledgement> {
    const port = await this.#load()
    if (port.respondInteraction === undefined)
      throw new Error('The selected execution port does not support interaction responses')
    return port.respondInteraction(input)
  }

  async *reconnect(input: ReconnectInput): AsyncGenerator<ReconnectEvent> {
    const port = await this.#load()
    if (port.reconnect === undefined)
      throw new Error('The selected execution port does not support reconnection')
    yield* port.reconnect(input)
  }

  async nativeBoundary(input: NativeBoundaryInput): Promise<NativeContextBoundaryProof | null> {
    const port = await this.#load()
    if (port.nativeBoundary === undefined) return null
    return port.nativeBoundary(input)
  }

  async environmentCapabilities(): Promise<AgentEnvironmentCapabilities> {
    const port = await this.#load()
    if (port.environmentCapabilities === undefined)
      throw new Error('The selected execution port does not publish environment capabilities')
    return port.environmentCapabilities()
  }

  get context(): ExecutionPort['context'] {
    return this.#loadedPort?.context
  }

  get contextTransfer(): ExecutionPort['contextTransfer'] {
    return this.#loadedPort?.contextTransfer
  }

  get workspaceBranching(): ExecutionPort['workspaceBranching'] {
    return this.#loadedPort?.workspaceBranching
  }

  get workspaceBranchingProvider(): ExecutionPort['workspaceBranchingProvider'] {
    return this.#loadedPort?.workspaceBranchingProvider
  }

  get confidentialAttestationVerifier(): ExecutionPort['confidentialAttestationVerifier'] {
    return this.#loadedPort?.confidentialAttestationVerifier
  }

  get provider(): ExecutionPort['provider'] {
    return this.#loadedPort?.provider
  }

  #load(): Promise<ExecutionPort> {
    this.#portPromise ??= this.#loadPort().then((port) => {
      this.#loadedPort = port
      return port
    })
    return this.#portPromise
  }
}
