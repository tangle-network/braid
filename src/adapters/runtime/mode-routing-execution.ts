import type { InteractionResponseCommand } from '@tangle-network/agent-interface'
import type {
  ExecuteTurnInput,
  ExecutionPort,
  NormalizedExecutionEvent,
  RetainedExecutionRecoveryContext,
  RunCapabilities,
} from '../../ports/execution.js'
import { UNKNOWN_RUN_CAPABILITIES } from '../../ports/execution.js'

type StatusInput = Parameters<NonNullable<ExecutionPort['status']>>[0]
type ReconnectInput = Parameters<NonNullable<ExecutionPort['reconnect']>>[0]
type ReconnectEvent =
  Awaited<ReturnType<NonNullable<ExecutionPort['reconnect']>>> extends AsyncIterable<infer Event>
    ? Event
    : never
type CancelInput = Parameters<NonNullable<ExecutionPort['cancelRun']>>[0]
type DetachInput = Parameters<NonNullable<ExecutionPort['detachRun']>>[0]
type SteerInput = Parameters<NonNullable<ExecutionPort['steerRun']>>[0]
type NativeBoundaryInput = Parameters<NonNullable<ExecutionPort['nativeBoundary']>>[0]

export interface ModeRoutingExecutionOptions {
  readonly headless: ExecutionPort
  readonly interactive: ExecutionPort
  /** Supplies durable mode state after Braid has restarted. */
  readonly isInteractiveRun?: (runId: string) => boolean
}

/** Routes one run by its explicit mode or canonical retained admission. */
export class ModeRoutingExecutionPort implements ExecutionPort {
  readonly #headless: ExecutionPort
  readonly #interactive: ExecutionPort
  readonly #isInteractiveRun: (runId: string) => boolean
  readonly #interactiveRuns = new Set<string>()
  readonly admissionMode: 'sync' | 'async'
  readonly capabilities: NonNullable<ExecutionPort['capabilities']>
  readonly environmentCapabilities?: NonNullable<ExecutionPort['environmentCapabilities']>
  readonly context?: NonNullable<ExecutionPort['context']>
  readonly contextTransfer?: NonNullable<ExecutionPort['contextTransfer']>
  readonly workspaceBranching?: NonNullable<ExecutionPort['workspaceBranching']>
  readonly workspaceBranchingProvider?: NonNullable<ExecutionPort['workspaceBranchingProvider']>
  readonly confidentialAttestationVerifier?: NonNullable<
    ExecutionPort['confidentialAttestationVerifier']
  >
  readonly provider?: string

  constructor(options: ModeRoutingExecutionOptions) {
    this.#headless = options.headless
    this.#interactive = options.interactive
    this.#isInteractiveRun = options.isInteractiveRun ?? (() => false)
    this.admissionMode =
      options.headless.admissionMode === 'async' || options.interactive.admissionMode === 'async'
        ? 'async'
        : 'sync'
    this.capabilities = this.#capabilities()
    if (options.headless.environmentCapabilities !== undefined) {
      this.environmentCapabilities = options.headless.environmentCapabilities.bind(options.headless)
    }
    const context = options.headless.context ?? options.interactive.context
    if (context !== undefined) this.context = context
    const contextTransfer = options.headless.contextTransfer ?? options.interactive.contextTransfer
    if (contextTransfer !== undefined) this.contextTransfer = contextTransfer
    const workspaceBranching =
      options.headless.workspaceBranching ?? options.interactive.workspaceBranching
    if (workspaceBranching !== undefined) this.workspaceBranching = workspaceBranching
    const workspaceBranchingProvider =
      options.headless.workspaceBranchingProvider ?? options.interactive.workspaceBranchingProvider
    if (workspaceBranchingProvider !== undefined)
      this.workspaceBranchingProvider = workspaceBranchingProvider
    const confidentialAttestationVerifier =
      options.headless.confidentialAttestationVerifier ??
      options.interactive.confidentialAttestationVerifier
    if (confidentialAttestationVerifier !== undefined)
      this.confidentialAttestationVerifier = confidentialAttestationVerifier
    const provider = options.headless.provider ?? options.interactive.provider
    if (provider !== undefined) this.provider = provider
  }

  async admit(input: ExecuteTurnInput) {
    const port = this.#portForInput(input)
    if (port.admit === undefined) {
      throw new Error('The selected execution port does not support admission')
    }
    const admission = await port.admit(input)
    if (this.#isInteractivePort(port)) this.#interactiveRuns.add(input.runId)
    return admission
  }

  async *streamTurn(input: ExecuteTurnInput): AsyncIterable<NormalizedExecutionEvent> {
    const port = this.#portForInput(input)
    yield* port.streamTurn(input)
  }

  async cancelRun(input: CancelInput) {
    const port = this.#portForInput(input)
    if (port.cancelRun === undefined) {
      throw new Error('The selected execution port does not support cancellation')
    }
    return port.cancelRun(input)
  }

  async detachRun(input: DetachInput) {
    const port = this.#portForInput(input)
    if (port.detachRun === undefined) {
      throw new Error('The selected execution port does not support detachment')
    }
    return port.detachRun(input)
  }

  async steerRun(input: SteerInput) {
    const port = this.#portForRun(input.runId)
    if (port.steerRun === undefined) {
      throw new Error('The selected execution port does not support steering')
    }
    return port.steerRun(input)
  }

  async status(input: StatusInput) {
    const port = this.#portForRecovery(input)
    if (port.status === undefined) {
      throw new Error('The selected execution port does not support status')
    }
    return port.status(input)
  }

  async respondInteraction(input: {
    readonly command: InteractionResponseCommand
    readonly signal?: AbortSignal
    readonly recovery?: RetainedExecutionRecoveryContext
  }) {
    const port = this.#portForInput({
      runId: input.command.binding.runId,
      ...(input.recovery?.retainedAdmission === undefined
        ? {}
        : { retainedAdmission: input.recovery.retainedAdmission }),
      ...(input.recovery?.receipt === undefined ? {} : { receipt: input.recovery.receipt }),
    })
    if (port.respondInteraction === undefined) {
      throw new Error('The selected execution port does not support interaction responses')
    }
    return port.respondInteraction(input)
  }

  async *reconnect(input: ReconnectInput): AsyncIterable<ReconnectEvent> {
    const port = this.#portForRecovery(input)
    if (port.reconnect === undefined) {
      throw new Error('The selected execution port does not support reconnection')
    }
    yield* port.reconnect(input)
  }

  async nativeBoundary(input: NativeBoundaryInput) {
    const port = this.#portForRun(input.runId)
    if (port.nativeBoundary === undefined) return null
    return port.nativeBoundary(input)
  }

  #capabilities(): NonNullable<ExecutionPort['capabilities']> {
    return ((input) => {
      const selected = this.#portForInput(input).capabilities
      if (selected === undefined) return UNKNOWN_RUN_CAPABILITIES
      if (typeof selected === 'function') return selected(input)
      return legacyCapabilities(selected)
    }) as (input: ExecuteTurnInput) => RunCapabilities | Promise<RunCapabilities>
  }

  #portForRecovery(input: StatusInput | ReconnectInput): ExecutionPort {
    const port = this.#portForInput(input)
    if (this.#isInteractivePort(port)) this.#interactiveRuns.add(input.runId)
    return port
  }

  #portForRun(runId: string, _controlRef?: unknown): ExecutionPort {
    const known = this.#interactiveRuns.has(runId) || this.#isInteractiveRun(runId)
    if (known) {
      this.#interactiveRuns.add(runId)
      return this.#interactive
    }
    return this.#headless
  }

  #portForInput(input: {
    readonly runId: string
    readonly mode?: string
    readonly retainedAdmission?: unknown
    readonly receipt?: { readonly requested?: { readonly mode?: string } }
  }): ExecutionPort {
    const admissionMode = retainedAdmissionMode(input.retainedAdmission)
    const receiptMode = input.receipt?.requested?.mode
    if (input.mode === 'interactive' && admissionMode === 'headless') {
      throw new Error('Interactive mode conflicts with a headless retained admission')
    }
    if (
      input.mode !== undefined &&
      input.mode !== 'interactive' &&
      admissionMode === 'interactive'
    ) {
      throw new Error('Headless mode conflicts with an interactive retained admission')
    }
    if (
      input.mode === 'interactive' ||
      admissionMode === 'interactive' ||
      receiptMode === 'interactive'
    ) {
      this.#interactiveRuns.add(input.runId)
      return this.#interactive
    }
    if (this.#interactiveRuns.has(input.runId) || this.#isInteractiveRun(input.runId)) {
      this.#interactiveRuns.add(input.runId)
      return this.#interactive
    }
    return this.#headless
  }

  #isInteractivePort(port: ExecutionPort): boolean {
    return port === this.#interactive
  }
}

function legacyCapabilities(capabilities: { readonly cancel: boolean }): RunCapabilities {
  return {
    ...UNKNOWN_RUN_CAPABILITIES,
    controls: { ...UNKNOWN_RUN_CAPABILITIES.controls, cancel: capabilities.cancel },
  }
}

function retainedAdmissionMode(value: unknown): 'interactive' | 'headless' | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const phase = (value as { readonly phase?: unknown }).phase
  if (typeof phase !== 'string') return undefined
  if (phase.startsWith('interactive_')) return 'interactive'
  if (phase === 'intent' || phase === 'environment' || phase === 'dispatched') return 'headless'
  return undefined
}
