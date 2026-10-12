import type { ConnectionRecord } from '../../domain/entities.js'
import { publicMaterializationReceipt } from '../../domain/materialization-receipt.js'
import { canonicalDigest } from '../../domain/canonical.js'
import { ConnectionRegistry, connectionExecutionDigest } from '../../app/connections.js'
import type { ExecuteTurnInput, ExecutionPort, NormalizedExecutionEvent, RetainedExecutionRecoveryContext } from '../../ports/execution.js'
import { UNKNOWN_RUN_CAPABILITIES } from '../../ports/execution.js'

type CancelInput = Parameters<NonNullable<ExecutionPort['cancelRun']>>[0]
type DetachInput = Parameters<NonNullable<ExecutionPort['detachRun']>>[0]
type StatusInput = Parameters<NonNullable<ExecutionPort['status']>>[0]
type ReconnectInput = Parameters<NonNullable<ExecutionPort['reconnect']>>[0]
type SteerInput = Parameters<NonNullable<ExecutionPort['steerRun']>>[0]
type ResponseInput = Parameters<NonNullable<ExecutionPort['respondInteraction']>>[0]
type BoundaryInput = Parameters<NonNullable<ExecutionPort['nativeBoundary']>>[0]
type Route = { readonly record: ConnectionRecord; readonly digest: string; readonly port: ExecutionPort }

/** Route by the saved connection, retaining each admitted run's original adapter. */
export class ConnectionRoutingExecutionPort implements ExecutionPort {
  readonly admissionMode = 'async'
  readonly context?: ExecutionPort['context']
  readonly workspaceBranchingProvider?: ExecutionPort['workspaceBranchingProvider']
  readonly confidentialAttestationVerifier?: ExecutionPort['confidentialAttestationVerifier']
  readonly #connections: ConnectionRegistry
  readonly #defaultConnectionId: string
  readonly #create: (record: ConnectionRecord) => ExecutionPort
  readonly #routes = new Map<string, Route>()
  readonly #runs = new Map<string, Route>()

  constructor(options: {
    readonly connections: ConnectionRegistry
    readonly defaultConnectionId: string
    readonly create: (record: ConnectionRecord) => ExecutionPort
    readonly context?: ExecutionPort['context']
    readonly confidentialAttestationVerifier?: ExecutionPort['confidentialAttestationVerifier']
  }) {
    this.#connections = options.connections
    this.#defaultConnectionId = options.defaultConnectionId
    this.#create = options.create
    if (options.context !== undefined) this.context = options.context
    const workspaceBranchingProvider: NonNullable<ExecutionPort['workspaceBranchingProvider']> = {
      forEnvironment: async (environmentId, operation) => {
        if (operation?.runId === undefined) throw new Error('Workspace lookup requires the source run identity')
        const port = this.#forRecovery({ ...operation, runId: operation.runId }).port
        const admission = operation.retainedAdmission
        const admittedEnvironment = operation.receipt?.environmentId ??
          operation.receipt?.requested.portableContextTransferReceipt?.environmentId ??
          (admission?.phase === 'environment' ? admission.environmentId : admission?.phase === 'dispatched' ? admission.controlRef.environmentId : undefined)
        if (admittedEnvironment !== undefined && admittedEnvironment !== environmentId) throw new Error('Workspace lookup belongs to another admitted environment')
        if (port.workspaceBranchingProvider !== undefined) {
          return port.workspaceBranchingProvider.forEnvironment(environmentId, operation.signal === undefined ? undefined : { signal: operation.signal })
        }
        return port.workspaceBranching ?? null
      },
    }
    this.workspaceBranchingProvider = Object.freeze(workspaceBranchingProvider)
    if (options.confidentialAttestationVerifier !== undefined) this.confidentialAttestationVerifier = options.confidentialAttestationVerifier
  }

  capabilities: NonNullable<ExecutionPort['capabilities']> = (input: ExecuteTurnInput) => {
    const capabilities = this.#forTurn(input).port.capabilities
    if (typeof capabilities === 'function') return capabilities(input)
    return capabilities === undefined ? UNKNOWN_RUN_CAPABILITIES : { ...UNKNOWN_RUN_CAPABILITIES, controls: { ...UNKNOWN_RUN_CAPABILITIES.controls, cancel: capabilities.cancel } }
  }

  async admit(input: ExecuteTurnInput) {
    const route = this.#forTurn(input)
    if (route.port.admit === undefined) throw new Error('The selected connection does not support admission')
    const admission = await route.port.admit(input)
    const materializationReceipt = publicMaterializationReceipt({ ...admission.materializationReceipt, connectionId: route.record.id, connectionDigest: route.digest })
    return { ...admission, materializationReceipt, materializationDigest: canonicalDigest(materializationReceipt) }
  }

  async *streamTurn(input: ExecuteTurnInput): AsyncIterable<NormalizedExecutionEvent> {
    yield* this.#forTurn(input).port.streamTurn(input)
  }

  async cancelRun(input: CancelInput) {
    const port = this.#forRecovery(input).port
    if (port.cancelRun === undefined) throw new Error('The selected connection does not support cancellation')
    return port.cancelRun(input)
  }

  async detachRun(input: DetachInput) {
    const port = this.#forRecovery(input).port
    if (port.detachRun === undefined) throw new Error('The selected connection does not support detachment')
    return port.detachRun(input)
  }

  async steerRun(input: SteerInput) {
    const port = this.#forRecovery(input).port
    if (port.steerRun === undefined) throw new Error('The selected connection does not support steering')
    return port.steerRun(input)
  }

  async status(input: StatusInput) {
    const port = this.#forRecovery(input).port
    if (port.status === undefined) throw new Error('The selected connection does not support status')
    return port.status(input)
  }

  async respondInteraction(input: ResponseInput) {
    const port = this.#forRecovery({ runId: input.command.binding.runId, ...input.recovery }).port
    if (port.respondInteraction === undefined) throw new Error('The selected connection does not support interaction responses')
    return port.respondInteraction(input)
  }

  async *reconnect(input: ReconnectInput) {
    const port = this.#forRecovery(input).port
    if (port.reconnect === undefined) throw new Error('The selected connection does not support reconnection')
    yield* port.reconnect(input)
  }

  async nativeBoundary(input: BoundaryInput) {
    const port = this.#forRecovery(input).port
    return port.nativeBoundary === undefined ? null : port.nativeBoundary(input)
  }

  #forTurn(input: ExecuteTurnInput): Route {
    const known = this.#runs.get(input.runId)
    if (known !== undefined) {
      if (input.connectionId !== undefined && input.connectionId !== known.record.id) throw new Error('The run is already bound to another connection')
      return known
    }
    const route = this.#forConnection(input.connectionId ?? this.#defaultConnectionId)
    this.#runs.set(input.runId, route)
    return route
  }

  #forRecovery(input: { readonly runId: string } & RetainedExecutionRecoveryContext): Route {
    if (input.receipt !== undefined && input.receipt.runId !== input.runId) throw new Error('The recovery receipt belongs to another run')
    const connectionId = input.receipt?.requested.connectionId
    const known = this.#runs.get(input.runId)
    if (known !== undefined) {
      if (connectionId !== undefined && connectionId !== known.record.id) throw new Error('The recovery receipt belongs to another connection')
      const digest = input.receipt?.materializationReceipt?.connectionDigest
      if (digest !== undefined && digest !== known.digest) throw new Error('The recovery receipt belongs to another connection revision')
      return known
    }
    if (connectionId === undefined) throw new Error('Recovery requires the admitted connection identity')
    const route = this.#forConnection(connectionId)
    const digest = input.receipt?.materializationReceipt?.connectionDigest
    if (digest !== undefined && digest !== route.digest) throw new Error('The admitted connection changed; restore its saved configuration before recovery')
    this.#runs.set(input.runId, route)
    return route
  }

  #forConnection(connectionId: string): Route {
    const record = this.#connections.select({ connectionId }).record
    const digest = connectionExecutionDigest(record)
    let route = this.#routes.get(digest)
    if (route === undefined) {
      route = { record, digest, port: this.#create(record) }
      this.#routes.set(digest, route)
    }
    return route
  }
}
